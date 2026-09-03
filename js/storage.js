/**
 * 数据存储管理器 - 支持无服务器模式（file:// 直接打开）
 *
 * 存储架构：
 * 1. 服务器模式 (fileApiReady=true): 通过后端 API 读写 JSON 文件
 * 2. 本地直接打开模式 (file://):
 *    - 首次加载: 通过 <script> 标签加载 data/*.js（JSONP 风格，赋值到 window.__LOCAL_DATA__）
 *    - 运行时缓存: IndexedDB + localStorage
 *    - 持久化保存:
 *      a) File System Access API（Chrome/Edge 86+，授权后自动写入 data/*.js）
 *      b) 降级方案: 触发下载 .js 文件，用户手动覆盖原文件
 */
class FileStorageManager {
    constructor() {
        this.isBrowser = typeof window !== 'undefined';
        this.dataVersion = '2.0.0';
        this.maxBackupCount = 5;

        // 存储模式
        this.fileApiReady = false;      // 服务器 API 可用
        this.csMode = false;            // C/S 多人模式(新服务端, /api/info cs=true, 需登录+JWT)
        this.indexedDBClient = null;     // IndexedDB 实例
        this.fileSystemHandle = null;    // File System Access API 目录句柄
        this.dataDirHandle = null;       // data 子目录句柄
        this.isLocalMode = false;        // 是否为本地模式
        this.isFileSyncEnabled = false;  // 文件同步是否已启用（用户已授权）

        // 文件监听（轮询检测外部修改）
        this._fileWatchTimer = null;     // 轮询定时器
        this._fileWatchInterval = 5000;  // 轮询间隔（5秒，降低CPU占用）
        this._fileLastModified = {};     // 各文件最后修改时间戳 { key: lastModified }
        this._fileWatchCallbacks = [];   // 文件变化回调函数列表
        this._isCheckingFiles = false;   // 防止并发检查

        // 文件监听防误报：内部写入期间禁止触发 onFileChange 通知
        this._suppressWatchNotification = false;

        // 初始化
        if (this.isBrowser) {
            this._initStorage();
        }
    }

    async _initStorage() {
        // 使用 _initPromise 确保完整初始化流程在 getItem/setItem 之前完成
        this._initPromise = (async () => {
            // 0. 优先从 <script> 标签加载的 window.__LOCAL_DATA__ 读取数据（file:// 模式）
            this._loadFromScriptTags();

            // 1. 检测服务器 API（仅 http:// 协议下有意义）
            this._apiDetectPromise = this._detectServerApi();
            try {
                await this._apiDetectPromise;
            } catch(e) {}

            // 2. 如果服务器不可用，切换到本地模式
            if (!this.fileApiReady) {
                this.isLocalMode = true;
                Logger.info('Storage', '切换到本地存储模式 (无服务器/file://)');

                // 初始化 IndexedDB
                await this._initIndexedDB();

                // 尝试恢复 File System Access API 句柄（用于自动保存到 .js 文件）
                const restored = await this._restoreFileSystemAccess();

                // 将 window.__LOCAL_DATA__ 中的数据迁移到 IndexedDB（首次加载）
                await this._migrateScriptDataToIndexedDB();
            }

            // 初始化完成后刷新UI状态
            if (typeof updateFileSyncStatus === 'function') {
                updateFileSyncStatus();
            }
        })();
        return this._initPromise;
    }

    // ============ <script> 标签数据加载（file:// 模式核心） ============

    /**
     * 从 window.__LOCAL_DATA__ 读取数据（由 data/*.js 文件通过 <script> 标签注入）
     * file:// 协议下 fetch() 无法读取本地文件，所以用 <script> 标签加载 .js 文件
     */
    _loadFromScriptTags() {
        if (!this.isBrowser) return;
        if (typeof window.__LOCAL_DATA__ === 'undefined') {
            Logger.info('Storage', 'window.__LOCAL_DATA__ 不存在（可能通过服务器模式加载）');
            return;
        }

        const keys = Object.values(STORAGE_KEYS);
        let loadedCount = 0;
        for (const key of keys) {
            if (window.__LOCAL_DATA__[key] !== undefined && window.__LOCAL_DATA__[key] !== null) {
                loadedCount++;
                Logger.debug('Storage', `从 <script> 标签加载数据: ${key}`);
            }
        }
        Logger.info('Storage', `从 window.__LOCAL_DATA__ 加载了 ${loadedCount} 个数据键`);
    }

    /**
     * 将 window.__LOCAL_DATA__ 中的数据迁移到 IndexedDB（仅首次加载时）
     * 这样后续读取可以从 IndexedDB 获取，保持数据一致性
     */
    async _migrateScriptDataToIndexedDB() {
        if (!this.indexedDBClient) return;
        if (typeof window.__LOCAL_DATA__ === 'undefined') return;

        for (const key of Object.values(STORAGE_KEYS)) {
            const scriptData = window.__LOCAL_DATA__[key];
            if (scriptData === undefined || scriptData === null) continue;

            // 仅当 IndexedDB 中没有该数据时才迁移
            const idbData = await this._loadFromIndexedDB(key);
            if (idbData === null) {
                await this._saveToIndexedDB(key, scriptData);
                Logger.info('Storage', `从 <script> 标签迁移数据到 IndexedDB: ${key}`);
            }
        }
    }

    async _detectServerApi() {
        // file:// 协议: 复用 ApiClient 的探测结果(避免双源不一致)
        //   - 用户选过 C/S 且保存了 cs_server_url → ApiClient.csMode=true, 此处同步
        //   - 否则 → 本地模式
        if (window.location.protocol === 'file:') {
            if (typeof ApiClient !== 'undefined' && ApiClient.csMode) {
                this.fileApiReady = true;
                this.csMode = true;
                Logger.info('Storage', 'file:// 已配置远端 C/S 服务端: ' + (ApiClient.baseURL || ''));
                return;
            }
            this.fileApiReady = false;
            this.csMode = false;
            Logger.info('Storage', 'file:// 协议，使用本地模式');
            return;
        }
        // http(s):// 协议: 优先复用 ApiClient 探测结果(同源, ApiClient 已探测 /api/info)
        if (typeof ApiClient !== 'undefined') {
            // ApiClient 已 await ready() 完成(_detect 在 init 时跑过), 直接读结果
            if (ApiClient.embeddedMode || ApiClient.csMode) {
                this.fileApiReady = true;
                this.csMode = !!ApiClient.csMode;
                Logger.info('Storage', ApiClient.csMode ? '已连接 C/S 服务端(登录模式)' : '服务器 API 已连接(Electron 内嵌服务模式)');
                return;
            }
        }
        // 回退: 独立探测(ApiClient 不可用或探测失败时)
        try {
            const resp = await fetch('/api/info', { method: 'GET' });
            if (resp.ok) {
                const info = await resp.json().catch(() => null);
                this.fileApiReady = true;
                if (info && info.cs === true) {
                    this.csMode = true;
                    Logger.info('Storage', '已连接 C/S 服务端(登录模式)');
                    return;
                }
                Logger.info('Storage', '服务器 API 已连接(Electron 内嵌服务模式)');
                return;
            }
        } catch (e) { /* 继续尝试旧探测 */ }
        // 兼容旧探测方式(Electron 旧内嵌服务可能无 /api/info)
        try {
            const resp = await fetch('/api/list', { method: 'GET' });
            if (resp.ok) {
                this.fileApiReady = true;
                Logger.info('Storage', '服务器 API 已连接');
                return;
            }
        } catch (e) {}
        this.fileApiReady = false;
        Logger.info('Storage', '服务器不可用，使用本地模式');
    }

    // ============ IndexedDB 实现 ============

