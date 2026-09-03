/**
 * 用户管理视图(C/S 模式 admin 专用)
 *
 * 职责:
 *  1. 渲染用户列表(用户名/角色中文/创建时间/操作)
 *  2. 新建用户(角色下拉: 管理员=admin / 普通用户=editor)
 *  3. 删除用户(前端拦截删自己; 后端保护最后一个 admin)
 *  4. 重置他人密码(PATCH /api/users/:id)
 *
 * 仅在 C/S 模式 + admin 登录时可用; 单机模式 / 非管理员不显示入口。
 * 依赖: ApiClient(js/api.js)、showNotification(js/notifications.js)
 */
(function () {
    // 渲染用户列表
    async function renderUsersList() {
        const tbody = document.getElementById('users-tbody');
        if (!tbody) return;
        if (typeof ApiClient === 'undefined' || !ApiClient.csMode || !ApiClient.user) return;
        if (ApiClient.user.role !== 'admin') {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:20px;">仅管理员可管理用户</td></tr>';
            return;
        }
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:20px;">加载中...</td></tr>';
        try {
            const users = await ApiClient.getUsers();
            if (!Array.isArray(users) || users.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:20px;">暂无用户</td></tr>';
                return;
            }
            const currentId = ApiClient.user.id;
            tbody.innerHTML = users.map(u => {
                const roleLabel = ApiClient.getRoleLabel(u.role);
                const isSelf = u.id === currentId;
                const created = u.created_at ? String(u.created_at).replace('T', ' ').replace(/\.\d+.*$/, '') : '-';
                return '<tr style="border-bottom:1px solid #f3f4f6;">'
                    + '<td style="padding:10px 14px;">' + escapeHtml(u.username) + (isSelf ? ' <span style="color:#10b981;font-size:12px;">(我)</span>' : '') + '</td>'
                    + '<td style="padding:10px 14px;"><span style="padding:2px 8px;border-radius:10px;font-size:12px;background:' + (u.role === 'admin' ? '#dbeafe;color:#1d4ed8' : '#f3f4f6;color:#6b7280') + ';">' + roleLabel + '</span></td>'
                    + '<td style="padding:10px 14px;color:#6b7280;font-size:13px;">' + created + '</td>'
                    + '<td style="padding:10px 14px;text-align:right;white-space:nowrap;">'
                    + (isSelf ? '' : '<button class="btn btn-secondary user-reset-btn" data-id="' + u.id + '" data-name="' + escapeHtml(u.username) + '" style="padding:4px 10px;margin-right:6px;font-size:12px;"><i class="fas fa-key"></i> 重置密码</button>')
                    + (isSelf ? '' : '<button class="btn btn-danger user-delete-btn" data-id="' + u.id + '" data-name="' + escapeHtml(u.username) + '" style="padding:4px 10px;font-size:12px;"><i class="fas fa-trash"></i> 删除</button>')
                    + (isSelf ? '<span style="color:#9ca3af;font-size:12px;">当前账号</span>' : '')
                    + '</td>'
                    + '</tr>';
            }).join('');

            // 绑定删除按钮
            tbody.querySelectorAll('.user-delete-btn').forEach(btn => {
                btn.addEventListener('click', function () {
                    const id = this.getAttribute('data-id');
                    const name = this.getAttribute('data-name');
                    if (!confirm('确定删除用户 "' + name + '" 吗? 此操作不可恢复。')) return;
                    ApiClient.deleteUser(id).then(() => {
                        if (typeof showNotification === 'function') showNotification('用户 ' + name + ' 已删除', 'success', 3000);
                        renderUsersList();
                    }).catch(err => {
                        alert('删除失败: ' + (err.message || err));
                    });
                });
            });

            // 绑定重置密码按钮(打开自定义弹窗, 不用 prompt — Electron 会静默拦截原生对话框)
            tbody.querySelectorAll('.user-reset-btn').forEach(btn => {
                btn.addEventListener('click', function () {
                    const id = this.getAttribute('data-id');
                    const name = this.getAttribute('data-name');
                    openResetPwdModal(id, name);
                });
            });
        } catch (err) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#ef4444;padding:20px;">加载失败: ' + escapeHtml(err.message || String(err)) + '</td></tr>';
        }
        // 同页的操作日志卡片(admin)一并刷新
        renderAuditLog(1);
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    // 新建用户表单提交(DOMContentLoaded 后绑定)
    document.addEventListener('DOMContentLoaded', function () {
        const form = document.getElementById('user-create-form');
        if (!form) return;
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            const username = document.getElementById('new-username').value.trim();
            const password = document.getElementById('new-password').value;
            const role = document.getElementById('new-role').value;
            if (!username || !password) { alert('用户名和密码不能为空'); return; }
            if (password.length < 6) { alert('密码长度至少 6 位'); return; }

            const btn = document.getElementById('user-create-btn');
            const origText = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 创建中...';

            ApiClient.createUser({ username, password, role }).then(() => {
                form.reset();
                if (typeof showNotification === 'function') showNotification('用户 ' + username + ' 创建成功', 'success', 3000);
                renderUsersList();
            }).catch(err => {
                alert('创建失败: ' + (err.message || err));
            }).finally(() => {
                btn.disabled = false;
                btn.innerHTML = origText;
            });
        });
    });

    // ============ 操作日志查看(admin) ============

    const AUDIT_LABELS = {
        'auth.login': '登录成功',
        'auth.login_failed': '登录失败',
        'auth.logout': '退出登录',
        'user.create': '创建用户',
        'user.delete': '删除用户',
        'user.reset_password': '重置密码',
        'user.change_role': '修改角色',
        'user.change_password': '修改自己密码',
        'asset.create': '新增资产',
        'asset.update': '修改资产',
        'asset.delete': '删除资产',
    };

    function auditLabel(action) {
        if (AUDIT_LABELS[action]) return AUDIT_LABELS[action];
        if (/^asset\.batch/.test(action)) return '批量导入';
        return action;
    }

    let _auditPage = 1;
    const AUDIT_PAGE_SIZE = 20;

    async function renderAuditLog(page) {
        const card = document.getElementById('audit-card');
        const tbody = document.getElementById('audit-tbody');
        if (!card || !tbody) return;
        // 非 admin 隐藏整个卡片
        if (typeof ApiClient === 'undefined' || !ApiClient.csMode || !ApiClient.user || ApiClient.user.role !== 'admin') {
            card.style.display = 'none';
            return;
        }
        card.style.display = 'block';
        _auditPage = page || _auditPage || 1;
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:16px;">加载中...</td></tr>';
        try {
            const action = document.getElementById('audit-filter').value;
            const username = (document.getElementById('audit-username').value || '').trim();
            const r = await ApiClient.getAuditLogs({ page: _auditPage, pageSize: AUDIT_PAGE_SIZE, action, username });
            const items = r.items || [];
            document.getElementById('audit-total').textContent = '共 ' + r.total + ' 条';
            document.getElementById('audit-pageinfo').textContent = r.total ? (r.page + ' / ' + Math.max(1, Math.ceil(r.total / r.pageSize))) : '-';
            if (!items.length) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:16px;">暂无日志</td></tr>';
                return;
            }
            tbody.innerHTML = items.map(function (it) {
                const time = it.created_at || '-';
                const user = escapeHtml(it.username || '—');
                const act = auditLabel(it.action);
                const isFail = it.action === 'auth.login_failed';
                const actColor = isFail ? '#ef4444' : (/^user\./.test(it.action) ? '#7c3aed' : (/^asset\./.test(it.action) ? '#2563eb' : '#059669'));
                const target = escapeHtml(it.target || '—');
                const detail = escapeHtml(it.detail || '');
                return '<tr style="border-bottom:1px solid #f3f4f6;">'
                    + '<td style="padding:7px 12px;white-space:nowrap;color:#6b7280;">' + escapeHtml(time) + '</td>'
                    + '<td style="padding:7px 12px;white-space:nowrap;font-weight:500;">' + user + '</td>'
                    + '<td style="padding:7px 12px;white-space:nowrap;color:' + actColor + ';font-weight:500;">' + escapeHtml(act) + '</td>'
                    + '<td style="padding:7px 12px;white-space:nowrap;">' + target + '</td>'
                    + '<td style="padding:7px 12px;color:#9ca3af;">' + detail + '</td>'
                    + '</tr>';
            }).join('');
        } catch (err) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ef4444;padding:16px;">加载失败: ' + escapeHtml(err.message || String(err)) + '</td></tr>';
        }
    }

    // 暴露给 navigation.js 调用
    window.renderUsersList = renderUsersList;

    // ============ 重置他人密码弹窗(admin 专用, 替代原生 prompt) ============

    let _resetPwdTargetId = null;

    function openResetPwdModal(userId, username) {
        const modal = document.getElementById('reset-pwd-modal');
        if (!modal) return;
        _resetPwdTargetId = userId;
        const targetEl = document.getElementById('reset-pwd-target');
        if (targetEl) targetEl.innerHTML = '正在为 <b style="color:#1f2937;">' + escapeHtml(username) + '</b> 重置密码';
        document.getElementById('reset-pwd-new').value = '';
        document.getElementById('reset-pwd-confirm').value = '';
        const err = document.getElementById('reset-pwd-error');
        if (err) { err.style.display = 'none'; err.textContent = ''; }
        modal.style.display = 'flex';
        setTimeout(() => document.getElementById('reset-pwd-new').focus(), 50);
    }

    function closeResetPwdModal() {
        const modal = document.getElementById('reset-pwd-modal');
        if (modal) modal.style.display = 'none';
        _resetPwdTargetId = null;
    }

    function showResetPwdError(msg) {
        const el = document.getElementById('reset-pwd-error');
        if (el) { el.textContent = msg; el.style.display = 'block'; }
    }

    async function submitResetPwd() {
        const newPwd = document.getElementById('reset-pwd-new').value;
        const confirmPwd = document.getElementById('reset-pwd-confirm').value;
        if (!newPwd || !confirmPwd) { showResetPwdError('请填写所有字段'); return; }
        if (newPwd.length < 6) { showResetPwdError('密码长度至少 6 位'); return; }
        if (newPwd !== confirmPwd) { showResetPwdError('两次输入的密码不一致'); return; }

        const btn = document.getElementById('reset-pwd-submit');
        const origText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 提交中...';

        try {
            await ApiClient.resetUserPassword(_resetPwdTargetId, newPwd);
            closeResetPwdModal();
            if (typeof showNotification === 'function') showNotification('密码重置成功', 'success', 3000);
        } catch (err) {
            showResetPwdError(err.message || String(err));
        } finally {
            btn.disabled = false;
            btn.innerHTML = origText;
        }
    }

    // ============ 修改密码弹窗(C/S 模式所有已登录用户) ============

    function openChangePwdModal() {
        const modal = document.getElementById('change-pwd-modal');
        if (!modal) return;
        document.getElementById('change-pwd-old').value = '';
        document.getElementById('change-pwd-new').value = '';
        document.getElementById('change-pwd-confirm').value = '';
        const err = document.getElementById('change-pwd-error');
        if (err) { err.style.display = 'none'; err.textContent = ''; }
        modal.style.display = 'flex';
        setTimeout(() => document.getElementById('change-pwd-old').focus(), 50);
    }

    function closeChangePwdModal() {
        const modal = document.getElementById('change-pwd-modal');
        if (modal) modal.style.display = 'none';
    }

    function showPwdError(msg) {
        const el = document.getElementById('change-pwd-error');
        if (el) { el.textContent = msg; el.style.display = 'block'; }
    }

    async function submitChangePwd() {
        const oldPwd = document.getElementById('change-pwd-old').value;
        const newPwd = document.getElementById('change-pwd-new').value;
        const confirmPwd = document.getElementById('change-pwd-confirm').value;
        if (!oldPwd || !newPwd || !confirmPwd) { showPwdError('请填写所有字段'); return; }
        if (newPwd.length < 6) { showPwdError('新密码长度至少 6 位'); return; }
        if (newPwd !== confirmPwd) { showPwdError('两次输入的新密码不一致'); return; }
        if (newPwd === oldPwd) { showPwdError('新密码不能与旧密码相同'); return; }

        const btn = document.getElementById('change-pwd-submit');
        const origText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 提交中...';

        try {
            await ApiClient.changePassword(oldPwd, newPwd);
            closeChangePwdModal();
            if (typeof showNotification === 'function') showNotification('密码修改成功', 'success', 3000);
        } catch (err) {
            showPwdError(err.message || String(err));
        } finally {
            btn.disabled = false;
            btn.innerHTML = origText;
        }
    }

    document.addEventListener('DOMContentLoaded', function () {
        // 操作日志控件(筛选/刷新/翻页)
        document.getElementById('audit-refresh')?.addEventListener('click', () => renderAuditLog(1));
        document.getElementById('audit-filter')?.addEventListener('change', () => renderAuditLog(1));
        document.getElementById('audit-username')?.addEventListener('keypress', function (e) { if (e.key === 'Enter') renderAuditLog(1); });
        document.getElementById('audit-prev')?.addEventListener('click', () => { if (_auditPage > 1) renderAuditLog(_auditPage - 1); });
        document.getElementById('audit-next')?.addEventListener('click', function () {
            const info = document.getElementById('audit-pageinfo').textContent || '';
            const parts = info.split('/').map(s => parseInt(s.trim(), 10));
            if (parts.length === 2 && parts[0] < parts[1]) renderAuditLog(_auditPage + 1);
        });

        // 重置他人密码弹窗
        const resetModal = document.getElementById('reset-pwd-modal');
        if (resetModal) {
            document.getElementById('reset-pwd-close')?.addEventListener('click', closeResetPwdModal);
            document.getElementById('reset-pwd-cancel')?.addEventListener('click', closeResetPwdModal);
            document.getElementById('reset-pwd-submit')?.addEventListener('click', submitResetPwd);
            resetModal.addEventListener('click', function (e) { if (e.target === resetModal) closeResetPwdModal(); });
            document.getElementById('reset-pwd-new')?.addEventListener('keypress', function (e) { if (e.key === 'Enter') document.getElementById('reset-pwd-confirm').focus(); });
            document.getElementById('reset-pwd-confirm')?.addEventListener('keypress', function (e) { if (e.key === 'Enter') submitResetPwd(); });
        }

        // 修改自己密码弹窗
        const modal = document.getElementById('change-pwd-modal');
        if (modal) {
            document.getElementById('cs-changepwd-btn')?.addEventListener('click', openChangePwdModal);
            document.getElementById('change-pwd-close')?.addEventListener('click', closeChangePwdModal);
            document.getElementById('change-pwd-cancel')?.addEventListener('click', closeChangePwdModal);
            document.getElementById('change-pwd-submit')?.addEventListener('click', submitChangePwd);
            modal.addEventListener('click', function (e) { if (e.target === modal) closeChangePwdModal(); });
            document.getElementById('change-pwd-new')?.addEventListener('keypress', function (e) { if (e.key === 'Enter') document.getElementById('change-pwd-confirm').focus(); });
            document.getElementById('change-pwd-confirm')?.addEventListener('keypress', function (e) { if (e.key === 'Enter') submitChangePwd(); });
        }

        // ============ 设置页: 服务器连接信息 + 本地↔服务器同步 ============
        const card = document.getElementById('cs-server-card');
        if (card && window.connApi) {
            card.style.display = 'block';
            initCsServerCard();
        }
    });

    // 初始化"服务器连接"卡片
    async function initCsServerCard() {
        // 等 ApiClient.user 就绪 (init.js 的 ready() 异步完成)
        for (let i = 0; i < 20 && (typeof ApiClient === 'undefined' || !ApiClient.user); i++) {
            await new Promise(r => setTimeout(r, 100));
        }

        // 1) 读连接配置, 填同步表单默认值 (单机模式下该地址仅用于数据迁移)
        const state = await window.connApi.get();
        const url = (state && state.serverUrl) || '';
        const urlInput = document.getElementById('cs-sync-url');
        if (urlInput && url) urlInput.value = url;

        // 1.5) 运行模式分支: 单机(内嵌)模式下数据在本机, 不显示"已连接远程服务器"
        if (typeof ApiClient !== 'undefined' && ApiClient.embeddedMode === true) {
            const badge = document.getElementById('cs-conn-badge');
            if (badge) {
                badge.innerHTML = '<i class="fas fa-home" style="font-size:11px;"></i> 单机模式';
                badge.style.color = '#1d4ed8';
            }
            document.getElementById('cs-server-url').textContent = '数据保存在本机';
            const nameEl = document.getElementById('cs-server-name');
            if (nameEl) nameEl.textContent = '未连接远程服务器';
            const verEl = document.getElementById('cs-server-version');
            if (verEl) verEl.textContent = '';
            document.getElementById('cs-current-user').textContent = '本地用户 (免登录)';
            const roleEl = document.getElementById('cs-current-role');
            if (roleEl) roleEl.textContent = '';
            return; // 同步表单保留(用于单机↔服务器迁移), 跳过 C/S 的 /api/info 探测
        }

        const infoUrl = url || (typeof ApiClient !== 'undefined' && ApiClient.baseUrl) || '';

        // 2) 显示当前登录用户
        if (typeof ApiClient !== 'undefined' && ApiClient.user) {
            document.getElementById('cs-current-user').textContent = ApiClient.user.username || '—';
            const roleLabel = document.getElementById('cs-current-role');
            if (roleLabel) {
                roleLabel.textContent = ApiClient.getRoleLabel ? ApiClient.getRoleLabel(ApiClient.user.role) : (ApiClient.user.role || '');
            }
        }

        // 3) fetch /api/info 拿服务端名称和版本
        if (infoUrl) {
            document.getElementById('cs-server-url').textContent = infoUrl;
            try {
                const res = await fetch(infoUrl.replace(/\/$/, '') + '/api/info');
                const info = await res.json();
                if (info && info.data) {
                    document.getElementById('cs-server-name').textContent = info.data.name || '固定资产管理系统';
                    document.getElementById('cs-server-version').textContent = info.data.version ? 'v' + info.data.version : '';
                }
            } catch (_) { /* 离线/单机时忽略 */ }
        } else {
            document.getElementById('cs-server-url').textContent = '(单机模式, 无远程服务器)';
        }

        // 4) 同步按钮事件
        document.getElementById('cs-sync-pull')?.addEventListener('click', () => handleSync('pull'));
        document.getElementById('cs-sync-push')?.addEventListener('click', () => handleSync('push'));
    }

    function showSyncResult(type, text) {
        const el = document.getElementById('cs-sync-result');
        if (!el) return;
        el.style.display = 'block';
        el.textContent = text;
        el.style.background = type === 'ok' ? '#ecfdf5' : (type === 'err' ? '#fef2f2' : '#fffbeb');
        el.style.border = '1px solid ' + (type === 'ok' ? '#10b981' : (type === 'err' ? '#ef4444' : '#f59e0b'));
        el.style.color = type === 'ok' ? '#065f46' : (type === 'err' ? '#991b1b' : '#92400e');
    }

    function handleSync(dir) {
        const url = (document.getElementById('cs-sync-url').value || '').trim();
        const username = (document.getElementById('cs-sync-user').value || '').trim();
        const password = document.getElementById('cs-sync-pwd').value || '';
        if (!/^https?:\/\//i.test(url)) { showSyncResult('err', '请填写有效的服务器地址(如 http://192.168.40.251:3456)'); return; }
        if (!username || !password) { showSyncResult('err', '请填写服务器用户名和密码'); return; }

        const confirmMsg = dir === 'pull'
            ? '将从 ' + url + ' 拉取全部资产与自定义选项数据到本地 data/ 目录。\n本地原有数据将被覆盖（仅覆盖 7 个数据键，个人设置不受影响）。\n\n确定继续吗？'
            : '⚠ 警告：推送将覆盖服务端数据\n\n将把本地 data/ 目录中的全部资产与自定义选项数据推送到 ' + url + '。\n服务端原有资产数据将被全量替换。\n此操作不可撤销，确定继续吗？';
        if (!confirm(confirmMsg)) return;

        const btnPull = document.getElementById('cs-sync-pull');
        const btnPush = document.getElementById('cs-sync-push');
        btnPull.disabled = true; btnPush.disabled = true;
        showSyncResult('', dir === 'pull' ? '正在从服务端拉取数据...' : '正在向服务端推送数据...');

        const fn = dir === 'pull' ? window.connApi.syncPull : window.connApi.syncPush;
        fn({ url, username, password }).then(function (r) {
            btnPull.disabled = false; btnPush.disabled = false;
            if (r.ok) {
                const header = dir === 'pull' ? '✓ 拉取成功' : '✓ 推送成功';
                const list = dir === 'pull' ? r.pulled : r.pushed;
                const lines = [header];
                if (r.serverInfo && r.serverInfo.name) lines.push('服务端: ' + r.serverInfo.name + ' v' + (r.serverInfo.version || ''));
                lines.push((dir === 'pull' ? '同步' : '推送') + '资产数: ' + r.totalAssets);
                if (list) Object.keys(list).forEach(function (k) { lines.push('  ' + k + ': ' + list[k] + ' 条'); });
                if (!list || Object.keys(list).length === 0) lines.push('  (本地无数据，已跳过所有键)');
                showSyncResult('ok', lines.join('\n'));
            } else {
                const errs = r.errors && r.errors.length ? '\n详细: ' + r.errors.join('\n      ') : '';
                showSyncResult('err', '× ' + (r.message || '同步失败') + errs);
            }
        }).catch(function (e) {
            btnPull.disabled = false; btnPush.disabled = false;
            showSyncResult('err', '× 同步失败: ' + (e && e.message || e));
        });
    }
})();
