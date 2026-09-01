/**
 * C/S 架构 API 客户端
 *
 * 职责:
 *  1. CS 模式探测: 通过 GET /api/info 的 cs 标识判断当前是否为多人 C/S 服务端
 *  2. 登录凭证管理: JWT 存储于 localStorage('cs_auth'), 全局唯一注入点
 *  3. 统一请求封装: 自动携带 Authorization: Bearer, 401 自动跳转登录页
 *  4. 资产 REST 封装: 新增/更新(乐观锁)/删除/批量导入/全量读取/服务端统计
 *  5. 多人更新轮询: 定期比对 /api/data-version 指纹, 变化时回调提示刷新
 *
 * 加载顺序: 必须在 js/storage.js 之前引入(index.html 已保证)
 */
const ApiClient = {
    token: null,
    user: null,
    csMode: false,          // 是否为 C/S 多人模式(服务端 /api/info cs=true)
    embeddedMode: false,   // Electron 单机内嵌服务(/api/info embedded=true), 免密单机
    localMode: false,      // 纯本地模式(file:// 且无 cs_server_url)
    baseURL: '',           // file:// 下选 C/S 时为远端地址(http://host:port), 其余场景为空(同源相对)
    _readyPromise: null,
    _redirecting: false,    // 防止 401 重复跳转
    _stamp: null,           // 数据变更指纹基线
    _pollTimer: null,
    _suppressUntil: 0,      // 本端写入后短暂抑制"他人更新"误报

    /** 角色中文映射(数据库三角色, UI 合并显示: editor/viewer 统称普通用户) */
    ROLE_NAMES: { admin: '管理员', editor: '普通用户', viewer: '普通用户' },

    init() {
        try {
            const raw = localStorage.getItem('cs_auth');
            if (raw) {
                const auth = JSON.parse(raw);
                this.token = (auth && auth.token) || null;
                this.user = (auth && auth.user) || null;
            }
        } catch (e) { /* 忽略损坏的凭证 */ }
        this._readyPromise = this._detect();
        return this._readyPromise;
    },

    /** 探测当前运行模式; 返回 Promise<boolean>(是否 cs 模式)
     *  优先级: embedded(Electron 单机内嵌) > cs(远端 C/S) > local(纯本地) */
    async _detect() {
        if (typeof window === 'undefined') return false;
        const proto = window.location.protocol;

        // file:// 协议: 浏览器直接打开 index.html
        if (proto === 'file:') {
            let remoteUrl = '';
            try { remoteUrl = localStorage.getItem('cs_server_url') || ''; } catch (e) {}
            if (!remoteUrl) { this.localMode = true; return false; }
            // 用户已选 C/S 并保存了服务器地址: 探测远端
            this.baseURL = remoteUrl.replace(/\/+$/, '');
            try {
                const resp = await fetch(this.baseURL + '/api/info', { method: 'GET' });
                if (resp.ok) {
                    const info = await resp.json().catch(() => null);
                    this.csMode = !!(info && info.cs === true);
                    if (this.csMode) {
                        window.__CS_MODE__ = true;
                        if (typeof Logger !== 'undefined') Logger.info('ApiClient', 'file:// 已配置远端 C/S 服务端: ' + this.baseURL);
                    }
                    return this.csMode;
                }
            } catch (e) { /* 远端不可达, 回退本地 */ }
            this.localMode = true;
            return false;
        }

        // http(s):// 协议: 同源(可能是远端服务端 或 Electron 单机内嵌)
        try {
            const resp = await fetch('/api/info', { method: 'GET' });
            if (resp.ok) {
                const info = await resp.json().catch(() => null);
                this.embeddedMode = !!(info && info.embedded === true);  // Electron 单机内嵌
                this.csMode = !!(info && info.cs === true);                // 远端 C/S 服务端
                if (this.csMode && typeof window !== 'undefined') {
                    window.__CS_MODE__ = true;
                    if (typeof Logger !== 'undefined') Logger.info('ApiClient', '已连接 C/S 服务端(登录模式)');
                }
                if (this.embeddedMode && typeof Logger !== 'undefined') Logger.info('ApiClient', 'Electron 单机内嵌服务(免密模式)');
                return this.csMode;
            }
        } catch (e) { /* 非 C/S 环境 */ }
        return false;
    },

    /** 请求 URL 前缀: file:// 下选 C/S 时为远端地址, 其余为空(同源相对) */
    _baseUrl() { return this.baseURL || ''; },

    /** 等待探测完成 */
    ready() { return this._readyPromise || Promise.resolve(false); },

    isLoggedIn() { return !!this.token; },

    _saveAuth() {
        try {
            localStorage.setItem('cs_auth', JSON.stringify({ token: this.token, user: this.user }));
        } catch (e) { /* 隐私模式等场景忽略 */ }
    },

    /**
     * 统一请求方法
     * @returns Promise<any> 成功时返回 data(统一格式)或裸 payload(compat 格式)
     * @throws Error { message, code } code 为服务端业务码(40901=乐观锁冲突, 40900=冲突...)
     */
    async request(method, url, body) {
        const headers = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (this.token) headers['Authorization'] = 'Bearer ' + this.token;

        let resp;
        try {
            resp = await fetch(this._baseUrl() + url, {
                method,
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
            });
        } catch (e) {
            const err = new Error('无法连接服务器，请检查服务是否已启动');
            err.code = -1;
            throw err;
        }

        if (resp.status === 401) {
            this._handleUnauthorized();
            const err = new Error('登录已过期，请重新登录');
            err.code = 40100;
            throw err;
        }

        let payload = null;
        try { payload = await resp.json(); } catch (e) { /* 非 JSON 响应 */ }

        if (!resp.ok) {
            const err = new Error((payload && payload.message) || ('请求失败: HTTP ' + resp.status));
            err.code = payload && payload.code;
            throw err;
        }

        // 统一格式 {code, message, data} 或兼容层裸格式 {success, ...}
        if (payload && typeof payload === 'object' && 'code' in payload) {
            if (payload.code !== 0) {
                const err = new Error(payload.message || '请求失败');
                err.code = payload.code;
                throw err;
            }
            return payload.data;
        }
        return payload;
    },

    /** 401 处理: 清凭证 → 跳转登录页 */
    _handleUnauthorized() {
        if (this._redirecting) return;
        this._redirecting = true;
        this.token = null;
        this.user = null;
        try { localStorage.removeItem('cs_auth'); } catch (e) {}
        if (!/login\.html$/i.test(window.location.pathname)) {
            alert('登录已过期或尚未登录，即将跳转到登录页');
            window.location.href = 'login.html';
        }
    },

    // ============ 认证 ============

    /** 登录: 成功后凭证持久化 */
    async login(username, password) {
        const data = await this.request('POST', '/api/auth/login', { username, password });
        this.token = data.token;
        this.user = data.user;
        this._saveAuth();
        return data.user;
    },

    /** 退出登录: 清凭证并回登录页 */
    logout() {
        this.token = null;
        this.user = null;
        try { localStorage.removeItem('cs_auth'); } catch (e) {}
        window.location.href = 'login.html';
    },

    /** 修改自己的密码(需登录, 旧密码验证) */
    changePassword(oldPassword, newPassword) {
        return this.request('POST', '/api/auth/change-password', { oldPassword, newPassword });
    },

    // ============ 用户管理(admin) ============

    /** 用户列表(admin) */
    getUsers() { return this.request('GET', '/api/users'); },

    /** 新建用户(admin) { username, password, role } */
    createUser(user) { return this.request('POST', '/api/users', user); },

    /** 删除用户(admin) */
    deleteUser(id) { return this.request('DELETE', '/api/users/' + encodeURIComponent(id)); },

    /** 重置他人密码 / 改角色(admin) { password?, role? } */
    resetUserPassword(id, password) {
        return this.request('PATCH', '/api/users/' + encodeURIComponent(id), { password });
    },

    /** 修改用户角色(admin) */
    updateUserRole(id, role) {
        return this.request('PATCH', '/api/users/' + encodeURIComponent(id), { role });
    },

    /** 角色中文标签(admin=管理员, editor/viewer=普通用户) */
    getRoleLabel(role) { return this.ROLE_NAMES[role] || '普通用户'; },

    // ============ 资产 REST ============

    /** 新增资产(服务端校验+编号唯一), 返回含 version 的完整文档 */
    createAsset(doc) { return this.request('POST', '/api/assets', doc); },

    /** 更新资产(乐观锁: doc.version 不匹配时服务端抛 40901) */
    updateAsset(id, doc) { return this.request('PUT', '/api/assets/' + encodeURIComponent(id), doc); },

    /** 删除资产(级联维保记录/附件) */
    deleteAsset(id) { return this.request('DELETE', '/api/assets/' + encodeURIComponent(id)); },

    /** 资产详情 */
    getAsset(id) { return this.request('GET', '/api/assets/' + encodeURIComponent(id)); },

    /** 全量资产(导出/导出Excel用, 含维保记录与附件) */
    allAssets() { return this.request('GET', '/api/assets/all'); },

    /**
     * 批量导入(服务端单事务: 全部成功或全部回滚)
     * @param {Array} docs 资产文档数组
     * @param {'merge'|'replace'} mode merge=按编号upsert, replace=清空后导入
     * @returns {inserted, updated, mode, total}
     */
    batchImport(docs, mode = 'merge') { return this.request('POST', '/api/assets/batch', { assets: docs, mode }); },

    /** 服务端聚合统计(/api/stats/summary) */
    statsSummary() { return this.request('GET', '/api/stats/summary'); },

    /** 从服务器重新拉取全部资产并刷新内存 assetsData */
    async reloadAssetsData() {
        const docs = await this.allAssets();
        if (typeof State !== 'undefined' && typeof State.setAssetsData === 'function') {
            State.setAssetsData(docs);
        } else {
            assetsData = docs || [];
        }
        return docs;
    },

    // ============ 多人更新轮询 ============

    /**
     * 启动数据版本轮询(30秒), 远端变化时回调 onRemoteUpdate
     * @param {Function} onRemoteUpdate
     */
    startVersionPolling(onRemoteUpdate) {
        if (!this.csMode || this._pollTimer) return;
        const cb = typeof onRemoteUpdate === 'function' ? onRemoteUpdate : null;

        const poll = async () => {
            try {
                const r = await this.request('GET', '/api/data-version');
                const stamp = r && r.stamp;
                if (typeof stamp !== 'string') return;
                if (this._stamp === null) { this._stamp = stamp; return; } // 首次建立基线
                if (stamp === this._stamp) return;
                this._stamp = stamp;
                if (Date.now() < this._suppressUntil) return;   // 本端写入引起的指纹变化
                if (cb) cb();
            } catch (e) { /* 网络抖动/登录过期等, 下轮再试 */ }
        };

        poll().finally(() => {
            this._pollTimer = setInterval(poll, 30000);
        });
    },

    /** 本端写入成功后调用: 刷新基线并短暂抑制误报 */
    markLocalChange() {
        if (!this.csMode) return;
        this._suppressUntil = Date.now() + 8000;
        this.request('GET', '/api/data-version')
            .then(r => { this._stamp = (r && r.stamp) || this._stamp; })
            .catch(() => {});
    },
};

ApiClient.init();