    async _initIndexedDB() {
        return new Promise((resolve) => {
            const request = indexedDB.open('AssetManagementDB', 2);
            
            request.onerror = () => {
                Logger.error('Storage', 'IndexedDB 打开失败');
                resolve();
            };

            request.onsuccess = () => {
                this.indexedDBClient = request.result;
                Logger.info('Storage', 'IndexedDB 已初始化');
                resolve();
            };

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('data')) {
                    db.createObjectStore('data', { keyPath: 'key' });
                }
            };
        });
    }

    async _saveToIndexedDB(key, data) {
        if (!this.indexedDBClient) return false;
        
        return new Promise((resolve) => {
            const tx = this.indexedDBClient.transaction(['data'], 'readwrite');
            const store = tx.objectStore('data');
            
            const record = {
                key: key,
                data: data,
                version: this.dataVersion,
                timestamp: Date.now()
            };
            
            store.put(record);
            
            tx.oncomplete = () => {
                Logger.debug('Storage', `IndexedDB 保存成功: ${key}`);
                resolve(true);
            };
            
            tx.onerror = () => {
                Logger.error('Storage', `IndexedDB 保存失败: ${key}`);
                resolve(false);
            };
        });
    }

    async _loadFromIndexedDB(key) {
        if (!this.indexedDBClient) return null;
        
        return new Promise((resolve) => {
            const tx = this.indexedDBClient.transaction(['data'], 'readonly');
            const store = tx.objectStore('data');
            const request = store.get(key);
            
            request.onsuccess = () => {
                const record = request.result;
                if (record && record.data) {
                    Logger.debug('Storage', `IndexedDB 加载成功: ${key}`);
                    resolve(record.data);
                } else {
                    resolve(null);
                }
            };
            
            request.onerror = () => {
                resolve(null);
            };
        });
    }

    // ============ File System Access API 实现 ============

    async _restoreFileSystemAccess() {
        if (!('showDirectoryPicker' in window)) {
            Logger.info('Storage', '浏览器不支持 File System Access API');
            return false;
        }

        try {
            // 先检查是否用户主动断开过，如是则不自动恢复（尊重用户手动操作）
            // IndexedDB + localStorage 双源检查（localStorage 是同步的，立即生效）
            const lsRaw = localStorage.getItem('asset:manual_disconnect');
            if (lsRaw) {
                try {
                    const lsMarker = JSON.parse(lsRaw);
                    if (lsMarker && lsMarker.value === true) {
                        Logger.info('Storage', '检测到localStorage手动断开标记，跳过自动恢复数据文件夹连接');
                        return false;
                    }
                } catch(e) {}
            }
            const manualDisconnect = await this._loadFromIndexedDB('__manual_disconnect__');
            if (manualDisconnect && manualDisconnect.value === true) {
                Logger.info('Storage', '检测到IndexedDB手动断开标记，跳过自动恢复数据文件夹连接');
                return false;
            }

            const handle = await this._getDirectoryHandle();
            if (handle) {
                // 页面加载时只能静默恢复（无用户手势，无法调用 requestPermission）
                // 仅检查权限状态，权限已授予则直接恢复
                let permission = 'prompt';
                if (handle.queryPermission) {
                    permission = await handle.queryPermission({ mode: 'readwrite' });
                }
                if (permission !== 'granted') {
                    Logger.info('Storage', '已保存的文件夹权限未授予（状态: ' + permission + '），等待用户点击重新授权');
                    return false;
                }

                this.fileSystemHandle = handle;

                // 定位 data 目录（复用公共方法）
                await this._resolveDataDirHandle(handle);

                this.isFileSyncEnabled = true;
                Logger.info('Storage', '已自动恢复数据文件夹，文件同步已启用');

                // 同步一致性检查（必须在 _startFileWatch 之前完成，防止文件监听误报）
                this._suppressWatchNotification = true;
                await this._ensureFileSyncConsistency().catch(e => {});
                this._startFileWatch();
                this._suppressWatchNotification = false;

                // 恢复成功后刷新UI状态
                if (typeof updateFileSyncStatus === 'function') {
                    updateFileSyncStatus();
                }
                return true;
            }
            return false;
        } catch (e) {
            Logger.info('Storage', '需要重新授权数据文件夹访问: ' + (e?.message || e?.name || e));
            return false;
        }
    }

    /**
     * 一致性检查：遍历核心数据键，如果 IndexedDB 的数据量比 .js 文件大，
     * 立即把 IndexedDB 数据写入 .js 文件，防止下次刷新时丢失数据。
     */
    async _ensureFileSyncConsistency() {
        if (!this.isFileSyncEnabled || !this.dataDirHandle) return;

        const coreKeys = [
            'assetManagementData',
            'userStateData',
            'systemSettings',
            'categoryOptions',
            'printRecords',
            'labelPrintRecords',
            // 自定义下拉选项（跨浏览器同步）
            'custom_options_owner',
            'custom_options_type',
            'custom_options_department',
            'custom_options_owner_deleted',
            'custom_options_type_deleted',
            'custom_options_department_deleted'
        ];

        let repaired = 0;
        for (const key of coreKeys) {
            try {
                const idbData = await this._loadFromIndexedDB(key);
                if (idbData === null || idbData === undefined) continue;

                const scriptData = (typeof window.__LOCAL_DATA__ !== 'undefined') ? window.__LOCAL_DATA__[key] : undefined;

                function sizeOf(d) {
                    if (Array.isArray(d)) return d.length;
                    if (d && typeof d === 'object') return Object.keys(d).length;
                    if (d != null) return 1;
                    return 0;
                }
                const idbSize = sizeOf(idbData);
                const scriptSize = sizeOf(scriptData);

                if (idbSize > scriptSize) {
                    // IndexedDB 有更多数据，补写回文件
                    const ok = await this._saveToScriptFile(key, idbData);
                    if (ok) {
                        await this._saveToIndexedDB(`__ts_${key}__`, Date.now());
                        Logger.info('Storage', `[一致性修复] ${key}: IndexedDB(${idbSize}) > 文件(${scriptSize})，已补写文件`);
                        repaired++;
                    }
                }
            } catch(e) {
                Logger.warn('Storage', `一致性检查失败 ${key}:`, e);
            }
        }
        if (repaired > 0) {
            Logger.info('Storage', `一致性检查完成：修复 ${repaired} 个数据`);
        }
    }

    async _getDirectoryHandle() {
        if (!this.indexedDBClient) return null;

        return new Promise((resolve) => {
            const tx = this.indexedDBClient.transaction(['data'], 'readonly');
            const store = tx.objectStore('data');
            const request = store.get('__dir_handle__');

            request.onsuccess = () => {
                const record = request.result;
                if (record && record.data && record.data.handle) {
                    resolve(record.data.handle);
                } else if (record && record.handle) {
                    resolve(record.handle);
                } else {
                    resolve(null);
                }
            };

            request.onerror = () => resolve(null);
        });
    }

    async connectDataFolder() {
        if (!('showDirectoryPicker' in window)) {
            alert('当前浏览器不支持文件系统访问功能。\n建议使用 Chrome 86+ 或 Edge 86+。\n\n如果不支持，系统仍可正常运行，但保存数据时需要手动下载文件覆盖原数据文件。');
            return false;
        }

        try {
            // 先清理手动断开标记（用户明确要求连接，必须允许）
            try {
                await this._saveToIndexedDB('__manual_disconnect__', { value: false, updatedAt: Date.now() });
            } catch(e) { /* ignore */ }

            // ===== 第一步：尝试静默恢复已保存的目录句柄（无需弹窗选择） =====
            const savedHandle = await this._getDirectoryHandle();
            if (savedHandle) {
                // 尝试静默请求权限
                let permission = 'prompt';
                if (savedHandle.queryPermission) {
                    permission = await savedHandle.queryPermission({ mode: 'readwrite' });
                }
                if (permission !== 'granted' && savedHandle.requestPermission) {
                    permission = await savedHandle.requestPermission({ mode: 'readwrite' });
                }

                if (permission === 'granted') {
                    // 权限已获取，直接使用已保存的句柄
                    this.fileSystemHandle = savedHandle;
                    Logger.info('Storage', '自动恢复已保存的数据文件夹（无需手动选择）');

                    // 定位 data 目录（兼容直接选了 data 或选了根目录的情况）
                    await this._resolveDataDirHandle(savedHandle);

                    this.isFileSyncEnabled = true;

                    // 同步 IndexedDB → .js 文件
                    this._suppressWatchNotification = true;
                    const syncedCount = await this._syncIndexedDBToFiles();

                    // 启动文件轮询
                    this._startFileWatch();
                    this._suppressWatchNotification = false;

                    Logger.info('Storage', '数据文件夹已自动连接，文件同步已启用');

                    // 更新UI状态
                    if (typeof updateFileSyncStatus === 'function') {
                        updateFileSyncStatus();
                    }
                    return true;
                }
                // 权限被拒绝，继续走手动选择流程
                Logger.info('Storage', '已保存的文件夹权限已失效，需要重新选择');
            }

            // ===== 第二步：首次使用或权限失效，弹窗选择（仅此一次） =====
            const dirHandle = await window.showDirectoryPicker({
                mode: 'readwrite',
                startIn: 'desktop'
            });

            // 保存目录句柄到 IndexedDB（后续不再需要手动选择）
            await this._saveToIndexedDB('__dir_handle__', {
                handle: dirHandle,
                savedAt: Date.now()
            });

            this.fileSystemHandle = dirHandle;

            // 定位 data 目录
            await this._resolveDataDirHandle(dirHandle);

            this.isFileSyncEnabled = true;

            // 同步 IndexedDB → .js 文件
            this._suppressWatchNotification = true;
            const syncedCount = await this._syncIndexedDBToFiles();

            const infoMsg = syncedCount > 0
                ? `\n\n已将浏览器中现有的 ${syncedCount} 项数据同步到 data/*.js 文件。`
                : '';
            // 使用 Toast 通知替代阻塞式 alert
            if (typeof showNotification === 'function') {
                showNotification('✅ 数据文件夹已连接！数据将自动保存到 data/*.js 文件。' + infoMsg, 'success', 5000);
            } else {
                alert('✅ 数据文件夹已连接！' + infoMsg);
            }

            Logger.info('Storage', '数据文件夹已连接，文件同步已启用');

            // 启动文件轮询监听
            this._startFileWatch();
            this._suppressWatchNotification = false;

            // 更新UI状态
            if (typeof updateFileSyncStatus === 'function') {
                updateFileSyncStatus();
            }
            return true;
        } catch (e) {
            if (e.name !== 'AbortError') {
                Logger.error('Storage', '连接文件夹失败:', e);
                alert('连接文件夹失败: ' + e.message);
            }
            return false;
        }
    }

    /**
     * 手动断开数据文件夹（用户主动操作）
     * - 设置手动断开标记，下次初始化时不会自动恢复连接
     * - 清理内存中的句柄和状态，停止文件监听
     * - 保留 IndexedDB 中的 __dir_handle__，用户再次点击"连接"可无弹窗直接恢复授权
     * @returns {Promise<boolean>} 是否断开成功
     */
    async disconnectDataFolder() {
        try {
            // 1. 写入手动断开标记（IndexedDB + localStorage 双写，保证刷新后仍生效）
            const marker = { value: true, disconnectedAt: Date.now() };
            try {
                await this._saveToIndexedDB('__manual_disconnect__', marker);
            } catch(e) { Logger.warn('Storage', '写入手动断开标记到IndexedDB失败:', e); }
            try {
                localStorage.setItem('asset:manual_disconnect', JSON.stringify(marker));
            } catch(e) { Logger.warn('Storage', '写入手动断开标记到localStorage失败:', e); }

            // 2. 两段式状态机：先设置状态，再释放资源
            //    保持对象引用直到所有依赖读取完毕（避免竞态）
            this.isFileSyncEnabled = false;

            // 3. 停止文件轮询
            this._stopFileWatch();

            // 4. 清理引用（最后一步）
            this.fileSystemHandle = null;
            this.dataDirHandle = null;

            Logger.info('Storage', '用户已手动断开数据文件夹连接');

            // 更新UI状态
            if (typeof updateFileSyncStatus === 'function') {
                updateFileSyncStatus();
            }
            return true;
        } catch (e) {
            Logger.error('Storage', '断开数据文件夹失败:', e);
            return false;
        }
    }

    /**
     * 定位 data 目录句柄（兼容用户选了 data 目录或项目根目录）
     */
    async _resolveDataDirHandle(dirHandle) {
        // 检查所选目录是否直接包含 .js 文件（说明选的就是 data 目录）
        let selectedAsDataDir = false;
        try {
            const testHandle = await dirHandle.getFileHandle('assetManagementData.js');
            if (testHandle) selectedAsDataDir = true;
        } catch(e) {}

        if (selectedAsDataDir) {
            this.dataDirHandle = dirHandle;
            Logger.info('Storage', '已定位 data 目录（直接选择）');
        } else {
            try {
                this.dataDirHandle = await dirHandle.getDirectoryHandle('data', { create: true });
                Logger.info('Storage', '已定位 data 子目录');
            } catch(e) {
                this.dataDirHandle = dirHandle;
                Logger.info('Storage', '使用所选目录作为数据目录');
            }
        }
    }

    /**
     * 将 IndexedDB 中的核心数据同步写入 .js 文件
     * @returns {Promise<number>} 已同步的数据项数量
     */
    async _syncIndexedDBToFiles() {
        Logger.info('Storage', '开始同步 IndexedDB → .js 文件 ...');
        const coreKeys = this._getWatchKeys();
        let syncedCount = 0;
        for (const key of coreKeys) {
            const idbData = await this._loadFromIndexedDB(key);
            if (idbData !== null && typeof idbData !== 'undefined') {
                const ok = await this._saveToScriptFile(key, idbData);
                if (ok) syncedCount++;
                await this._saveToIndexedDB(`__ts_${key}__`, Date.now());
            } else if (typeof window.__LOCAL_DATA__ !== 'undefined' && window.__LOCAL_DATA__[key] !== undefined) {
                await this._saveToIndexedDB(key, window.__LOCAL_DATA__[key]);
                await this._saveToIndexedDB(`__ts_${key}__`, Date.now());
            }
        }
        Logger.info('Storage', `同步完成：${syncedCount} 个核心数据已写入 .js 文件`);
        return syncedCount;
    }

    /**
     * 保存数据到 .js 文件（File System Access API）
     * 文件格式：window.__LOCAL_DATA__ = window.__LOCAL_DATA__ || {}; window.__LOCAL_DATA__.key = ...;
     */

    // ============ 文件监听（轮询检测外部修改） ============

    /**
     * 启动文件轮询监听
     * 定期检查 data/*.js 文件的修改时间，发现变化时触发回调
     */
    _startFileWatch() {
        this._stopFileWatch();  // 先停止已有的监听

        if (!this.dataDirHandle) return;

        // 初始化各文件的修改时间记录
        this._initFileTimestamps().then(() => {
            this._fileWatchTimer = setInterval(() => {
                this._checkFileChanges();
            }, this._fileWatchInterval);
            Logger.info('Storage', `文件监听已启动（每 ${this._fileWatchInterval / 1000} 秒检查一次）`);
        });
    }

    /**
     * 停止文件轮询监听
     */
    _stopFileWatch() {
        if (this._fileWatchTimer) {
            clearInterval(this._fileWatchTimer);
            this._fileWatchTimer = null;
            Logger.info('Storage', '文件监听已停止');
        }
    }

    /**
     * 初始化各 .js 文件的修改时间戳
     */
    async _initFileTimestamps() {
        const coreKeys = this._getWatchKeys();
        for (const key of coreKeys) {
            try {
                const fileName = `${key}.js`;
                const fileHandle = await this.dataDirHandle.getFileHandle(fileName);
                const file = await fileHandle.getFile();
                this._fileLastModified[key] = file.lastModified;
            } catch(e) {
                // 文件不存在
            }
        }
    }

    /**
     * 检查文件是否有变化（被其他浏览器/程序修改）
     */
    async _checkFileChanges() {
        if (this._isCheckingFiles || !this.dataDirHandle) return;
        this._isCheckingFiles = true;

        try {
            const coreKeys = this._getWatchKeys();
            const changedKeys = [];

            for (const key of coreKeys) {
                try {
                    const fileName = `${key}.js`;
                    const fileHandle = await this.dataDirHandle.getFileHandle(fileName);
                    const file = await fileHandle.getFile();
                    const lastMod = file.lastModified;
                    const knownMod = this._fileLastModified[key] || 0;

                    if (lastMod > knownMod) {
                        // 文件被修改了！
                        Logger.info('Storage', `[文件监听] 检测到 ${key}.js 已变化 (修改时间: ${new Date(lastMod).toLocaleString()})`);

                        // 读取文件内容
                        const text = await file.text();
                        const match = text.match(new RegExp(`window\\.__LOCAL_DATA__\\.${key}\\s*=\\s*([\\s\\S]+?);\\s*$`, 'm'));
                        if (match) {
                            try {
                                const newData = JSON.parse(match[1]);
                                // 更新 IndexedDB 和内存
                                await this._saveToIndexedDB(key, newData);
                                await this._saveToIndexedDB(`__ts_${key}__`, Date.now());
                                changedKeys.push({ key, data: newData });
                                Logger.info('Storage', `[文件监听] ${key} 数据已同步 (${Array.isArray(newData) ? newData.length + '条' : '对象'})`);
                            } catch(parseErr) {
                                Logger.warn('Storage', `[文件监听] ${key}.js JSON 解析失败:`, parseErr);
                            }
                        }

                        // 更新时间戳记录
                        this._fileLastModified[key] = lastMod;
                    }
                } catch(e) {
                    // 文件可能不存在，跳过
                }
            }

            // 如果有变化，触发回调
            if (changedKeys.length > 0) {
                this._notifyFileChange(changedKeys);
            }
        } catch(e) {
            Logger.warn('Storage', '文件检查出错:', e);
        } finally {
            this._isCheckingFiles = false;
        }
    }

    /**
     * 获取需要监听的数据键列表
     */
    _getWatchKeys() {
        return [
            'assetManagementData',
            'userStateData',
            'systemSettings',
            'categoryOptions',
            'printRecords',
            'labelPrintRecords',
            // 自定义下拉选项（跨浏览器同步）
            'custom_options_owner',
            'custom_options_type',
            'custom_options_department',
            'custom_options_owner_deleted',
            'custom_options_type_deleted',
            'custom_options_department_deleted'
        ];
    }

    /**
     * 注册文件变化回调函数
     * @param {function} callback - 回调函数，参数为 changedKeys 数组
     */
    onFileChange(callback) {
        if (typeof callback === 'function') {
            this._fileWatchCallbacks.push(callback);
        }
    }

    /**
     * 通知所有回调函数文件已变化
     */
    _notifyFileChange(changedKeys) {
        // 内部写入期间（如自动连接同步、一致性检查）禁止触发通知
        // 防止系统刚写完文件就被文件监听误判为"外部修改"而弹出提示
        if (this._suppressWatchNotification) {
            Logger.info('Storage', `[文件监听] 抑制通知：本次 ${changedKeys.length} 项变化为系统内部写入`);
            return;
        }
        for (const cb of this._fileWatchCallbacks) {
            try {
                cb(changedKeys);
            } catch(e) {
                Logger.warn('Storage', '文件变化回调执行出错:', e);
            }
        }
    }

    /**
     * 手动从 .js 文件刷新数据（刷新按钮调用）
     * 强制重新读取所有 .js 文件，与 IndexedDB 比较，取数据量更大的一方
     * @returns {Promise<Object>} 同步结果 { changed: boolean, details: [] }
     */
    async syncFromFiles() {
        if (!this.dataDirHandle) {
            return { changed: false, details: [], error: '数据文件夹未连接' };
        }

        Logger.info('Storage', '===== 手动同步：从 .js 文件刷新数据 =====');
        const coreKeys = this._getWatchKeys();
        const details = [];
        let hasChanges = false;

        for (const key of coreKeys) {
            try {
                const fileName = `${key}.js`;
                const fileHandle = await this.dataDirHandle.getFileHandle(fileName);
                const file = await fileHandle.getFile();
                const text = await file.text();

                // 解析 .js 文件中的数据
                const match = text.match(new RegExp(`window\\.__LOCAL_DATA__\\.${key}\\s*=\\s*([\\s\\S]+?);\\s*$`, 'm'));
                if (!match) {
                    details.push({ key, status: 'parse_fail' });
                    continue;
                }

                const fileData = JSON.parse(match[1]);
                const fileLastMod = file.lastModified;

                // 更新时间戳记录
                this._fileLastModified[key] = fileLastMod;

                // 与 IndexedDB 比较
                const idbData = await this._loadFromIndexedDB(key);

                function sizeOf(d) {
                    if (Array.isArray(d)) return d.length;
                    if (d && typeof d === 'object') return Object.keys(d).length;
                    if (d != null) return 1;
                    return 0;
                }
                const fileSize = sizeOf(fileData);
                const idbSize = sizeOf(idbData);

                if (fileSize > idbSize) {
                    // 文件数据更多（其他浏览器的新数据），更新 IndexedDB
                    await this._saveToIndexedDB(key, fileData);
                    await this._saveToIndexedDB(`__ts_${key}__`, Date.now());
                    details.push({ key, status: 'file_to_idb', fileSize, idbSize });
                    hasChanges = true;
                    Logger.info('Storage', `[手动同步] ${key}: 文件(${fileSize}) > IndexedDB(${idbSize})，已更新 IndexedDB`);
                } else if (idbSize > fileSize) {
                    // IndexedDB 数据更多，补写回文件
                    await this._saveToScriptFile(key, idbData);
                    details.push({ key, status: 'idb_to_file', fileSize, idbSize });
                    hasChanges = true;
                    Logger.info('Storage', `[手动同步] ${key}: IndexedDB(${idbSize}) > 文件(${fileSize})，已补写文件`);
                } else {
                    details.push({ key, status: 'in_sync', fileSize, idbSize });
                }
            } catch(e) {
                // 文件不存在
                details.push({ key, status: 'no_file' });
            }
        }

        Logger.info('Storage', `===== 手动同步完成: ${hasChanges ? '有变化' : '无变化'} =====`);
        return { changed: hasChanges, details };
    }

    async _saveToScriptFile(key, data) {
        if (!this.dataDirHandle) return false;

        try {
            const fileName = `${key}.js`;
            const fileHandle = await this.dataDirHandle.getFileHandle(fileName, { create: true });
            const writable = await fileHandle.createWritable();

            // 生成 .js 文件内容（JSONP 风格）
            const jsonStr = JSON.stringify(data, null, 2);
            const content = `// ${key} 数据文件（本地直接打开模式）\n` +
                `// 此文件由系统自动维护，请勿手动编辑\n` +
                `// 最后更新: ${new Date().toISOString()}\n` +
                `window.__LOCAL_DATA__ = window.__LOCAL_DATA__ || {};\n` +
                `window.__LOCAL_DATA__.${key} = ${jsonStr};\n`;

            await writable.write(content);
            await writable.close();

            // 更新文件时间戳记录，防止文件监听误判为外部修改
            // 写入完成后立即读取文件的实际修改时间，确保与文件系统一致
            const file = await fileHandle.getFile();
            this._fileLastModified[key] = file.lastModified;

            Logger.debug('Storage', `.js 文件保存成功: ${fileName} (时间戳: ${new Date(file.lastModified).toLocaleTimeString()})`);
            return true;
        } catch (e) {
            Logger.error('Storage', `.js 文件保存失败: ${key}`, e);
            return false;
        }
    }

    /**
     * 触发 .js 文件下载（降级方案，不支持 File System Access API 的浏览器使用）
     * 用户需要手动将下载的文件覆盖原 data/*.js 文件
     */
    _downloadScriptFile(key, data) {
        try {
            const jsonStr = JSON.stringify(data, null, 2);
            const content = `// ${key} 数据文件（本地直接打开模式）\n` +
                `// 此文件由系统自动维护，请勿手动编辑\n` +
                `// 最后更新: ${new Date().toISOString()}\n` +
                `window.__LOCAL_DATA__ = window.__LOCAL_DATA__ || {};\n` +
                `window.__LOCAL_DATA__.${key} = ${jsonStr};\n`;

            const blob = new Blob([content], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${key}.js`;
            document.body.appendChild(link);
            link.click();

            setTimeout(() => {
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
            }, 100);

            Logger.info('Storage', `已触发 .js 文件下载: ${key}.js（请手动覆盖 data 目录下的原文件）`);
            return true;
        } catch (e) {
            Logger.error('Storage', `下载 .js 文件失败: ${key}`, e);
            return false;
        }
    }

    async _loadFromLocalFile(key) {
        if (!this.dataDirHandle) return null;

        try {
            const fileName = `${key}.json`;
            const fileHandle = await this.dataDirHandle.getFileHandle(fileName);
            const file = await fileHandle.getFile();
            const content = await file.text();
            const data = JSON.parse(content);
            
            Logger.debug('Storage', `本地文件加载成功: ${fileName}`);
            return data;
        } catch (e) {
            if (e.name === 'NotFoundError') {
                return null;
            }
            Logger.error('Storage', `本地文件加载失败: ${key}`, e);
            return null;
        }
    }

    async _loadFromLocalFiles() {
        if (!this.dataDirHandle) return;
        
        // 尝试从本地 JSON 文件加载数据
        const keys = Object.values(STORAGE_KEYS);
        for (const key of keys) {
            const fileData = await this._loadFromLocalFile(key);
            if (fileData) {
                // 如果 IndexedDB 中没有数据，用文件数据填充
                const idbData = await this._loadFromIndexedDB(key);
                if (!idbData) {
                    await this._saveToIndexedDB(key, fileData);
                    Logger.info('Storage', `从本地文件迁移数据到 IndexedDB: ${key}`);
                }
            }
        }
    }

    // ============ 服务器 API 实现 ============

    async _saveToServer(key, data) {
        try {
            // C/S 模式: 统一走 ApiClient(自动携带 JWT, 401 自动跳登录)
            if (this.csMode && typeof ApiClient !== 'undefined') {
                await ApiClient.request('POST', '/api/save?key=' + encodeURIComponent(key), { key: key, value: data });
                return true;
            }
            // Electron 旧内嵌服务兼容(X-Server-Token)
            const headers = { 'Content-Type': 'application/json' };
            if (typeof window !== 'undefined' && window.__SERVER_TOKEN__) {
                headers['X-Server-Token'] = window.__SERVER_TOKEN__;
            }
            const resp = await fetch(`/api/save?key=${encodeURIComponent(key)}`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ key: key, value: data })
            });
            return resp.ok;
        } catch (e) {
            return false;
        }
    }

    async _loadFromServer(key) {
        try {
            // C/S 模式: 统一走 ApiClient; 服务器无该键(404)视为空数据
            if (this.csMode && typeof ApiClient !== 'undefined') {
                try {
                    const payload = await ApiClient.request('GET', '/api/load?key=' + encodeURIComponent(key));
                    return (payload && payload.success) ? payload.data : null;
                } catch (e) {
                    if (e && e.code === 40400) return null;  // 键不存在 → 空
                    throw e;  // 网络/鉴权等错误向上抛, 由调用方处理
                }
            }
            // Electron 旧内嵌服务兼容
            const resp = await fetch(`/api/load?key=${encodeURIComponent(key)}`);
            if (!resp.ok) return null;
            const result = await resp.json();
            return result.success ? result.data : null;
        } catch (e) {
            if (e && e.code && e.code !== 40400) throw e;  // C/S 模式的业务错误向上抛
            return null;
        }
    }

    // ============ localStorage 兼容 ============

    _saveToLocalStorage(key, data) {
        try {
            // 优化：对资产数据主动剥离附件 base64 url（保留 thumbnail），
            // 避免 localStorage 5MB 限额问题。完整数据仍保存在 IndexedDB 中。
            let saveData = data;
            if (key === STORAGE_KEYS.ASSET_MANAGEMENT_DATA && Array.isArray(data)) {
                saveData = data.map(item => {
                    if (!item.attachments || !Array.isArray(item.attachments)) return item;
                    return {
                        ...item,
                        attachments: item.attachments.map(att => {
                            const { url, ...rest } = att;
                            return rest; // 丢弃 url（大 base64），保留 thumbnail 等元数据
                        })
                    };
                });
            }

            const jsonString = JSON.stringify({
                version: this.dataVersion,
                timestamp: Date.now(),
                data: saveData
            });
            localStorage.setItem(key, jsonString);
            return true;
        } catch (e) {
            // localStorage 可能因数据量过大而失败（通常 5MB 限制）
            if (e.name === 'QuotaExceededError' || e.code === 22) {
                console.warn('localStorage 空间不足，尝试压缩数据后重试...');
                try {
                    // 移除所有附件URL数据后重试
                    const slimData = JSON.parse(JSON.stringify(data));
                    if (Array.isArray(slimData)) {
                        slimData.forEach(item => {
                            if (item.attachments) {
                                item.attachments.forEach(att => {
                                    delete att.url;
                                    delete att.thumbnail;
                                    delete att.data;
                                });
                            }
                        });
                    }
                    const slimJson = JSON.stringify({
                        version: this.dataVersion,
                        timestamp: Date.now(),
                        data: slimData
                    });
                    localStorage.setItem(key, slimJson);
                    console.warn('已以压缩格式保存到 localStorage（附件数据已移除）');
                    return true;
                } catch (e2) {
                    console.error('localStorage 压缩保存仍失败:', e2);
                    return false;
                }
            }
            console.error('localStorage 保存失败:', e);
            return false;
        }
    }

    _loadFromLocalStorage(key) {
        try {
            const jsonString = localStorage.getItem(key);
            if (!jsonString) return null;
            const parsed = JSON.parse(jsonString);
            return parsed.data || parsed;
        } catch (e) {
            return null;
        }
    }

    // ============ 主接口 ============

    async setItem(key, data) {
        Logger.debug('Storage', 'setItem:', key);

        if (this.fileApiReady) {
            // C/S 多人模式: 服务器是唯一可信源, 写失败直接抛错(禁用本地回退, 避免多端数据分叉)
            if (this.csMode) {
                if (typeof ApiClient !== 'undefined') {
                    await ApiClient.request('POST', '/api/save?key=' + encodeURIComponent(key), { key: key, value: data });
                    return true;
                }
                const okServer = await this._saveToServer(key, data);
                if (!okServer) throw new Error('服务器保存失败: ' + key);
                return true;
            }
            // Electron 旧服务模式: Server + IndexedDB + localStorage 三重冗余
            // P0-2: 增加 IndexedDB 冗余备份,避免服务器写入失败时数据只停留在被剥离附件的 localStorage
            const serverOk = await this._saveToServer(key, data);
            if (!serverOk) {
                // P1-7: 服务器保存失败时记录错误并通知用户(数据已写入 IndexedDB/localStorage,但文件可能未持久化)
                Logger.error('Storage', `服务器保存失败: ${key},数据已缓存在内存/IndexedDB,但下次重启可能丢失最近更改`);
                if (typeof showNotification === 'function') {
                    showNotification('⚠️ 文件保存失败,数据已临时缓存在内存中。建议重新保存或导出备份。', 'warning', 6000);
                }
            }
            // 无论服务器是否成功,都写入 IndexedDB + localStorage 作为冗余
            await this._saveToIndexedDB(key, data);
            await this._saveToIndexedDB(`__ts_${key}__`, Date.now());
            this._saveToLocalStorage(key, data);
        } else {
            // 本地模式：IndexedDB + localStorage
            await this._saveToIndexedDB(key, data);
            await this._saveToIndexedDB(`__ts_${key}__`, Date.now());  // 保存时间戳
            this._saveToLocalStorage(key, data);

            // 同步保存到 .js 文件（File System Access API 优先，降级触发下载）
            if (this.dataDirHandle) {
                await this._saveToScriptFile(key, data);
            } else if (this.isFileSyncEnabled && this.fileSystemHandle) {
                // 数据文件夹已连接但 dataDirHandle 丢失（刷新后未恢复），尝试恢复
                try {
                    try {
                        this.dataDirHandle = await this.fileSystemHandle.getDirectoryHandle('data', { create: true });
                    } catch(e) {
                        this.dataDirHandle = this.fileSystemHandle;  // 直接选了 data 目录
                    }
                    await this._saveToScriptFile(key, data);
                } catch(e) {
                    Logger.warn('Storage', '恢复 dataDirHandle 失败，降级使用下载提示');
                    this._downloadScriptFile(key, data);
                }
            }
        }
        return true;
    }

    async getItem(key) {
        Logger.debug('Storage', 'getItem:', key);

        // 等待完整初始化完成（包括 IndexedDB、File System Access API 恢复）
        if (this._initPromise) {
            try {
                await this._initPromise;
            } catch(e) {}
        }

        if (this.fileApiReady) {
            // C/S 多人模式: 仅以服务器为准(禁用本地回退, 防止读到其他端已过期的冗余副本)
            if (this.csMode) {
                return await this._loadFromServer(key);
            }
            // Electron 旧服务模式:Server → window.__LOCAL_DATA__ → localStorage → IndexedDB(冗余备份)
            // P0-2: IndexedDB 作为最后兜底,即使服务器文件损坏,内存中的 IndexedDB 仍能恢复
            const serverData = await this._loadFromServer(key);
            if (serverData !== null) {
                this._saveToLocalStorage(key, serverData);
                // 同步到 IndexedDB 保持冗余
                await this._saveToIndexedDB(key, serverData);
                await this._saveToIndexedDB(`__ts_${key}__`, Date.now());
                return serverData;
            }
            // HTTP(S) 环境下服务端无数据即为空 —— 禁止回退本地缓存
            // (服务器模式下的本地副本只可能是过期脏数据, 回退会导致旧选项/旧资产"复活")
            if (typeof window !== 'undefined' && window.location && window.location.protocol !== 'file:') {
                return null;
            }
            // 服务器没有数据，尝试从 window.__LOCAL_DATA__ 初始化（.js 文件数据）
            if (typeof window.__LOCAL_DATA__ !== 'undefined' && window.__LOCAL_DATA__[key] !== undefined) {
                const scriptData = window.__LOCAL_DATA__[key];
                // 保存到服务器，供其他浏览器使用
                await this._saveToServer(key, scriptData);
                this._saveToLocalStorage(key, scriptData);
                await this._saveToIndexedDB(key, scriptData);
                await this._saveToIndexedDB(`__ts_${key}__`, Date.now());
                Logger.info('Storage', `从 .js 文件初始化服务器数据: ${key}`);
                return scriptData;
            }
            // localStorage 回退
            const lsData = this._loadFromLocalStorage(key);
            if (lsData !== null) return lsData;
            // P0-2: 最后兜底 - IndexedDB 冗余备份(服务器文件损坏时仍可恢复)
            const idbData = await this._loadFromIndexedDB(key);
            if (idbData !== null) {
                Logger.warn('Storage', `服务器/localStorage 均无数据 ${key},从 IndexedDB 冗余备份恢复`);
                return idbData;
            }
            return null;
        } else {
            // 本地模式数据优先级：
            // 1. 如果文件同步已启用：优先用 window.__LOCAL_DATA__（data/*.js 文件数据，跨浏览器共享）
            // 2. 如果文件同步未启用：优先用 IndexedDB（当前浏览器的数据），首次加载用 window.__LOCAL_DATA__
            // 3. localStorage（降级）

            if (typeof window.__LOCAL_DATA__ !== 'undefined' && window.__LOCAL_DATA__[key] !== undefined) {
                const scriptData = window.__LOCAL_DATA__[key];

                // 先尝试从 IndexedDB 读取，用于比较
                const idbData = await this._loadFromIndexedDB(key);
                const idbTs = await this._loadFromIndexedDB(`__ts_${key}__`);  // IndexedDB 保存时间戳
                const hasIdbData = idbData !== null && typeof idbData !== 'undefined';

                // 计算数据量（用于简单比较哪边数据更新/更多）
                function dataSize(d) {
                    if (Array.isArray(d)) return d.length;
                    if (d && typeof d === 'object') return Object.keys(d).length;
                    if (d !== null && d !== undefined) return 1;
                    return 0;
                }
                const scriptSize = dataSize(scriptData);
                const idbSize = hasIdbData ? dataSize(idbData) : 0;

                if (this.isFileSyncEnabled) {
                    // 文件同步已启用：取"数据量更大"的一方作为可信源，防止丢失数据
                    // （connectDataFolder 时已做过同步，但 setItem 可能因异常只写了一边）
                    let finalData;
                    let sourceDesc;

                    if (hasIdbData && idbSize > scriptSize) {
                        // IndexedDB 数据量更大（说明用户在当前浏览器改过，setItem 未成功写文件）
                        finalData = idbData;
                        sourceDesc = `IndexedDB (${idbSize} > ${scriptSize})`;
                        // 立即补写回 .js 文件，保持同步
                        if (this.dataDirHandle) {
                            await this._saveToScriptFile(key, finalData);
                            await this._saveToIndexedDB(`__ts_${key}__`, Date.now());
                        }
                    } else if (scriptSize > 0 || !hasIdbData) {
                        // .js 文件有数据（可能来自其他浏览器的最新写入），或 IndexedDB 为空
                        finalData = scriptData;
                        sourceDesc = `data/*.js (${scriptSize}条)`;
                        // 同步到 IndexedDB
                        await this._saveToIndexedDB(key, scriptData);
                        await this._saveToIndexedDB(`__ts_${key}__`, Date.now());
                    } else {
                        // 两边都空，用空数据
                        finalData = scriptData;
                        sourceDesc = '空数据';
                    }

                    Logger.info('Storage', `[文件同步] ${key}: 选择来源=${sourceDesc}`);
                    delete window.__LOCAL_DATA__[key];
                    return finalData;
                } else {
                    // 文件同步未启用：优先用 IndexedDB（当前浏览器修改过的数据）
                    if (hasIdbData) {
                        Logger.debug('Storage', `使用 IndexedDB 数据（文件同步未启用）: ${key}（${idbSize}条）`);
                        delete window.__LOCAL_DATA__[key];
                        return idbData;
                    } else {
                        // IndexedDB 为空（首次使用），用 data/*.js 文件数据初始化
                        await this._saveToIndexedDB(key, scriptData);
                        await this._saveToIndexedDB(`__ts_${key}__`, Date.now());
                        Logger.info('Storage', `首次加载: 从 data/*.js 初始化数据到 IndexedDB: ${key}（${scriptSize}条）`);
                        delete window.__LOCAL_DATA__[key];
                        return scriptData;
                    }
                }
            }

            // window.__LOCAL_DATA__ 已被消费或不存在，从 IndexedDB 读取
            const idbData = await this._loadFromIndexedDB(key);
            if (idbData !== null) {
                return idbData;
            }

            return this._loadFromLocalStorage(key);
        }
    }

    async removeItem(key) {
        if (this.fileApiReady) {
            try {
                // C/S 模式: 走 ApiClient(自动携带 JWT, 401 自动跳登录)
                if (this.csMode && typeof ApiClient !== 'undefined') {
                    await ApiClient.request('DELETE', '/api/delete?key=' + encodeURIComponent(key));
                } else {
                    // Electron 旧内嵌服务兼容(X-Server-Token)
                    const reqInit = { method: 'DELETE' };
                    if (typeof window !== 'undefined' && window.__SERVER_TOKEN__) {
                        reqInit.headers = { 'X-Server-Token': window.__SERVER_TOKEN__ };
                    }
                    await fetch(`/api/delete?key=${encodeURIComponent(key)}`, reqInit);
                }
            } catch(e) {}
        }
        
        if (this.indexedDBClient) {
            const tx = this.indexedDBClient.transaction(['data'], 'readwrite');
            const store = tx.objectStore('data');
            store.delete(key);
        }
        
        localStorage.removeItem(key);
    }

    // ============ 数据导入/导出 ============

    async exportAllData() {
        const allData = {};
        for (const key of Object.values(STORAGE_KEYS)) {
            const data = await this.getItem(key);
            if (data !== null) {
                allData[key] = data;
            }
        }

        const exportData = {
            version: this.dataVersion,
            exportedAt: new Date().toISOString(),
            data: allData
        };

        const jsonStr = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = url;
        link.download = `资产管理系统备份_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(link);
        link.click();

        setTimeout(() => {
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }, 100);

        return true;
    }

    async importFromFile(file) {
        try {
            const content = await file.text();
            const importData = JSON.parse(content);

            if (!importData.data || typeof importData.data !== 'object') {
                throw new Error('无效的备份文件格式');
            }

            let importedCount = 0;
            for (const [key, value] of Object.entries(importData.data)) {
                if (value !== null && value !== undefined) {
                    await this.setItem(key, value);
                    importedCount++;
                }
            }

            return { success: true, count: importedCount };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // ============ 数据压缩（兼容 script.js 中的调用） ============

    /**
     * 存储是否可用（兼容 init.js 中 checkBrowserCompatibility 的调用）
     */
    get isAvailable() {
        return this.isBrowser && (
            (typeof localStorage !== 'undefined') ||
            !!this.indexedDBClient
        );
    }

    /**
     * 数据压缩：移除缩略图等大尺寸数据，减少存储空间
     */
    compressData(data) {
        if (typeof data !== 'object' || data === null) {
            return data;
        }

        // 深拷贝数据
        const clonedData = JSON.parse(JSON.stringify(data));

        // 移除缩略图等大尺寸数据
        if (Array.isArray(clonedData)) {
            clonedData.forEach(item => {
                if (item.attachments) {
                    item.attachments.forEach(attachment => {
                        delete attachment.thumbnail;
                        delete attachment.data; // 移除文件二进制数据
                    });
                }
            });
        }

        return clonedData;
    }

    /**
     * 数据解压缩（noop，保持接口兼容）
     */
    decompressData(data) {
        return data;
    }

    // ============ 版本兼容性（导入导出使用） ============

    /**
     * 校验导入数据版本与当前系统版本的兼容性
     * @param {string} importVersion 导入文件声明的版本，例如 '2.0.0'
     * @returns {boolean} true 表示兼容，可安全导入
     */
    checkVersionCompatibility(importVersion) {
        // 无版本号按旧版本兼容（通过后续 assetsData 结构校验兜底）
        if (!importVersion || typeof importVersion !== 'string') {
            return true;
        }
        const current = String(this.dataVersion || '0.0.0').trim();
        const incoming = importVersion.trim();

        // 完全一致直接通过
        if (current === incoming) return true;

        const parseVer = (v) => {
            const parts = String(v).split('.').map(n => parseInt(n, 10));
            while (parts.length < 3) parts.push(0);
            return parts.map(n => (Number.isNaN(n) ? 0 : n));
        };

        const [cMajor, cMinor, cPatch] = parseVer(current);
        const [iMajor, iMinor] = parseVer(incoming);

        // 主版本号必须一致；主版本相同则所有次版本均向后兼容（新字段导入时会有默认值）
        if (iMajor !== cMajor) {
            Logger.warn('Storage', `版本兼容性检查失败：导入版本=${incoming}，当前版本=${current}`);
            return false;
        }
        // 同一主版本的导入文件一律兼容（不论 minor/patch，后续逻辑均做好字段兜底）
        Logger.info('Storage', `版本兼容性检查通过：导入=${incoming}，当前=${current}`);
        return true;
    }

    // ============ 存储状态信息 ============

    getStorageInfo() {
        const info = {
            mode: this.fileApiReady ? 'server' : 'local',
            protocol: this.isBrowser ? window.location.protocol : 'unknown',
            indexeddb: !!this.indexedDBClient,
            filesystem: !!this.dataDirHandle,
            fileSyncEnabled: this.isFileSyncEnabled,
            filesApiSupported: 'showDirectoryPicker' in window,
            scriptDataLoaded: typeof window.__LOCAL_DATA__ !== 'undefined',
            keys: Object.values(STORAGE_KEYS)
        };
        return info;
    }

    /**
     * 导入事务快照（仅在 server 模式下调用 /api/exec {createImportSnapshot} 等端点
     * 触发主进程 data 目录级复制；本地模式不做快照但返回 ok，让 UI 流程不受影响）
     */
    async createImportSnapshot() {
        if (!this.fileApiReady) return { ok: true, snapshotId: '' };
        // C/S 模式: 批量导入走服务端 /api/assets/batch 单事务, 无需文件级快照
        if (this.csMode) return { ok: true, snapshotId: '' };
        try {
            const resp = await fetch('/api/exec', {
                method: 'POST',
                headers: this._withTokenHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ action: 'createImportSnapshot' })
            });
            if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
            return await resp.json();
        } catch (e) { return { ok: false, error: e.message }; }
    }
    async rollbackImportSnapshot(snapshotId) {
        if (!this.fileApiReady) return { ok: true };
        if (!snapshotId) return { ok: true };
        try {
            const resp = await fetch('/api/exec', {
                method: 'POST',
                headers: this._withTokenHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ action: 'rollbackImport', snapshotId })
            });
            if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
            return await resp.json();
        } catch (e) { return { ok: false, error: e.message }; }
    }
    async commitImportSnapshot(snapshotId) {
        if (!this.fileApiReady) return { ok: true };
        if (!snapshotId) return { ok: true };
        try {
            const resp = await fetch('/api/exec', {
                method: 'POST',
                headers: this._withTokenHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ action: 'commitImport', snapshotId })
            });
            if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
            return await resp.json();
        } catch (e) { return { ok: false, error: e.message }; }
    }
    /** 返回带 token 的请求头（不改变传入对象） */
    _withTokenHeaders(headers) {
        const out = Object.assign({}, headers || {});
        if (typeof window !== 'undefined' && window.__SERVER_TOKEN__) {
            out['X-Server-Token'] = window.__SERVER_TOKEN__;
        }
        return out;
    }

    async checkUsage() {
        try {
            let totalSize = 0;
            
            if (this.indexedDBClient) {
                return new Promise((resolve) => {
                    const tx = this.indexedDBClient.transaction(['data'], 'readonly');
                    const store = tx.objectStore('data');
                    const request = store.openCursor();
                    
                    request.onsuccess = (e) => {
                        const cursor = e.target.result;
                        if (cursor) {
                            totalSize += JSON.stringify(cursor.value).length * 2;
                            cursor.continue();
                        } else {
                            resolve({
                                used: totalSize,
                                total: 500 * 1024 * 1024, // 500MB IndexedDB 配额
                                percentage: (totalSize / (500 * 1024 * 1024)) * 100
                            });
                        }
                    };
                    
                    request.onerror = () => {
                        resolve({ used: 0, total: 0, percentage: 0 });
                    };
                });
            }

            return { used: 0, total: 0, percentage: 0 };
        } catch (e) {
            return { used: 0, total: 0, percentage: 0 };
        }
    }
}

