/**
 * 资产盘点模块
 * 功能: 发起盘点批次 / 列表勾选盘点 / 扫码盘点 / 异常备注 / 完成报告导出 Excel / 多轮历史
 * 依赖: storageManager(三模式持久化)、assetsData(资产快照来源)、ApiClient.user(登录上下文)、XLSX(导出)
 * 存储: kv_store 表，键 inventory_sessions(批次列表) + inventory_session_<id>(批次明细)
 * 权限: 所有登录用户(含 viewer)均可发起和执行盘点 (compat.js /save /delete 已对 inventory_* 放行)
 */
(function () {
    'use strict';

    // ====== 常量 ======
    const STORAGE_KEY_SESSIONS = 'inventory_sessions';
    const STORAGE_KEY_PREFIX = 'inventory_session_';

    // ====== 状态 ======
    let currentSession = null;       // 当前打开的批次明细
    let sessionsList = [];           // 批次列表缓存
    let scanCallback = null;         // 扫码回调引用(保留以备调试)
    let pendingExceptionAssetId = null;  // 异常弹窗当前资产
    let pendingManualScan = false;   // 是否处于桌面端手动输入模式

    // ====== 持久化封装 ======

    async function loadSessions() {
        const data = await storageManager.getItem(STORAGE_KEY_SESSIONS);
        return Array.isArray(data) ? data : [];
    }
    async function saveSessions(list) {
        await storageManager.setItem(STORAGE_KEY_SESSIONS, list);
    }
    async function loadSessionDetail(id) {
        const data = await storageManager.getItem(STORAGE_KEY_PREFIX + id);
        return data || null;
    }
    /**
     * 保存批次明细(乐观锁: 与服务端最新版本对比，冲突抛 40901)
     * 同时同步更新 sessions 列表中的对应项缓存字段
     */
    async function saveSessionDetail(detail) {
        const fresh = await loadSessionDetail(detail.id);
        if (fresh && fresh.version !== detail.version) {
            throw { code: 40901, message: '该盘点批次已被其他用户更新，请刷新后重试' };
        }
        detail.version = (detail.version || 0) + 1;
        detail.session.version = detail.version;
        detail.session.updatedAt = new Date().toISOString();
        // 同步列表项缓存字段
        await updateSessionsListEntry(detail.session);
        await storageManager.setItem(STORAGE_KEY_PREFIX + detail.id, detail);
        return detail;
    }
    async function updateSessionsListEntry(session) {
        const list = await loadSessions();
        const idx = list.findIndex(s => s.id === session.id);
        if (idx >= 0) {
            list[idx] = session;
        } else {
            list.unshift(session);
        }
        await saveSessions(list);
    }

    // ====== 业务操作 ======

    // 发起盘点
    async function createSession(name, scope) {
        const id = 'inv_' + new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14);
        // 从 assetsData 按 scope 筛选
        let filtered = assetsData || [];
        if (scope.mode === 'department') {
            filtered = filtered.filter(a => a.owner === scope.department || a.department === scope.department);
        } else if (scope.mode === 'location') {
            filtered = filtered.filter(a => a.location === scope.location);
        }
        // 生成 items
        const items = filtered.map(a => ({
            assetId: a.id,
            snapshot: {
                type: a.type, brandModel: a.brandModel, owner: a.owner,
                user: a.user, department: a.department,
                location: a.location, status: a.status
            },
            status: 'pending',
            countedBy: null, countedAt: null, exceptionNote: null
        }));
        const now = new Date().toISOString();
        const session = {
            id, name, creator: (typeof ApiClient !== 'undefined' && ApiClient.user) ?
                (ApiClient.user.username || ApiClient.user.name || '用户') : '本地用户',
            creatorRole: (typeof ApiClient !== 'undefined' && ApiClient.user) ?
                (ApiClient.user.role || 'viewer') : 'local',
            createdAt: now, updatedAt: now,
            status: 'in_progress', scope,
            totalAssets: items.length, countedAssets: 0, exceptionCount: 0,
            version: 0
        };
        const detail = { id, session, items, version: 0 };
        await saveSessionDetail(detail);
        return detail;
    }

    // 标记单条
    async function markItem(assetId, status, exceptionNote) {
        if (!currentSession) return;
        const item = currentSession.items.find(i => i.assetId === assetId);
        if (!item) return;
        item.status = status;
        item.exceptionNote = status === 'exception' ? (exceptionNote || '') : null;
        if (status !== 'pending') {
            item.countedBy = (typeof ApiClient !== 'undefined' && ApiClient.user) ?
                (ApiClient.user.username || ApiClient.user.name || '用户') : '本地用户';
            item.countedAt = new Date().toISOString();
        } else {
            item.countedBy = null;
            item.countedAt = null;
            item.exceptionNote = null;
        }
        // 更新缓存统计
        updateCachedCounts();
        // 持久化(乐观锁)
        try {
            await saveSessionDetail(currentSession);
        } catch (e) {
            // 冲突 → 重载
            if (e && e.code === 40901) {
                showToast(e.message, 'error');
                currentSession = await loadSessionDetail(currentSession.id);
                renderSessionDetail(currentSession);
                return;
            }
            throw e;
        }
    }

    function updateCachedCounts() {
        if (!currentSession) return;
        const items = currentSession.items || [];
        currentSession.session.countedAssets = items.filter(i => i.status === 'counted').length;
        currentSession.session.exceptionCount = items.filter(i => i.status === 'exception').length;
    }

    // 完成盘点
    async function closeSession(id) {
        if (!currentSession) return;
        const pending = currentSession.items.filter(i => i.status === 'pending').length;
        if (pending > 0) {
            if (!confirm(`仍有 ${pending} 条资产未盘到，确定完成盘点？`)) return;
        }
        currentSession.session.status = 'completed';
        updateCachedCounts();
        try {
            await saveSessionDetail(currentSession);
            showToast('盘点已完成', 'success');
        } catch (e) {
            if (e && e.code === 40901) {
                showToast(e.message, 'error');
                currentSession = await loadSessionDetail(currentSession.id);
                renderSessionDetail(currentSession);
            } else {
                throw e;
            }
        }
    }

    // 删除批次
    async function deleteSession(id) {
        if (!confirm('确定删除此盘点批次？此操作不可撤销。')) return;
        const list = await loadSessions();
        const filtered = list.filter(s => s.id !== id);
        await saveSessions(filtered);
        // 删除明细键(storageManager.removeItem 在 C/S 走 /api/delete，已对 inventory_ 放行)
        try { await storageManager.removeItem(STORAGE_KEY_PREFIX + id); } catch (e) { /* 忽略 */ }
        if (currentSession && currentSession.id === id) {
            currentSession = null;
            backToList();
        } else {
            renderSessionsList();
        }
    }

    // ====== 扫码盘点 ======

    async function startScanMode() {
        if (!currentSession) return;
        if (currentSession.session.status !== 'in_progress') {
            showToast('该批次已完成盘点', 'info');
            return;
        }
        // 检查环境: 移动端 → 原生扫码; 桌面端 → 自定义输入弹窗(Electron v30+ 静默拦截原生 prompt)
        if (typeof MobileBridge !== 'undefined' && MobileBridge.isCapacitor && MobileBridge.isCapacitor()) {
            document.getElementById('inv-scan-overlay').classList.add('active');
            updateScanStatus();
            MobileBridge.scanForInventory(onScannedAsset);
        } else {
            // 桌面端降级: 显示手动输入弹窗
            pendingManualScan = true;
            document.getElementById('inv-manual-input').value = '';
            document.getElementById('inv-manual-modal').classList.add('active');
            setTimeout(() => document.getElementById('inv-manual-input').focus(), 50);
        }
    }

    function onScannedAsset(assetId) {
        if (!currentSession) return;
        const item = currentSession.items.find(i => i.assetId === assetId);
        if (!item) {
            showToast('资产 ' + assetId + ' 不在本批次范围内', 'error');
            return;
        }
        if (item.status === 'counted') {
            showToast('资产 ' + assetId + ' 已盘过', 'info');
            return;
        }
        markItem(assetId, 'counted', '').then(() => {
            updateScanStatus();
            // 刷新表格
            renderSessionDetail(currentSession);
        });
    }

    function updateScanStatus() {
        if (!currentSession) return;
        const counted = currentSession.items.filter(i => i.status === 'counted').length;
        const total = currentSession.items.length;
        const el = document.getElementById('inv-scan-status');
        if (el) el.textContent = `已扫到 ${counted} / ${total} 条`;
    }

    function stopScan() {
        if (typeof MobileBridge !== 'undefined' && MobileBridge.stopInventoryScan) {
            MobileBridge.stopInventoryScan();
        }
        document.getElementById('inv-scan-overlay').classList.remove('active');
    }

    // 桌面端手动输入提交
    async function submitManualScan() {
        const val = (document.getElementById('inv-manual-input').value || '').trim();
        if (!val) {
            showToast('请输入资产编号', 'info');
            return;
        }
        // 支持换行/逗号分隔的批量输入
        const ids = val.split(/[\s,，;；]+/).filter(Boolean);
        document.getElementById('inv-manual-input').value = '';
        for (const aid of ids) {
            onScannedAsset(aid);
        }
        // 保留弹窗打开，便于连续录入
        document.getElementById('inv-manual-input').focus();
    }

    function closeManualScan() {
        pendingManualScan = false;
        document.getElementById('inv-manual-modal').classList.remove('active');
    }

    // ====== 视图渲染 ======

    async function renderSessionsList() {
        const container = document.getElementById('inv-sessions-container');
        if (!container) return;
        sessionsList = await loadSessions();
        if (sessionsList.length === 0) {
            container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">' +
                '<svg class="svg-icon" style="font-size:48px;margin-bottom:12px;display:block;"><use xlink:href="#icon-clipboard"></use></svg>' +
                '暂无盘点记录，点击上方"发起盘点"开始</div>';
            return;
        }
        container.innerHTML = sessionsList.map(s => {
            const pct = s.totalAssets > 0 ? Math.round(s.countedAssets / s.totalAssets * 100) : 0;
            return '<div class="inv-session-card" onclick="openSession(\'' + s.id + '\')">' +
                '<div class="inv-session-info">' +
                '<div class="inv-session-name">' + escapeHtml(s.name) +
                    '<span class="inv-status-badge inv-status-' + s.status + '">' +
                    (s.status === 'in_progress' ? '进行中' : '已完成') + '</span></div>' +
                '<div class="inv-session-meta">创建人：' + escapeHtml(s.creator) +
                    ' · ' + (s.createdAt || '').substring(0, 16).replace('T', ' ') +
                    ' · 已盘 ' + s.countedAssets + '/' + s.totalAssets +
                    ' · 异常 ' + (s.exceptionCount || 0) + ' · ' + pct + '%</div>' +
                '</div>' +
                '<div style="display:flex;align-items:center;gap:8px;">' +
                '<span style="color:var(--text-secondary);font-size:20px;font-weight:600;">' + pct + '%</span>' +
                (s.status === 'in_progress' ?
                    '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();openSession(\'' + s.id + '\')">继续</button>'
                    : '<button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();openSession(\'' + s.id + '\')">查看</button>') +
                '<button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteSession(\'' + s.id + '\')">删除</button>' +
                '</div></div>';
        }).join('');
    }

    function renderSessionDetail(detail) {
        // 切换视图
        const listCard = document.getElementById('inv-list-card');
        const detailBox = document.getElementById('inv-detail-container');
        if (listCard) listCard.style.display = 'none';
        if (detailBox) detailBox.style.display = '';
        // 统计
        const items = detail.items || [];
        const counted = items.filter(i => i.status === 'counted').length;
        const pending = items.filter(i => i.status === 'pending').length;
        const exception = items.filter(i => i.status === 'exception').length;
        const total = items.length;
        const pct = total > 0 ? Math.round(counted / total * 100) : 0;
        document.getElementById('inv-total').textContent = total;
        document.getElementById('inv-counted').textContent = counted;
        document.getElementById('inv-pending').textContent = pending;
        document.getElementById('inv-exception').textContent = exception;
        document.getElementById('inv-progress-bar').style.width = pct + '%';
        document.getElementById('inv-progress-text').textContent = pct + '%';
        // 标题
        const titleEl = document.querySelector('#inventory-page .page-title');
        if (titleEl) titleEl.innerHTML = '<svg class="svg-icon"><use xlink:href="#icon-clipboard-check"></use></svg> ' + escapeHtml(detail.session.name);
        // 表格
        const filter = document.getElementById('inv-filter').value;
        const search = (document.getElementById('inv-search').value || '').toLowerCase();
        let filtered = items;
        if (filter !== 'all') filtered = filtered.filter(i => i.status === filter);
        if (search) filtered = filtered.filter(i =>
            (i.assetId || '').toLowerCase().includes(search) ||
            ((i.snapshot && i.snapshot.brandModel) || '').toLowerCase().includes(search)
        );
        const tbody = document.getElementById('inv-items-tbody');
        tbody.innerHTML = filtered.map(i => {
            const s = i.snapshot || {};
            const statusBadge = i.status === 'counted' ?
                '<span class="inv-item-status inv-status-counted"><svg class="svg-icon"><use xlink:href="#icon-check"></use></svg> 已盘</span>' :
                i.status === 'exception' ?
                '<span class="inv-item-status inv-status-exception"><svg class="svg-icon"><use xlink:href="#icon-exclamation-triangle"></use></svg> 异常</span>' :
                '<span class="inv-item-status inv-status-pending"><svg class="svg-icon"><use xlink:href="#icon-clock"></use></svg> 未盘到</span>';
            const rowClass = i.status === 'counted' ? 'inv-row-counted' :
                i.status === 'exception' ? 'inv-row-exception' : '';
            return '<tr class="' + rowClass + '">' +
                '<td>' + escapeHtml(i.assetId) + '</td>' +
                '<td>' + escapeHtml(s.type || '-') + '</td>' +
                '<td>' + escapeHtml(s.brandModel || '-') + '</td>' +
                '<td>' + escapeHtml(s.user || '-') + '</td>' +
                '<td>' + escapeHtml(s.department || '-') + '</td>' +
                '<td>' + escapeHtml(s.location || '-') + '</td>' +
                '<td>' + statusBadge + '</td>' +
                '<td>' + escapeHtml(i.exceptionNote || '-') + '</td>' +
                '<td>' + escapeHtml(i.countedBy || '-') + '</td>' +
                '<td>' + (i.countedAt ? i.countedAt.substring(0, 16).replace('T', ' ') : '-') + '</td>' +
                '<td style="white-space:nowrap;">' +
                    '<button class="btn btn-sm btn-success" onclick="markItemUI(\'' + i.assetId + '\',\'counted\')">已盘</button> ' +
                    '<button class="btn btn-sm btn-warning" onclick="markItemUI(\'' + i.assetId + '\',\'exception\')">异常</button> ' +
                    '<button class="btn btn-sm btn-secondary" onclick="markItemUI(\'' + i.assetId + '\',\'pending\')">撤销</button>' +
                '</td></tr>';
        }).join('');
        // 完成按钮状态
        document.getElementById('inv-close-btn').style.display =
            detail.session.status === 'in_progress' ? '' : 'none';
        document.getElementById('inv-scan-btn').style.display =
            detail.session.status === 'in_progress' ? '' : 'none';
    }

    function backToList() {
        const listCard = document.getElementById('inv-list-card');
        const detailBox = document.getElementById('inv-detail-container');
        if (listCard) listCard.style.display = '';
        if (detailBox) detailBox.style.display = 'none';
        const titleEl = document.querySelector('#inventory-page .page-title');
        if (titleEl) titleEl.innerHTML = '<svg class="svg-icon"><use xlink:href="#icon-clipboard-check"></use></svg> 资产盘点';
        currentSession = null;
        renderSessionsList();
    }

    // ====== 报告导出 ======

    function exportReport() {
        if (!currentSession) return;
        const items = currentSession.items || [];
        // 复用 libs/xlsx.full.min.js(index.html 已 defer 引入)
        if (typeof XLSX === 'undefined') {
            // 动态加载兜底
            const script = document.createElement('script');
            script.src = 'libs/xlsx.full.min.js';
            script.onload = () => doExport(items);
            document.head.appendChild(script);
        } else {
            doExport(items);
        }
    }

    function doExport(items) {
        const data = items.map(i => {
            const s = i.snapshot || {};
            return {
                '资产编号': i.assetId,
                '设备类型': s.type || '',
                '品牌型号': s.brandModel || '',
                '使用人': s.user || '',
                '部门': s.department || '',
                '地点': s.location || '',
                '盘点状态': i.status === 'counted' ? '已盘' : i.status === 'exception' ? '异常' : '未盘到',
                '异常备注': i.exceptionNote || '',
                '盘点人': i.countedBy || '',
                '盘点时间': i.countedAt ? i.countedAt.substring(0, 19).replace('T', ' ') : ''
            };
        });
        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '盘点明细');
        // 汇总统计行
        const summary = [
            { '资产编号': '【统计】', '设备类型': '应盘: ' + items.length },
            { '资产编号': '已盘: ' + items.filter(i => i.status === 'counted').length },
            { '资产编号': '未盘到: ' + items.filter(i => i.status === 'pending').length },
            { '资产编号': '异常: ' + items.filter(i => i.status === 'exception').length }
        ];
        const ws2 = XLSX.utils.json_to_sheet(summary);
        XLSX.utils.book_append_sheet(wb, ws2, '汇总');
        XLSX.writeFile(wb, '盘点报告_' + currentSession.session.name + '_' +
            new Date().toISOString().substring(0, 10) + '.xlsx');
    }

    // ====== 工具函数 ======

    function escapeHtml(s) {
        if (s === null || s === undefined) return '';
        return String(s).replace(/[&<>"']/g, c =>
            ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function showToast(msg, type) {
        if (typeof showNotification === 'function') {
            showNotification(msg, type || 'info');
        } else {
            alert(msg);
        }
    }

    // ====== 异常备注弹窗 ======

    function showExceptionModal(assetId) {
        pendingExceptionAssetId = assetId;
        const item = currentSession.items.find(i => i.assetId === assetId);
        const s = item ? (item.snapshot || {}) : {};
        document.getElementById('inv-exception-target').innerHTML =
            '<strong>资产编号：</strong>' + escapeHtml(assetId) + '<br>' +
            '<strong>品牌型号：</strong>' + escapeHtml(s.brandModel || '-');
        document.getElementById('inv-exception-note').value = item ? (item.exceptionNote || '') : '';
        document.getElementById('inv-exception-modal').classList.add('active');
        setTimeout(() => document.getElementById('inv-exception-note').focus(), 50);
    }

    async function submitException() {
        const note = document.getElementById('inv-exception-note').value.trim();
        if (!note) { showToast('请输入异常情况描述', 'info'); return; }
        document.getElementById('inv-exception-modal').classList.remove('active');
        await markItem(pendingExceptionAssetId, 'exception', note);
        renderSessionDetail(currentSession);
    }

    // ====== 发起盘点弹窗 ======

    function showNewModal() {
        const now = new Date();
        document.getElementById('inv-new-name').value =
            now.getFullYear() + '年' + (now.getMonth() + 1) + '月盘点';
        document.getElementById('inv-new-scope-mode').value = 'all';
        document.getElementById('inv-new-scope-value-box').style.display = 'none';
        document.getElementById('inv-new-modal').classList.add('active');
        setTimeout(() => document.getElementById('inv-new-name').focus(), 50);
    }

    async function submitNew() {
        const name = document.getElementById('inv-new-name').value.trim();
        if (!name) { showToast('请输入批次名称', 'info'); return; }
        const scope = { mode: document.getElementById('inv-new-scope-mode').value };
        if (scope.mode === 'department') {
            scope.department = document.getElementById('inv-new-scope-value').value;
            if (!scope.department) { showToast('请选择部门', 'info'); return; }
        } else if (scope.mode === 'location') {
            scope.location = document.getElementById('inv-new-scope-value').value;
            if (!scope.location) { showToast('请选择地点', 'info'); return; }
        }
        document.getElementById('inv-new-modal').classList.remove('active');
        try {
            currentSession = await createSession(name, scope);
            renderSessionDetail(currentSession);
            showToast('盘点批次已创建，包含 ' + currentSession.items.length + ' 条资产', 'success');
        } catch (e) {
            showToast('创建盘点失败: ' + (e.message || e), 'error');
        }
    }

    function onScopeModeChange() {
        const mode = document.getElementById('inv-new-scope-mode').value;
        const box = document.getElementById('inv-new-scope-value-box');
        const label = document.getElementById('inv-new-scope-value-label');
        const select = document.getElementById('inv-new-scope-value');
        if (mode === 'all') {
            box.style.display = 'none';
            return;
        }
        box.style.display = '';
        select.innerHTML = '';
        if (mode === 'department') {
            label.textContent = '选择部门';
            const depts = [...new Set((assetsData || []).map(a => a.department).filter(Boolean))].sort();
            depts.forEach(d => select.innerHTML += '<option value="' + escapeHtml(d) + '">' + escapeHtml(d) + '</option>');
        } else if (mode === 'location') {
            label.textContent = '选择地点';
            const locs = [...new Set((assetsData || []).map(a => a.location).filter(Boolean))].sort();
            locs.forEach(l => select.innerHTML += '<option value="' + escapeHtml(l) + '">' + escapeHtml(l) + '</option>');
        }
    }

    // ====== 导航回调 ======

    window.renderInventoryPage = function () {
        backToList();
    };

    // 暴露给 onclick 调用的函数
    window.openSession = async function (id) {
        currentSession = await loadSessionDetail(id);
        if (currentSession) {
            renderSessionDetail(currentSession);
        } else {
            showToast('未找到盘点批次(可能已被其他用户删除)', 'error');
            renderSessionsList();
        }
    };
    window.deleteSession = deleteSession;
    window.markItemUI = async function (assetId, status) {
        if (status === 'exception') {
            showExceptionModal(assetId);
        } else {
            await markItem(assetId, status);
            renderSessionDetail(currentSession);
        }
    };

    // ====== DOM 事件绑定 ======

    document.addEventListener('DOMContentLoaded', function () {
        // 发起盘点
        const newBtn = document.getElementById('inv-new-btn');
        if (newBtn) newBtn.addEventListener('click', showNewModal);
        const newSubmit = document.getElementById('inv-new-submit');
        if (newSubmit) newSubmit.addEventListener('click', submitNew);
        const newCancel = document.getElementById('inv-new-cancel');
        if (newCancel) newCancel.addEventListener('click', () =>
            document.getElementById('inv-new-modal').classList.remove('active'));
        const newClose = document.getElementById('inv-new-close');
        if (newClose) newClose.addEventListener('click', () =>
            document.getElementById('inv-new-modal').classList.remove('active'));
        const scopeMode = document.getElementById('inv-new-scope-mode');
        if (scopeMode) scopeMode.addEventListener('change', onScopeModeChange);

        // 刷新
        const refreshBtn = document.getElementById('inv-refresh-btn');
        if (refreshBtn) refreshBtn.addEventListener('click', renderSessionsList);

        // 详情页操作
        const backBtn = document.getElementById('inv-back-btn');
        if (backBtn) backBtn.addEventListener('click', backToList);
        const filterEl = document.getElementById('inv-filter');
        if (filterEl) filterEl.addEventListener('change', () =>
            currentSession && renderSessionDetail(currentSession));
        const searchEl = document.getElementById('inv-search');
        if (searchEl) searchEl.addEventListener('input', () =>
            currentSession && renderSessionDetail(currentSession));
        const scanBtn = document.getElementById('inv-scan-btn');
        if (scanBtn) scanBtn.addEventListener('click', startScanMode);
        const scanStop = document.getElementById('inv-scan-stop');
        if (scanStop) scanStop.addEventListener('click', stopScan);
        const exportBtn = document.getElementById('inv-export-btn');
        if (exportBtn) exportBtn.addEventListener('click', exportReport);
        const closeBtn2 = document.getElementById('inv-close-btn');
        if (closeBtn2) closeBtn2.addEventListener('click', () => closeSession(currentSession.id));

        // 异常弹窗
        const excClose = document.getElementById('inv-exception-close');
        if (excClose) excClose.addEventListener('click', () =>
            document.getElementById('inv-exception-modal').classList.remove('active'));
        const excCancel = document.getElementById('inv-exception-cancel');
        if (excCancel) excCancel.addEventListener('click', () =>
            document.getElementById('inv-exception-modal').classList.remove('active'));
        const excSubmit = document.getElementById('inv-exception-submit');
        if (excSubmit) excSubmit.addEventListener('click', submitException);

        // 桌面端手动输入弹窗
        const manualClose = document.getElementById('inv-manual-close');
        if (manualClose) manualClose.addEventListener('click', closeManualScan);
        const manualCancel = document.getElementById('inv-manual-cancel');
        if (manualCancel) manualCancel.addEventListener('click', closeManualScan);
        const manualSubmit = document.getElementById('inv-manual-submit');
        if (manualSubmit) manualSubmit.addEventListener('click', submitManualScan);
        const manualInput = document.getElementById('inv-manual-input');
        if (manualInput) {
            manualInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submitManualScan();
                }
            });
        }
    });
})();
