/**
 * 飞书多维表格同步 — 前端交互
 * 依赖: ApiClient (js/api.js), showNotification (全局)
 * 注意: 不用 alert/confirm(Electron 同步弹窗破坏键盘焦点)
 *
 * 设计参考: .trae/documents/feishu-bidirectional-sync.md
 */
(function () {
    'use strict';

    const FeishuSync = {
        _feishuFields: [],
        _feishuTables: [],
        _mappings: [],

        async init() {
            // 等 ApiClient 探测完成
            if (typeof ApiClient === 'undefined') return;
            await ApiClient.ready();
            if (!ApiClient.csMode) {
                // 单机模式: 显示提示
                const hint = document.getElementById('feishu-mode-hint');
                if (hint) hint.style.display = 'block';
                return;
            }
            // 等 token 就绪（init.js 会在 csMode 但未登录时跳转 login.html）
            if (!ApiClient.isLoggedIn()) return;
            const card = document.getElementById('feishu-sync-card');
            if (card) card.style.display = 'block';
            await this.loadConfig();
            this.bindEvents();
            // 已配置 appToken 时先拉数据表列表(自动选中已保存的表), 再加载该表字段
            const appTokenInput = document.getElementById('fs-app-token');
            if (appTokenInput && appTokenInput.value.trim()) {
                await this.loadTables();
                if (document.getElementById('fs-table-id').value.trim()) {
                    this.loadFields();
                }
            }
        },

        async loadConfig() {
            try {
                const cfg = await ApiClient.request('GET', '/api/feishu/config');
                if (cfg.appId) document.getElementById('fs-app-id').value = cfg.appId;
                if (cfg.appSecret) document.getElementById('fs-app-secret').value = cfg.appSecret;
                if (cfg.appToken) document.getElementById('fs-app-token').value = cfg.appToken;
                if (cfg.tableId) document.getElementById('fs-table-id').value = cfg.tableId;
                if (cfg.fieldMappings && cfg.fieldMappings.length) {
                    this._mappings = cfg.fieldMappings;
                    // 补齐未出现在保存配置里的本地字段(显示"不映射"), 让表格始终展示全部本地字段
                    for (const localField of Object.keys(this.LOCAL_FIELD_LABELS)) {
                        if (!this._mappings.find(m => m.localField === localField)) {
                            this._mappings.push({
                                localField, feishuField: '',
                                type: this.LOCAL_FIELD_TYPES[localField] || 'text'
                            });
                        }
                    }
                }
                if (cfg.fieldNameForAssetId) {
                    document.getElementById('fs-id-field').value = cfg.fieldNameForAssetId;
                }
                if (cfg.syncOptions) {
                    document.getElementById('fs-opt-push').checked = cfg.syncOptions.pushEnabled !== false;
                    document.getElementById('fs-opt-pull').checked = cfg.syncOptions.pullEnabled !== false;
                    document.getElementById('fs-opt-conflict').value = cfg.syncOptions.conflictStrategy || 'last_write_wins';
                }
                this.renderMappingTable();
                await this.updateStatus();
            } catch (e) {
                console.log('[feishu] loadConfig:', e.message);
            }
        },

        async saveConfig(silent = false) {
            // 只保存已映射(选了飞书字段)的行
            const validMappings = this._mappings.filter(m => m.feishuField);
            const cfg = {
                appId: document.getElementById('fs-app-id').value.trim(),
                appSecret: document.getElementById('fs-app-secret').value.trim(),
                appToken: document.getElementById('fs-app-token').value.trim(),
                tableId: document.getElementById('fs-table-id').value.trim(),
                fieldNameForAssetId: document.getElementById('fs-id-field').value || '资产编号',
                fieldMappings: validMappings,
                syncOptions: {
                    pushEnabled: document.getElementById('fs-opt-push').checked,
                    pullEnabled: document.getElementById('fs-opt-pull').checked,
                    conflictStrategy: document.getElementById('fs-opt-conflict').value
                }
            };
            try {
                await ApiClient.request('POST', '/api/feishu/config', cfg);
                if (!silent) showNotification('飞书配置已保存', 'success');
            } catch (e) {
                showNotification((silent ? '自动保存配置失败: ' : '保存失败: ') + e.message, 'error');
            }
        },

        /** 收集表单里的飞书凭证(appSecret 显示掩码时服务端会自动保留已保存原值) */
        _credentialBody() {
            return {
                appId: document.getElementById('fs-app-id').value.trim(),
                appSecret: document.getElementById('fs-app-secret').value.trim(),
                appToken: document.getElementById('fs-app-token').value.trim()
            };
        },

        /** 拉取该多维表格下全部数据表, 填充下拉并选中 preselectId/已保存的表 */
        async loadTables(preselectId) {
            if (!this._ensureConfigured('获取数据表')) return;
            const sel = document.getElementById('fs-table-select');
            const hint = document.getElementById('fs-table-hint');
            const btn = document.getElementById('fs-refresh-tables');
            if (!sel) return;
            const wantTable = (preselectId || document.getElementById('fs-table-id').value.trim() || '').trim();
            sel.innerHTML = '<option value="">— 加载中... —</option>';
            sel.disabled = true;
            if (btn) btn.disabled = true;
            if (hint) hint.style.display = 'none';
            try {
                const result = await ApiClient.request('POST', '/api/feishu/tables', this._credentialBody());
                this._feishuTables = result.tables || [];
                let html = '<option value="">— 全部数据表(按主体自动路由) —</option>';
                html += this._feishuTables.map(t =>
                    `<option value="${t.table_id}">${t.name} (${t.table_id})</option>`).join('');
                // 已保存的 tableId 已失效(表被删除/重建): 追加失效项, 让用户能发现并重选
                if (wantTable && !this._feishuTables.some(t => t.table_id === wantTable)) {
                    html += `<option value="${wantTable}">⚠ ${wantTable}(该表已不存在, 请重选)</option>`;
                }
                sel.innerHTML = html;
                const exists = this._feishuTables.some(t => t.table_id === wantTable);
                sel.value = wantTable || '';
                this._syncTableIdFromSelect();
                if (wantTable && !exists && hint) {
                    hint.style.display = 'block';
                    hint.style.color = 'var(--note-danger-fg)';
                    hint.textContent = `⚠ 数据表 ${wantTable} 已不存在(可能被删除或重建), 请重新选择`;
                }
                return this._feishuTables;
            } catch (e) {
                sel.innerHTML = '<option value="">— 获取失败, 点「刷新」重试 —</option>';
                showNotification('获取数据表失败: ' + e.message, 'error');
            } finally {
                sel.disabled = false;
                if (btn) btn.disabled = false;
            }
        },

        /** 下拉选表: 同步到 Table ID 输入框 → 静默保存 → 自动重新加载该表字段 */
        async onTableSelect() {
            this._syncTableIdFromSelect();
            const hint = document.getElementById('fs-table-hint');
            if (hint) hint.style.display = 'none';
            const tableId = document.getElementById('fs-table-id').value.trim();
            await this.saveConfig(true);
            if (tableId) {
                await this.loadFields();
            } else {
                showNotification('已选择「全部数据表」: 拉取遍历所有表, 推送按主体自动路由', 'success');
            }
        },

        _syncTableIdFromSelect() {
            const sel = document.getElementById('fs-table-select');
            const input = document.getElementById('fs-table-id');
            if (sel && input) input.value = sel.value;
        },

        /** 手动改 Table ID(如粘贴链接自动填入)时, 反向同步下拉选中态 */
        _syncSelectFromTableId() {
            const sel = document.getElementById('fs-table-select');
            const input = document.getElementById('fs-table-id');
            if (!sel || !input || !this._feishuTables || !this._feishuTables.length) return;
            const v = input.value.trim();
            if (!v || this._feishuTables.some(t => t.table_id === v)) sel.value = v;
        },

        async testConnection() {
            if (!this._ensureConfigured('测试连接')) return;
            const btn = document.getElementById('fs-test-conn');
            btn.disabled = true; btn.textContent = '测试中...';
            try {
                const body = {
                    appId: document.getElementById('fs-app-id').value.trim(),
                    appSecret: document.getElementById('fs-app-secret').value.trim(),
                    appToken: document.getElementById('fs-app-token').value.trim(),
                    tableId: document.getElementById('fs-table-id').value.trim()
                };
                const result = await ApiClient.request('POST', '/api/feishu/test-connection', body);
                this.showResult('success', `连接成功! 字段数: ${result.fieldCount}, 样本记录: ${result.sampleRecordId || '无'}`);
            } catch (e) {
                this.showResult('error', '连接失败: ' + e.message);
            } finally {
                btn.disabled = false; btn.innerHTML = '<i class="fas fa-plug"></i> 测试连接';
            }
        },

        async loadFields() {
            if (!this._ensureConfigured('加载字段')) return;
            const tableId = document.getElementById('fs-table-id').value.trim();
            if (!tableId) {
                showNotification('请先在「选择数据表」中选择一张数据表(字段映射以该表结构为参考)', 'warning');
                return;
            }
            try {
                const result = await ApiClient.request('POST', '/api/feishu/fields', {
                    ...this._credentialBody(),
                    tableId
                });
                this._feishuFields = result.fields || [];
                // 若已有保存的映射, 保留; 否则自动生成全字段默认映射
                if (!this._mappings || this._mappings.length === 0) {
                    this.ensureDefaultMappings();
                }
                this.renderMappingTable();
                this.updateIdFieldSelect();
                const mapped = this._mappings.filter(m => m.feishuField).length;
                showNotification(`已加载 ${this._feishuFields.length} 个飞书字段, 自动匹配 ${mapped}/${this._mappings.length} 个本地字段`, 'success');
            } catch (e) {
                showNotification('加载字段失败: ' + e.message, 'error');
            }
        },

        async autoDetect() {
            if (!this._ensureConfigured('自动映射')) return;
            try {
                const result = await ApiClient.request('POST', '/api/feishu/fields/auto-detect');
                const suggested = result.suggestedMappings || [];
                // 以服务端智能匹配为准, 但保证所有本地字段都有行(未匹配的显示"不映射")
                this._mappings = [];
                const used = new Set();
                for (const s of suggested) {
                    this._mappings.push(s);
                    used.add(s.feishuField);
                }
                for (const [localField, label] of Object.entries(this.LOCAL_FIELD_LABELS)) {
                    if (!this._mappings.find(m => m.localField === localField)) {
                        this._mappings.push({
                            localField, feishuField: '',
                            type: this.LOCAL_FIELD_TYPES[localField] || 'text'
                        });
                    }
                }
                this.renderMappingTable();
                showNotification(`自动映射完成: ${suggested.length} 个字段已匹配`, 'success');
            } catch (e) {
                showNotification('自动映射失败: ' + e.message, 'error');
            }
        },

        async syncPush() {
            if (!this._ensureConfigured('推送')) return;
            const btn = document.getElementById('fs-sync-push');
            btn.disabled = true; btn.textContent = '推送中...';
            this.showResult('info', '正在推送到飞书...');
            try {
                const result = await ApiClient.request('POST', '/api/feishu/sync/push');
                this.showResult('success',
                    `推送完成: 新增 ${result.created}, 更新 ${result.updated}, 跳过 ${result.skipped}, 失败 ${result.failed.length}` +
                    (result.failed.length ? '\n失败详情: ' + result.failed.map(f => `${f.id}(${f.error})`).join('; ') : ''));
                await this.updateStatus();
            } catch (e) {
                this.showResult('error', '推送失败: ' + e.message);
            } finally {
                btn.disabled = false; btn.innerHTML = '<i class="fas fa-upload"></i> 推送到飞书';
            }
        },

        async syncPull() {
            if (!this._ensureConfigured('拉取')) return;
            const btn = document.getElementById('fs-sync-pull');
            btn.disabled = true; btn.textContent = '拉取中...';
            this.showResult('info', '正在从飞书拉取...');
            try {
                const result = await ApiClient.request('POST', '/api/feishu/sync/pull');
                this.showResult('success',
                    `拉取完成: 新增 ${result.created}, 更新 ${result.updated}, 跳过 ${result.skipped}, 无效 ${result.invalid.length}` +
                    (result.invalid.length ? '\n无效详情: ' + result.invalid.map(f => `${f.id || f.record_id}(${f.errors[0]})`).join('; ') : ''));
                // 刷新本地资产列表
                if (typeof ApiClient !== 'undefined' && ApiClient.reloadAssetsData) {
                    await ApiClient.reloadAssetsData();
                }
                await this.updateStatus();
            } catch (e) {
                this.showResult('error', '拉取失败: ' + e.message);
            } finally {
                btn.disabled = false; btn.innerHTML = '<i class="fas fa-download"></i> 从飞书拉取';
            }
        },

        async updateStatus() {
            try {
                const s = await ApiClient.request('GET', '/api/feishu/sync/status');
                const text = document.getElementById('fs-status-text');
                if (s.lastSyncAt) {
                    text.textContent = `上次同步: ${s.lastSyncDirection === 'push' ? '推送' : '拉取'} @ ${new Date(s.lastSyncAt).toLocaleString()}` +
                        (s.lastSyncStats ? ` (新增${s.lastSyncStats.created} 更新${s.lastSyncStats.updated} 跳过${s.lastSyncStats.skipped})` : '');
                }
            } catch (e) { /* ignore */ }
        },

        showResult(type, text) {
            const el = document.getElementById('fs-sync-result');
            el.style.display = 'block';
            // 用语义化 CSS 变量, 深色主题自动反色
            const map = {
                success: ['var(--note-success-bg)', 'var(--note-success-border)', 'var(--note-success-fg)'],
                error:   ['var(--note-danger-bg)',  'var(--note-danger-border)',  'var(--note-danger-fg)'],
                info:    ['var(--note-info-bg)',    'var(--note-info-border)',    'var(--note-info-fg)']
            };
            const [bg, bd, fg] = map[type] || map.info;
            el.style.background = bg;
            el.style.borderColor = bd;
            el.style.color = fg;
            el.style.border = '1px solid';
            el.textContent = text;
        },

        // 本地字段中文名（与资产表单标签一致）
        LOCAL_FIELD_LABELS: {
            id: '资产编号',
            owner: '主体',
            type: '设备类型',
            brandModel: '品牌型号',
            configuration: '配置信息',
            purchaseDate: '购入日期',
            status: '使用状态',
            user: '使用人',
            department: '部门',
            location: '位置',
            manager: '负责人',
            damageReason: '损坏原因',
            unit: '单位',
            quantity: '数量',
            value: '价值（元）',
            depreciationYears: '折旧年限',
            purchaseNo: '采购编号',
            paymentNo: '付款编号',
        },

        // 本地字段类型（与服务端 FIELD_TYPE_MAP 一致）
        LOCAL_FIELD_TYPES: {
            id: 'text', owner: 'text', type: 'text', brandModel: 'text',
            configuration: 'text', purchaseDate: 'date', status: 'single_select',
            user: 'text', department: 'text', location: 'text', manager: 'text',
            unit: 'text', quantity: 'number', value: 'number',
            depreciationYears: 'number', purchaseNo: 'text', paymentNo: 'text', damageReason: 'text'
        },

        // 智能匹配关键词（本地字段 → 飞书字段名可能包含的词）
        LOCAL_FIELD_HINTS: {
            id: ['资产编号', '编号'],
            owner: ['主体', '购买主体', '公司'],
            type: ['类型', '设备类型'],
            brandModel: ['品牌', '型号', '名称'],
            configuration: ['配置', '规格'],
            purchaseDate: ['购买日期', '购入日期', '日期'],
            status: ['状态'],
            user: ['使用人', '领用人'],
            department: ['部门', '使用部门'],
            location: ['位置', '地点'],
            manager: ['负责人', '管理人'],
            damageReason: ['损坏', '报废原因'],
            unit: ['单位'],
            quantity: ['数量'],
            value: ['价值', '金额', '含税', '不含税'],
            depreciationYears: ['折旧', '年限'],
            purchaseNo: ['采购流程', '采购编号'],
            paymentNo: ['付款流程', '付款编号'],
        },

        // 字段类型中文名
        TYPE_LABELS: {
            text: '文本',
            number: '数字',
            date: '日期',
            single_select: '单选',
            multi_select: '多选',
        },

        /** 🆕 加载飞书字段后, 自动为全部本地字段生成映射行(智能预选同名飞书字段) */
        ensureDefaultMappings() {
            if (this._mappings && this._mappings.length > 0) return;
            const used = new Set();
            const mappings = [];
            for (const [localField, label] of Object.entries(this.LOCAL_FIELD_LABELS)) {
                let feishuField = '';
                // 1) 精确同名
                let hit = this._feishuFields.find(f => f.field_name === label && !used.has(f.field_name));
                // 2) 关键词包含匹配
                if (!hit) {
                    const hints = this.LOCAL_FIELD_HINTS[localField] || [label];
                    for (const h of hints) {
                        hit = this._feishuFields.find(f => f.field_name.includes(h) && !used.has(f.field_name));
                        if (hit) break;
                    }
                }
                if (hit) { feishuField = hit.field_name; used.add(hit.field_name); }
                mappings.push({
                    localField,
                    feishuField,
                    type: this.LOCAL_FIELD_TYPES[localField] || 'text'
                });
            }
            this._mappings = mappings;
        },

        renderMappingTable() {
            const tbody = document.getElementById('fs-mapping-tbody');
            tbody.innerHTML = '';
            for (const m of this._mappings) {
                const label = this.LOCAL_FIELD_LABELS[m.localField] || m.localField;
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td style="padding:6px 10px;border-bottom:1px solid var(--gray-border);" title="${m.localField}">${label}</td>
                    <td style="padding:6px 10px;border-bottom:1px solid var(--gray-border);">
                        <select data-local="${m.localField}" class="fs-feishu-field" style="width:100%;">
                            <option value="" ${!m.feishuField ? 'selected' : ''}>— 不映射 —</option>
                            ${this._feishuFields.map(f => `<option value="${f.field_name}" ${f.field_name === m.feishuField ? 'selected' : ''}>${f.field_name}</option>`).join('')}
                        </select>
                    </td>
                    <td style="padding:6px 10px;border-bottom:1px solid var(--gray-border);">${this.TYPE_LABELS[m.type] || m.type}</td>
                `;
                tbody.appendChild(tr);
            }
            // 映射表为空时给个提示
            if (this._mappings.length === 0) {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td colspan="3" style="padding:14px 10px;color:var(--gray-dark);font-size:12px;text-align:center;">
                    请先填写上方飞书凭证并点「加载字段」, 系统会自动生成字段映射
                </td>`;
                tbody.appendChild(tr);
            }
            // 绑定变更事件
            tbody.querySelectorAll('.fs-feishu-field').forEach(sel => {
                sel.addEventListener('change', (e) => {
                    const local = e.target.dataset.local;
                    const map = this._mappings.find(m => m.localField === local);
                    if (map) map.feishuField = e.target.value;
                });
            });
        },

        updateIdFieldSelect() {
            const sel = document.getElementById('fs-id-field');
            const current = sel.value;
            sel.innerHTML = this._feishuFields.map(f =>
                `<option value="${f.field_name}">${f.field_name}</option>`
            ).join('');
            // 默认选中「资产编号」字段, 其次保留已保存值
            const prefer = current || '资产编号';
            const match = this._feishuFields.find(f => f.field_name === prefer)
                       || this._feishuFields.find(f => f.field_name.includes('编号'));
            if (match) sel.value = match.field_name;
        },

        bindEvents() {
            document.getElementById('fs-test-conn').addEventListener('click', () => this.testConnection());
            document.getElementById('fs-load-fields').addEventListener('click', () => this.loadFields());
            document.getElementById('fs-auto-detect').addEventListener('click', () => this.autoDetect());
            document.getElementById('fs-save-config').addEventListener('click', () => this.saveConfig());
            document.getElementById('fs-sync-push').addEventListener('click', () => this.syncPush());
            document.getElementById('fs-sync-pull').addEventListener('click', () => this.syncPull());
            // 🆕 小白友好: URL 自动提取 + Secret 显示切换 + 按钮状态实时刷新
            const parseBtn = document.getElementById('fs-parse-url');
            if (parseBtn) parseBtn.addEventListener('click', () => this.parseFeishuUrl());
            const secretToggle = document.getElementById('fs-secret-toggle');
            if (secretToggle) secretToggle.addEventListener('change', (e) => {
                document.getElementById('fs-app-secret').type = e.target.checked ? 'text' : 'password';
            });
            // 任何字段变化都刷新按钮状态
            ['fs-app-id','fs-app-secret','fs-app-token','fs-table-id'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.addEventListener('input', () => this.refreshButtonStates());
            });
            // Table ID 手动变化(含粘贴链接自动填入)时反向同步下拉
            const tableIdInput = document.getElementById('fs-table-id');
            if (tableIdInput) tableIdInput.addEventListener('input', () => this._syncSelectFromTableId());
            // 数据表下拉: 选中后静默保存并重新加载该表字段
            const tableSelect = document.getElementById('fs-table-select');
            if (tableSelect) tableSelect.addEventListener('change', () => this.onTableSelect());
            // 刷新数据表列表 / App Token 改完后自动重新拉取
            const refreshTablesBtn = document.getElementById('fs-refresh-tables');
            if (refreshTablesBtn) refreshTablesBtn.addEventListener('click', () => this.loadTables());
            const appTokenEl = document.getElementById('fs-app-token');
            if (appTokenEl) appTokenEl.addEventListener('change', () => {
                if (appTokenEl.value.trim()) this.loadTables();
            });
            this.refreshButtonStates();
        },

        /** 🆕 检查必填项, 返回 [{field, label}] 列表 */
        _missing() {
            const fields = [
                { id: 'fs-app-id',      label: 'App ID (cli_xxx)' },
                { id: 'fs-app-secret',  label: 'App Secret (应用密钥)' },
                { id: 'fs-app-token',   label: 'App Token (飞书链接里自动提取)' },
            ];
            return fields.filter(f => !document.getElementById(f.id).value.trim());
        },

        /** 🆕 根据必填项填充情况, 实时禁用/启用按钮 + 显示明确的帮助提示 */
        refreshButtonStates() {
            const missing = this._missing();
            const disable = missing.length > 0;
            const disableActions = ['fs-load-fields','fs-auto-detect','fs-sync-push','fs-sync-pull'];
            disableActions.forEach(id => {
                const btn = document.getElementById(id);
                if (btn) {
                    btn.disabled = disable;
                    btn.style.opacity = disable ? 0.5 : 1;
                    btn.style.cursor = disable ? 'not-allowed' : 'pointer';
                    btn.title = disable
                        ? `还缺 ${missing.map(m=>m.label).join('、')} — 按小白引导第 1/3 步填写`
                        : '';
                }
            });
            // 测试连接按钮只需要 appId + appSecret (可不带 token 做连通性测试)
            const testBtn = document.getElementById('fs-test-conn');
            if (testBtn) {
                const needAuth = ['fs-app-id','fs-app-secret'].filter(id => !document.getElementById(id).value.trim());
                testBtn.disabled = needAuth.length > 0;
                testBtn.style.opacity = needAuth.length ? 0.5 : 1;
                testBtn.style.cursor = needAuth.length ? 'not-allowed' : 'pointer';
                testBtn.title = needAuth.length ? `还缺 ${needAuth.map(id=>id==='fs-app-id'?'App ID':'App Secret').join(' 和 ')}` : '';
            }
            // 保存按钮永远可点 (让用户空存也行, 可能在填一半想先存)
        },

        /** 🆕 优雅提示: 操作前先自检必填项 */
        _ensureConfigured(actionLabel) {
            const missing = this._missing();
            if (missing.length === 0) return true;
            const names = missing.map(m => `「${m.label}」`).join('、');
            showNotification(
                `⚠ 还没填 ${names}，请先按小白引导第 1-3 步配置完再${actionLabel}`,
                'warning'
            );
            // 顺便把小白引导展开
            const guide = document.getElementById('fs-beginner-guide');
            if (guide && guide.hasAttribute) guide.open = true;
            return false;
        },

        /**
         * 从飞书多维表格分享链接里自动解析 App Token 和 Table ID
         * 支持的 URL 格式:
         *   https://xxx.feishu.cn/base/bascnXXXXX?table=tblYYY&view=vewZZZ
         *   https://xxx.feishu.cn/wiki/wikcnXXXXX?table=tblYYY  (wiki 知识库)
         *   https://xxx.larksuite.com/base/... (国际版)
         */
        parseFeishuUrl() {
            const input = document.getElementById('fs-feishu-url');
            const resultBox = document.getElementById('fs-url-parse-result');
            if (!resultBox) return;
            const raw = (input.value || '').trim();
            if (!raw) {
                resultBox.style.display = 'block';
                resultBox.style.color = 'var(--note-danger-fg)';
                resultBox.textContent = '⚠ 请先粘贴飞书多维表格的分享链接';
                return;
            }
            // 1) 解析 URL
            let url;
            try { url = new URL(raw); }
            catch {
                resultBox.style.display = 'block';
                resultBox.style.color = 'var(--note-danger-fg)';
                resultBox.textContent = '⚠ 这不是一个有效的链接, 请复制飞书多维表格右上角「分享」按钮里的链接';
                return;
            }
            // 2) 提取 appToken: /base/后面, 或 /wiki/后面
            let appToken = '';
            let tableId = '';
            // 路径段查找 bascn (bitable) 或 wikcn (wiki)
            const segments = url.pathname.split('/').filter(Boolean);
            for (let i = 0; i < segments.length; i++) {
                if (segments[i] === 'base' && segments[i + 1]) {
                    appToken = segments[i + 1]; break;
                }
                // wiki 链接也尝试取 (后续可通过 API 解析 wiki → 真实 app token)
                if (segments[i] === 'wiki' && segments[i + 1] && !appToken) {
                    appToken = segments[i + 1]; // 暂时先填 wiki token
                }
            }
            // 3) 从 query string 提取 table=xxx
            tableId = url.searchParams.get('table') || '';
            // 4) 兜底: 正则匹配 bascn/tblxxx (有时链接格式怪异)
            if (!appToken) {
                const m = raw.match(/(bascn[a-zA-Z0-9]+)/);
                if (m) appToken = m[1];
            }
            if (!tableId) {
                const m = raw.match(/[?&]table=(tbl[a-zA-Z0-9]+)/);
                if (m) tableId = m[1];
            }
            // 5) 写入表单
            if (appToken) document.getElementById('fs-app-token').value = appToken;
            if (tableId) document.getElementById('fs-table-id').value = tableId;
            // 6) 反馈
            resultBox.style.display = 'block';
            if (appToken) {
                resultBox.style.color = 'var(--note-success-fg)';
                let msg = '✓ 已提取 App Token: ' + appToken;
                if (tableId) msg += '  |  Table ID: ' + tableId;
                else msg += '  (Table ID 未找到, 建议用下方下拉选择或留空同步全部)';
                resultBox.textContent = msg;
                showNotification('✅ 已从链接自动填入 App Token / Table ID', 'success');
                // 刷新数据表下拉并选中链接里的表, 随后自动加载字段
                this.loadTables(tableId || '').then(tables => {
                    if (tableId && (!tables || !tables.some(t => t.table_id === tableId))) {
                        showNotification('链接中的数据表 ' + tableId + ' 不存在, 请在下拉中重选', 'warning');
                    } else if (tableId) {
                        this._syncTableIdFromSelect();
                        this.saveConfig(true).then(() => this.loadFields());
                    }
                });
            } else {
                resultBox.style.color = 'var(--note-danger-fg)';
                resultBox.textContent = '⚠ 未能识别 App Token, 请确认这是多维表格 (base) 的链接, 或手动复制 bascn 开头的那串字符';
            }
        }
    };

    document.addEventListener('DOMContentLoaded', () => FeishuSync.init());
    window.FeishuSync = FeishuSync;
})();