// 初始化存储管理器实例
const storageManager = new FileStorageManager();

// ============ 核心数据加载/保存函数（从 script.js 迁移） ============

/**
 * 保存数据到本地存储 - 使用防抖减少存储操作
 * 数据会保存到 IndexedDB + localStorage，如果已连接数据文件夹还会保存到 .js 文件
 */
function saveToLocalStorage() {
    // ============ C/S 多人模式 ============
    // 资产已通过 REST 单资产 API(POST/PUT/DELETE /api/assets, 带乐观锁)实时写服务端,
    // 本函数仅刷新本地读取缓存, 不再全量上传资产数组 —— 避免绕过乐观锁覆盖他人修改。
    // 用户状态(当前页/筛选/视图)为各端私有, 同样只留本地。
    if (typeof ApiClient !== 'undefined' && ApiClient.csMode) {
        try {
            storageManager._saveToLocalStorage(STORAGE_KEYS.ASSET_MANAGEMENT_DATA, storageManager.compressData(assetsData));
            const csUserState = {
                currentPage: currentPage,
                currentView: currentView,
                currentZoom: currentZoom,
                systemSettings: {
                    systemName: document.getElementById('system-name') ? document.getElementById('system-name').value : '电脑资产管理系统',
                    dateFormat: document.getElementById('date-format') ? document.getElementById('date-format').value : 'yyyy/mm/dd',
                    recordsPerPage: recordsPerPage
                },
                filters: {
                    statusFilter: document.getElementById('status-filter') ? document.getElementById('status-filter').value : 'all',
                    ownerFilter: document.getElementById('owner-filter') ? document.getElementById('owner-filter').value : 'all',
                    typeFilter: document.getElementById('type-filter') ? document.getElementById('type-filter').value : 'all',
                    departmentFilter: document.getElementById('department-filter') ? document.getElementById('department-filter').value : 'all'
                },
                lastSaved: new Date().toISOString()
            };
            storageManager._saveToLocalStorage(STORAGE_KEYS.USER_STATE_DATA, csUserState);

            // 系统级设置(名称/日期格式/每页条数)同步到服务端, 跨登录持久化
            // 其他各端私有状态(筛选/分页)只留本地
            try {
                const sys = csUserState.systemSettings || {};
                if (sys.systemName) {
                    storageManager.setItem('systemSettings', sys).catch((e) => {
                        console.warn('C/S 同步 systemSettings 到服务端失败:', e?.message || e);
                    });
                }
            } catch (_) {}
        } catch (e) {
            console.warn('C/S 模式本地缓存写入失败:', e);
        }
        hasUnsavedChanges = false;
        return;
    }

    // 先同步保存到 localStorage（确保即使立即刷新也不丢数据）
    try {
        const syncData = storageManager.compressData(assetsData);
        storageManager._saveToLocalStorage(STORAGE_KEYS.ASSET_MANAGEMENT_DATA, syncData);

        // 同步保存用户状态
        const userState = {
            currentPage: currentPage,
            currentView: currentView,
            currentZoom: currentZoom,
            systemSettings: {
                systemName: document.getElementById('system-name') ? document.getElementById('system-name').value : '电脑资产管理系统',
                dateFormat: document.getElementById('date-format') ? document.getElementById('date-format').value : 'yyyy/mm/dd',
                recordsPerPage: recordsPerPage
            },
            filters: {
                statusFilter: document.getElementById('status-filter') ? document.getElementById('status-filter').value : 'all',
                ownerFilter: document.getElementById('owner-filter') ? document.getElementById('owner-filter').value : 'all',
                typeFilter: document.getElementById('type-filter') ? document.getElementById('type-filter').value : 'all',
                departmentFilter: document.getElementById('department-filter') ? document.getElementById('department-filter').value : 'all'
            },
            lastSaved: new Date().toISOString()
        };
        storageManager._saveToLocalStorage(STORAGE_KEYS.USER_STATE_DATA, userState);
    } catch (e) {
        console.warn('同步保存到 localStorage 失败:', e);
    }

    // 清除之前的超时，异步保存到 IndexedDB（大容量存储）
    if (saveTimeout) clearTimeout(saveTimeout);

    // 设置新的超时
    saveTimeout = setTimeout(async () => {
        try {
            // 保存资产数据（使用 compressData 移除缩略图等大尺寸数据）
            const compressedData = storageManager.compressData(assetsData);
            const saveResult = await storageManager.setItem(STORAGE_KEYS.ASSET_MANAGEMENT_DATA, compressedData);

            if (!saveResult) {
                console.error('保存资产数据失败，尝试清理部分数据后重试...');
                const minimalData = JSON.parse(JSON.stringify(assetsData));
                minimalData.forEach(asset => {
                    if (asset.attachments) {
                        asset.attachments.forEach(attachment => {
                            delete attachment.thumbnail;
                            delete attachment.data;
                        });
                    }
                });
                const secondTry = await storageManager.setItem(STORAGE_KEYS.ASSET_MANAGEMENT_DATA, minimalData);
                if (!secondTry) {
                    console.error('数据保存仍然失败，请考虑删除部分数据或创建备份');
                    alert('数据保存失败，存储空间可能不足，请考虑清理部分数据');
                    return;
                }
            }

            // 保存用户状态数据
            const userState = {
                currentPage: currentPage,
                currentView: currentView,
                currentZoom: currentZoom,
                systemSettings: {
                    systemName: document.getElementById('system-name') ? document.getElementById('system-name').value : '电脑资产管理系统',
                    dateFormat: document.getElementById('date-format') ? document.getElementById('date-format').value : 'yyyy/mm/dd',
                    recordsPerPage: recordsPerPage
                },
                filters: {
                    statusFilter: document.getElementById('status-filter') ? document.getElementById('status-filter').value : 'all',
                    ownerFilter: document.getElementById('owner-filter') ? document.getElementById('owner-filter').value : 'all',
                    typeFilter: document.getElementById('type-filter') ? document.getElementById('type-filter').value : 'all',
                    departmentFilter: document.getElementById('department-filter') ? document.getElementById('department-filter').value : 'all'
                },
                lastSaved: new Date().toISOString()
            };

            await storageManager.setItem(STORAGE_KEYS.USER_STATE_DATA, userState);

            // 如果未启用文件同步（未连接数据文件夹），提示用户
            // 注意：这里不自动提示，避免频繁打扰用户。用户可以通过设置页面手动连接文件夹
            if (!storageManager.isFileSyncEnabled && window.location.protocol === 'file:') {
                Logger.debug('Storage', '数据已保存到 IndexedDB/localStorage，未启用文件同步');
            }

            hasUnsavedChanges = false;
        } catch (error) {
            console.error('保存数据失败:', error);
            alert('数据保存失败: ' + error.message);
        }
    }, 500); // 延迟500ms执行，避免频繁保存
}

