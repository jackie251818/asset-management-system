/**
 * 全局配置、常量定义、DOM 缓存和工具函数
 * 从 script.js 拆分而来 - 请勿手动修改行号映射
 */

// ============ 日志工具 ============
const Logger = {
    _levels: { debug: 0, info: 1, warn: 2, error: 3 },
    _currentLevel: 1, // 默认显示 info 及以上

    _colorize: function(level, module, msg) {
        const colors = { debug: '#888', info: '#1890ff', warn: '#fa8c16', error: '#f5222d' };
        const color = colors[level] || '#333';
        const prefix = `[${level.toUpperCase()}]`;
        const mod = module ? `[${module}]` : '';
        return `${prefix}${mod} ${msg}`;
    },

    _log: function(level, module, ...args) {
        if (this._levels[level] < this._currentLevel) return;
        const fn = console[level] || console.log;
        const header = this._colorize(level, module, '');
        if (args.length === 1 && typeof args[0] === 'string') {
            fn(header + args[0]);
        } else {
            fn(header, ...args);
        }
    },

    debug: function(module, ...args) { this._log('debug', module, ...args); },
    info: function(module, ...args) { this._log('info', module, ...args); },
    warn: function(module, ...args) { this._log('warn', module, ...args); },
    error: function(module, ...args) { this._log('error', module, ...args); },
    setLevel: function(level) {
        if (this._levels.hasOwnProperty(level)) {
            this._currentLevel = this._levels[level];
        }
    }
};

// ============ 全局变量 ============
// 存储键名常量定义
const STORAGE_KEYS = {
    ASSET_MANAGEMENT_DATA: 'assetManagementData',
    USER_STATE_DATA: 'userStateData',
    SYSTEM_SETTINGS: 'systemSettings',
    BACKUP_HISTORY: 'backupHistory',
    ASSET_CARD_TEMPLATE: 'assetCardTemplate',
    ANALYZED_EXCEL_FORMATS: 'analyzedExcelFormats',
    // 自定义下拉选项（跨浏览器同步）
    CUSTOM_OPTIONS_OWNER: 'custom_options_owner',
    CUSTOM_OPTIONS_TYPE: 'custom_options_type',
    CUSTOM_OPTIONS_DEPARTMENT: 'custom_options_department',
    CUSTOM_OPTIONS_OWNER_DELETED: 'custom_options_owner_deleted',
    CUSTOM_OPTIONS_TYPE_DELETED: 'custom_options_type_deleted',
    CUSTOM_OPTIONS_DEPARTMENT_DELETED: 'custom_options_department_deleted',
    // 盘点模块
    INVENTORY_SESSIONS: 'inventory_sessions',
    INVENTORY_SESSION_ITEM: 'inventory_session_'    // 前缀，实际 key 拼接批次 ID
}

// 核心运行时状态变量（从 script.js 迁移，供 js/ 各模块共享）
// 注意：assetCardTemplate 和 analyzedExcelFormats 在 import-export.js 中声明，此处不重复声明
let assetsData = [];
let currentZoom = 1;          // 图片查看器缩放比例
let currentPage = 1;          // 当前分页页码
let currentView = 'dashboard'; // 当前所在页面（dashboard/assets/reports等）
let recordsPerPage = 20;      // 每页显示记录数
let modal = null;             // 全局图片查看器 modal
let closeBtn = null;          // 全局关闭按钮
let saveTimeout = null;       // 保存防抖定时器
let hasUnsavedChanges = false; // 未保存更改标志

// ============ 轻量状态管理 ============
// 提供统一的 setState 入口，便于追踪数据变更和触发渲染
const State = {
    _listeners: { assetsData: [], currentView: [], currentPage: [] },

    /** 订阅状态变更 */
    on(key, callback) {
        if (!this._listeners[key]) this._listeners[key] = [];
        this._listeners[key].push(callback);
    },

    /** 更新状态并通知监听器 */
    setAssetsData(data) {
        const oldData = assetsData;
        assetsData = data || [];
        this._notify('assetsData', assetsData, oldData);
    },

    setView(view) {
        const oldView = currentView;
        currentView = view;
        this._notify('currentView', view, oldView);
    },

    setPage(page) {
        const oldPage = currentPage;
        currentPage = page;
        this._notify('currentPage', page, oldPage);
    },

    _notify(key, newValue, oldValue) {
        if (newValue === oldValue) return;
        const listeners = this._listeners[key] || [];
        listeners.forEach(fn => {
            try { fn(newValue, oldValue); } catch(e) { console.error('State listener error:', e); }
        });
    }
};

// 数据存储目录
const DATA_STORAGE_DIR = './data/';

// ============ 统一防抖工具 ============
const _debounceTimers = {};

/**
 * 统一防抖函数
 * @param {string} key - 唯一标识，同一key的调用会被合并
 * @param {Function} fn - 要执行的函数
 * @param {number} delay - 延迟毫秒数
 */
function debounce(key, fn, delay) {
    if (_debounceTimers[key]) clearTimeout(_debounceTimers[key]);
    _debounceTimers[key] = setTimeout(() => {
        delete _debounceTimers[key];
        fn();
    }, delay);
}

// DOM元素缓存，减少重复查询
const DOM = {};

// 获取DOM元素的辅助函数（带 stale 引用检测）
function getElement(id) {
    if (!DOM[id] || !DOM[id].isConnected) {
        DOM[id] = document.getElementById(id);
    }
    return DOM[id];
}

/**
 * 统一更新系统标题（侧边栏、移动端顶栏、浏览器标签页）
 * @param {string} name 新的系统名称；为空或不传时，从输入框/默认值读取
 */
function updateSystemTitle(name) {
    const DEFAULT_NAME = '电脑资产管理系统';
    let systemName = name;
    if (!systemName) {
        const input = document.getElementById('system-name');
        systemName = (input && input.value && input.value.trim()) ? input.value.trim() : DEFAULT_NAME;
    }
    try {
        const sidebarEl = document.getElementById('sidebar-title');
        if (sidebarEl) sidebarEl.textContent = systemName;
    } catch (e) {}
    try {
        const mobileEl = document.getElementById('mobile-topbar-title');
        if (mobileEl) mobileEl.textContent = systemName;
    } catch (e) {}
    try {
        document.title = systemName;
    } catch (e) {}
}

// 获取当前激活的页面容器，用于限定选择器作用域
function getActivePage() {
    return document.querySelector('.page-content.active');
}

// 日期格式化工具函数 - 根据系统设置格式化日期显示
function formatDate(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    const [year, month, day] = parts;
    const format = (document.getElementById('date-format')?.value) || 'yyyy/mm/dd';
    const pad = (n) => n.padStart(2, '0');
    switch (format) {
        case 'mm/dd/yyyy': return `${month}/${day}/${year}`;
        case 'dd/mm/yyyy': return `${day}/${month}/${year}`;
        case 'yyyy/mm/dd': return `${year}/${month}/${day}`;
        default: return `${year}/${month}/${day}`;
    }
}

// 文件存储管理器 - 通过服务器 API 持久化到文件 + localStorage 双写双读