/**
 * 从本地加载数据 - 使用 storageManager 统一管理
 * 数据来源优先级：window.__LOCAL_DATA__ → IndexedDB → localStorage
 */
function loadFromLocalStorage(callback) {
    try {
        setTimeout(async () => {
            try {
                // 加载资产数据
                const loadedAssetsData = await storageManager.getItem(STORAGE_KEYS.ASSET_MANAGEMENT_DATA);

                if (loadedAssetsData) {
                    // 处理可能的数据包装格式
                    if (Array.isArray(loadedAssetsData)) {
                        assetsData = loadedAssetsData;
                    } else if (loadedAssetsData.data && Array.isArray(loadedAssetsData.data)) {
                        assetsData = loadedAssetsData.data;
                    } else if (loadedAssetsData.version && loadedAssetsData.data) {
                        assetsData = loadedAssetsData.data;
                    } else {
                        assetsData = loadedAssetsData;
                    }
                } else {
                    assetsData = [];
                }

                // 加载用户状态数据
                const loadedUserState = await storageManager.getItem(STORAGE_KEYS.USER_STATE_DATA);

                // C/S 模式: 系统级设置从服务端独立 key(systemSettings) 读取, 跨登录持久化
                // 其他各端私有状态(筛选/分页)保持 getUserStateData 的返回
                let serverSystemSettings = null;
                if (storageManager.csMode) {
                    try {
                        const ss = await storageManager.getItem('systemSettings');
                        if (ss && typeof ss === 'object') serverSystemSettings = ss;
                    } catch (_) {}
                }

                if (loadedUserState || serverSystemSettings) {
                    try {
                        const userState = loadedUserState || {};

                        // switchPage 同步保存 currentView 到 localStorage，
                        // 但 getItem 可能从 IndexedDB 读取旧数据（无 currentView），
                        // 所以从 localStorage 补充最新值
                        const localState = storageManager._loadFromLocalStorage(STORAGE_KEYS.USER_STATE_DATA);
                        if (localState && typeof localState.currentView === 'string') {
                            userState.currentView = localState.currentView;
                        }
                        if (localState && typeof localState.currentPage === 'number') {
                            userState.currentPage = localState.currentPage;
                        }

                        if (typeof userState.currentPage === 'number' && userState.currentPage > 0) {
                            currentPage = userState.currentPage;
                        }

                        if (typeof userState.currentView === 'string' && userState.currentView) {
                            currentView = userState.currentView;
                        }

                        if (typeof userState.currentZoom === 'number' && userState.currentZoom > 0) {
                            currentZoom = userState.currentZoom;
                        }

                        // 恢复系统设置(优先用服务端独立 key, 其次用 userState.systemSettings)
                        const effectiveSystemSettings = serverSystemSettings || (userState && userState.systemSettings);
                        if (effectiveSystemSettings) {
                            const systemSettings = effectiveSystemSettings;

                            if (systemSettings.systemName) {
                                const nameInput = document.getElementById('system-name');
                                if (nameInput) nameInput.value = systemSettings.systemName;
                                // 更新侧边栏 + 移动端顶栏 + 浏览器标签页
                                updateSystemTitle(systemSettings.systemName);
                            }

                            if (systemSettings.dateFormat && document.getElementById('date-format')) {
                                document.getElementById('date-format').value = systemSettings.dateFormat;
                            }

                            if (systemSettings.recordsPerPage && !isNaN(parseInt(systemSettings.recordsPerPage))) {
                                recordsPerPage = parseInt(systemSettings.recordsPerPage);
                                if (document.getElementById('records-per-page')) {
                                    document.getElementById('records-per-page').value = systemSettings.recordsPerPage;
                                }
                                if (document.getElementById('page-size-selector')) {
                                    document.getElementById('page-size-selector').value = systemSettings.recordsPerPage;
                                }
                            }
                        }

                        // 恢复筛选条件
                        if (userState.filters) {
                            const filters = userState.filters;

                            if (filters.statusFilter && document.getElementById('status-filter')) {
                                document.getElementById('status-filter').value = filters.statusFilter;
                            }

                            // CustomSelect 管理的筛选器保存到临时变量，待初始化后恢复
                            const pendingFilters = {};
                            if (filters.ownerFilter) pendingFilters.ownerFilter = filters.ownerFilter;
                            if (filters.departmentFilter) pendingFilters.departmentFilter = filters.departmentFilter;
                            if (filters.typeFilter) pendingFilters.typeFilter = filters.typeFilter;
                            if (Object.keys(pendingFilters).length > 0) {
                                window._pendingFilterRestore = pendingFilters;
                            }
                        }

                    } catch (userStateError) {
                        console.error('加载用户状态数据失败:', userStateError);
                        currentPage = 1;
                        currentZoom = 1;
                    }
                } else {
                    currentPage = 1;
                    currentZoom = 1;
                }

                // 数据加载完成后调用回调函数
                if (typeof callback === 'function') {
                    callback();
                }
            } catch (error) {
                console.error('从本地加载数据失败:', error);
                console.warn('加载保存的数据失败，将使用空数据');
                assetsData = [];

                if (typeof callback === 'function') {
                    callback();
                }
            }
        }, 0);
    } catch (error) {
        console.error('访问本地存储失败:', error);
        assetsData = [];

        if (typeof callback === 'function') {
            callback();
        }
    }
}

/**
 * 保存模板数据到本地存储
 */
async function saveTemplateToLocalStorage(templateData, formatsData) {
    try {
        const templateToStore = {
            timestamp: new Date().toISOString(),
            data: Array.from(templateData),
            formats: formatsData
        };

        const result = await storageManager.setItem(STORAGE_KEYS.ASSET_CARD_TEMPLATE, templateToStore);

        if (result) {
        } else {
            console.warn('模板数据保存失败');
        }
    } catch (error) {
        console.error('保存模板数据失败:', error);
    }
}

/**
 * 从本地存储加载模板数据
 */
async function loadTemplateFromLocalStorage() {
    try {
        if (!window.XLSX) {
            return;
        }

        // C/S 模式下未登录时跳过(模板属服务端数据, 未登录请求只会得到 401 报错)
        if (typeof ApiClient !== 'undefined' && ApiClient.csMode && !ApiClient.isLoggedIn()) {
            return;
        }

        const storedTemplate = await storageManager.getItem(STORAGE_KEYS.ASSET_CARD_TEMPLATE);

        if (storedTemplate && storedTemplate.data) {
            try {
                const data = new Uint8Array(storedTemplate.data);
                const workbook = XLSX.read(data, {type: 'array'});

                assetCardTemplate = workbook;
                analyzedExcelFormats = storedTemplate.formats || null;

            } catch (parseError) {
                console.error('解析存储的模板数据失败:', parseError);
                await storageManager.removeItem(STORAGE_KEYS.ASSET_CARD_TEMPLATE);
                assetCardTemplate = null;
                analyzedExcelFormats = null;
            }
        }
    } catch (error) {
        console.error('加载模板数据失败:', error);
    }
}
