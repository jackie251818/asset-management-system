/**
 * 系统初始化（DOMContentLoaded、浏览器兼容性、定期存储检查、页面卸载处理、模板加载）
 * 从 script.js 拆分而来 - 请勿手动修改行号映射
 */
document.addEventListener('DOMContentLoaded', async function() {
    // ============ 登录入口守卫(统一) ============
    // 优先级: embedded(Electron 单机内嵌, 免密放行) > csMode(远端 C/S, 要求登录)
    //         > app_mode(浏览器模式记忆) > 无选择 → 跳 login.html
    try {
        if (typeof ApiClient !== 'undefined') {
            await ApiClient.ready();
            // Electron 单机内嵌服务: 免密放行(避免与 login.html 来回跳死循环)
            if (ApiClient.embeddedMode) {
                /* 放行, 继续初始化 */
            } else if (ApiClient.csMode) {
                // C/S 模式: 必须已登录
                if (!ApiClient.isLoggedIn()) { window.location.replace('login.html'); return; }
            } else {
                // 非嵌入式本地/文件模式: 检查浏览器模式记忆
                let appMode = '';
                try { appMode = localStorage.getItem('app_mode') || ''; } catch (e) {}
                if (appMode === 'client') {
                    // 用户选过 C/S 但当前探测不到服务端 → 回登录页重选
                    if (!ApiClient.isLoggedIn()) { window.location.replace('login.html'); return; }
                } else if (appMode !== 'standalone') {
                    // 未选择模式 → 登录页选模式(单机版/C/S 版)
                    window.location.replace('login.html'); return;
                }
                // appMode === 'standalone' → 放行(免密)
            }
        }
    } catch (e) { /* 探测失败视为本地模式, 继续初始化 */ }

    try {
        Logger.info('Init', '系统初始化开始');

        // ============ C/S 多人模式 UI 集成 ============
        if (typeof ApiClient !== 'undefined' && ApiClient.csMode) {
            setupCSModeUI();
        }

        // ============ 切换运行模式入口(全局可见, 不区分单机/C/S) ============
        setupSwitchModeUI();

        bindCoreEventListeners();

        // 检查浏览器兼容性
        checkBrowserCompatibility();

        // 立即同步从 localStorage 恢复上一次查看的页面（避免闪烁）
        try {
            const savedState = storageManager._loadFromLocalStorage(STORAGE_KEYS.USER_STATE_DATA);
            if (savedState && typeof savedState.currentView === 'string') {
                currentView = savedState.currentView;
            }
            // 如果 <head> 内联脚本已经恢复了页面，优先使用它的结果
            if (typeof window.__RESTORED_VIEW__ === 'string') {
                currentView = window.__RESTORED_VIEW__;
            }
            const validViews = ['dashboard', 'assets', 'reports', 'add-asset', 'settings'];
            if (!validViews.includes(currentView)) currentView = 'dashboard';
            if (savedState && typeof savedState.currentPage === 'number' && savedState.currentPage > 0) {
                currentPage = savedState.currentPage;
            }
            // 设置正确的 active 类（包括 dashboard），HTML 中已无默认 active
            const targetPage = document.getElementById(`${currentView}-page`);
            if (targetPage) {
                document.querySelectorAll('.page-content').forEach(p => p.classList.remove('active'));
                targetPage.classList.add('active');
                const menuItem = document.querySelector(`.menu-item[data-target="${currentView}"]`);
                if (menuItem) {
                    document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));
                    menuItem.classList.add('active');
                }
            }
            // 不移除 <head> 中添加的临时样式标签 - 保持页面可见性直到数据加载完成
            // 临时样式会在 loadFromLocalStorage 回调完成后移除
        } catch(e) {
            console.warn('恢复页面状态失败:', e);
            // 出错时兜底 dashboard，并保持临时样式直到数据加载完成
            const dp = document.getElementById('dashboard-page');
            if (dp) {
                document.querySelectorAll('.page-content').forEach(p => p.classList.remove('active'));
                dp.classList.add('active');
            }
            const mi = document.querySelector('.menu-item[data-target="dashboard"]');
            if (mi) {
                document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));
                mi.classList.add('active');
            }
        }

        // 设置定期存储检查（不依赖数据加载完成）
        setupPeriodicStorageCheck();

        // 绑定页面卸载前的数据保存（不依赖数据加载完成）
        setupPageUnloadHandler();

        // 尝试从本地存储加载数据，数据加载完成后再更新UI
        loadFromLocalStorage(function() {
            Logger.info('Init', '数据加载完成，开始渲染 UI');
            updateStatistics();

            // 恢复用户上一次查看的页面（数据加载完成后渲染对应内容）
            const validViews = ['dashboard', 'assets', 'reports', 'add-asset', 'settings'];
            const viewToRestore = validViews.includes(currentView) ? currentView : 'dashboard';

            // 渲染对应页面的内容（不再切换active类，因为已在前面设置好了）
            if (viewToRestore === 'dashboard') {
                renderRecentAssets();
                renderDamagedAssets();
            } else if (viewToRestore === 'assets') {
                requestAnimationFrame(() => renderAllAssets());
            } else if (viewToRestore === 'reports') {
                renderAllReportsCharts();
            }

            // 隐藏加载指示器
            hideLoadingIndicator();

            // 绑定剩余事件监听（依赖数据的交互）
            bindDataDependentEventListeners();

            // 检查URL参数，支持扫码直接跳转到资产详情
            handleAssetUrlParam();

            // 数据加载完成后移除 <head> 中添加的临时样式标签
            const tempStyle = document.getElementById('_restore_view_style');
            if (tempStyle) tempStyle.remove();
        });
        
        // 延迟替换Font Awesome图标为SVG图标，确保所有事件监听器已绑定
        setTimeout(() => {
            try {
                // 替换所有Font Awesome图标为SVG图标
                const faIcons = document.querySelectorAll('.fas, .far, .fab');
                faIcons.forEach(icon => {
                    try {
                        // 获取图标类名中的图标名称
                        const classes = Array.from(icon.classList);
                        let iconName = '';
                        
                        // 查找fa-开头的类名
                        for (let className of classes) {
                            if (className.startsWith('fa-') && className !== 'fas' && className !== 'far' && className !== 'fab') {
                                // 处理特殊图标名称（如fa-laptop-code转换为icon-laptop-code）
                                iconName = className.replace('fa-', '');
                                break;
                            }
                        }
                        
                        if (iconName) {
                            // 检查对应的SVG symbol是否存在
                            const symbolId = 'icon-' + iconName;
                            const symbolExists = document.getElementById(symbolId);
                            
                            if (symbolExists) {
                                // 创建SVG图标
                                const svgIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                                svgIcon.setAttribute('class', 'svg-icon ' + classes.join(' '));
                                svgIcon.setAttribute('width', '24');
                                svgIcon.setAttribute('height', '24');
                                
                                // 创建use元素引用对应的symbol
                                const useElement = document.createElementNS('http://www.w3.org/2000/svg', 'use');
                                useElement.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + symbolId);
                                
                                svgIcon.appendChild(useElement);
                                
                                // 保留原有的样式
                                svgIcon.style.cssText = icon.style.cssText;
                                
                                // 保存原始元素的ID
                                if (icon.id) {
                                    svgIcon.id = icon.id;
                                }
                                
                                // 替换元素
                                icon.parentNode.replaceChild(svgIcon, icon);
                            } else {
                                console.warn('SVG symbol not found for icon:', symbolId);
                                // 不替换不存在的图标，保持原样
                            }
                        }
                    } catch (iconError) {
                        console.error('Error replacing icon:', iconError);
                        // 继续处理下一个图标，不中断整体流程
                    }
                });
            } catch (error) {
                console.error('Error in icon replacement process:', error);
                // 继续执行其他代码，不中断整体流程
            }
        }, 100);
    } catch (error) {
        Logger.error('Init', '页面初始化时发生错误:', error);
        console.error('页面初始化时发生错误:', error);
        hideLoadingIndicator();
    }
});

// ============ C/S 多人模式 UI 集成 ============
/**
 * C/S 模式 UI 初始化: 用户信息展示 / 退出登录 / 多人更新轮询与提示横幅
 * 仅在 ApiClient.csMode 为 true 时由初始化流程调用
 */
function setupCSModeUI() {
    Logger.info('Init', '启用 C/S 多人模式 UI');

    // ---- 侧边栏用户区 ----
    const userBox = document.getElementById('cs-user-box');
    if (userBox && ApiClient.user) {
        userBox.style.display = 'flex';
        const nameEl = document.getElementById('cs-user-name');
        const roleEl = document.getElementById('cs-user-role');
        if (nameEl) nameEl.textContent = ApiClient.user.username || '未知用户';
        if (roleEl) roleEl.textContent = ApiClient.ROLE_NAMES[ApiClient.user.role] || ApiClient.user.role || '';
    }

    // 退出登录(两段式确认)
    // 注意: 不用 confirm()! Electron 同步对话框关闭后立即导航会导致登录页键盘输入失效
    const logoutBtn = document.getElementById('cs-logout-btn');
    if (logoutBtn) {
        let confirmTimer = null;
        logoutBtn.addEventListener('click', () => {
            if (logoutBtn.dataset.confirming === '1') {
                // 第二次点击: 确认退出
                clearTimeout(confirmTimer);
                logoutBtn.dataset.confirming = '0';
                logoutBtn.classList.remove('cs-logout-confirming');
                logoutBtn.innerHTML = '<i class="fas fa-sign-out-alt"></i><span>退出登录</span>';
                ApiClient.logout();
                return;
            }
            // 第一次点击: 进入待确认状态, 3 秒后自动恢复
            logoutBtn.dataset.confirming = '1';
            logoutBtn.classList.add('cs-logout-confirming');
            logoutBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i><span>再次点击确认退出</span>';
            confirmTimer = setTimeout(() => {
                logoutBtn.dataset.confirming = '0';
                logoutBtn.classList.remove('cs-logout-confirming');
                logoutBtn.innerHTML = '<i class="fas fa-sign-out-alt"></i><span>退出登录</span>';
            }, 3000);
        });
    }

    // ---- 多人更新提示横幅 ----
    const banner = document.getElementById('cs-update-banner');
    const refreshBtn = document.getElementById('cs-banner-refresh-btn');
    const dismissBtn = document.getElementById('cs-banner-dismiss-btn');

    const hideBanner = () => { if (banner) banner.style.display = 'none'; };
    if (dismissBtn) dismissBtn.addEventListener('click', hideBanner);

    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            refreshBtn.disabled = true;
            ApiClient.reloadAssetsData()
                .then(() => {
                    updateStatistics();
                    renderRecentAssets();
                    renderDamagedAssets();
                    renderAllAssets();
                    // 当前选中资产详情若在展示中, 同步刷新
                    const assetIdEl = document.getElementById('asset-id');
                    if (assetIdEl && assetIdEl.textContent && assetIdEl.textContent !== '未选择资产'
                        && assetsData.some(a => a.id === assetIdEl.textContent)) {
                        viewAssetDetails(assetIdEl.textContent);
                    }
                    hideBanner();
                    showNotification('数据已刷新为服务器最新内容', 'success', 3000);
                })
                .catch(err => showNotification('刷新失败: ' + (err.message || err), 'error', 4000))
                .finally(() => { refreshBtn.disabled = false; });
        });
    }

    // 启动数据版本轮询(30秒): 远端变化 → 显示横幅
    ApiClient.startVersionPolling(() => {
        if (banner) banner.style.display = 'flex';
    });

    // ---- 用户管理菜单项(仅 admin 可见) ----
    const usersMenu = document.querySelector('.menu-item[data-target="users"]');
    if (usersMenu) {
        usersMenu.style.display = (ApiClient.user && ApiClient.user.role === 'admin') ? 'flex' : 'none';
    }
}

/**
 * 切换运行模式入口(全局可见, 不区分单机/C/S)
 * 清状态后带 ?switch=1 跳 login.html —— login.html 会强制进入模式选择页
 *   - embeddedMode (Electron 内嵌单机): login.html 用 ?switch=1 绕开自动免密
 *   - csMode (C/S 服务端): 清 token 后 login.html 不会再自动跳转
 *   - file:// 浏览器: 清 app_mode 后 login.html 正常显示模式选择卡片
 */
function setupSwitchModeUI() {
    const btn = document.getElementById('switch-mode-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
        // 1. 清运行时凭证
        if (typeof ApiClient !== 'undefined') {
            ApiClient.token = null;
            ApiClient.user = null;
        }
        // 2. 清 localStorage 记忆(cs_auth 已随 token 一起在 ApiClient 中清, 这里兜底)
        try {
            localStorage.removeItem('cs_auth');
            localStorage.removeItem('app_mode');
            localStorage.removeItem('cs_server_url');
        } catch (e) {}
        // 3. 带 ?switch=1 跳 login.html, 强制进入模式选择页
        window.location.replace('login.html?switch=1');
    });
}

// 检查浏览器兼容性
function checkBrowserCompatibility() {
    // 检查是否支持localStorage
    if (!storageManager.isAvailable) {
        console.warn('浏览器不支持本地存储，系统功能可能受限');
        return;
    }
    
    // 检查JSON解析支持
    try {
        JSON.parse('{}');
    } catch (e) {
        console.error('浏览器不支持JSON，无法使用数据持久化功能');
        alert('您的浏览器版本过低，某些功能可能无法正常使用，请升级浏览器。');
    }
}

// 设置定期存储检查
function setupPeriodicStorageCheck() {
    // 每10分钟检查一次存储使用情况
    setInterval(async () => {
        try {
            const storageInfo = await storageManager.checkUsage();

            // 如果存储已使用超过90%，提醒用户清理数据
            if (storageInfo && storageInfo.percentage > 90) {
                if (confirm(`本地存储空间即将用尽（已使用${storageInfo.percentage.toFixed(1)}%），建议清理部分数据或创建备份。是否立即创建数据备份？`)) {
                    const backupBtn = document.getElementById('backup-data');
                    if (backupBtn) backupBtn.click();
                }
            }
        } catch (e) {
            console.warn('存储使用检查失败:', e);
        }
    }, 10 * 60 * 1000); // 10分钟
}

// 全局变量 hasUnsavedChanges 已在 config.js 中声明

// 设置页面卸载前的数据保存
function setupPageUnloadHandler() {
    // 重置未保存更改标志
    hasUnsavedChanges = false;
    
    // 监听可能导致数据变更的事件
    document.addEventListener('change', () => {
        hasUnsavedChanges = true;
    });
    
    document.addEventListener('input', () => {
        hasUnsavedChanges = true;
    });
    
    // 监听表单提交事件，标记为已保存
    document.addEventListener('submit', (e) => {
        // 不阻止表单提交，但标记为已保存
        setTimeout(() => {
            hasUnsavedChanges = false;
        }, 100);
    });
    
    // 监听页面卸载事件
    window.addEventListener('beforeunload', (e) => {
        if (hasUnsavedChanges) {
            try {
                // 清除之前的防抖超时
                if (saveTimeout) clearTimeout(saveTimeout);
                
                // 直接使用同步方式保存到 localStorage，确保页面卸载前数据已写入
                const saveData = JSON.parse(JSON.stringify(assetsData));
                const compressedData = storageManager.compressData(saveData);
                
                // 同步保存资产数据到 localStorage
                storageManager._saveToLocalStorage(STORAGE_KEYS.ASSET_MANAGEMENT_DATA, compressedData);
                
                // 同步保存用户状态数据
                const userState = {
                    currentPage: currentPage,
                    currentView: currentView,
                    currentZoom: currentZoom,
                    systemSettings: {
                        systemName: getElement('system-name') ? getElement('system-name').value : '电脑资产管理系统',
                        dateFormat: getElement('date-format') ? getElement('date-format').value : 'yyyy/mm/dd',
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
                
                hasUnsavedChanges = false;
            } catch (error) {
                console.error('页面卸载前保存数据失败:', error);
            }
        }
    });
}

// 绑定核心事件监听（不依赖数据的UI交互）

async function initTemplateLoading() {
    try {
        // 使用统一的 showLoadingIndicator 函数（通过 visible 类控制，与 hideLoadingIndicator 匹配）
        showLoadingIndicator();
        
        // 异步加载模板数据
        await loadTemplateFromLocalStorage();
        
        // 隐藏加载指示器
        hideLoadingIndicator();
    } catch (error) {
        console.error('初始化模板加载失败:', error);
        hideLoadingIndicator();
    }
}

// 页面加载完成后初始化模板加载
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', async () => {
        await initTemplateLoading();
    });
} else {
    // 如果页面已经加载完成，立即初始化
    initTemplateLoading();
}

// ==================== 扫码跳转资产详情 ====================
// 检查URL参数 ?asset=资产编号，自动跳转到对应资产详情页
async function handleAssetUrlParam(retryCount) {
    retryCount = retryCount || 0;
    const params = new URLSearchParams(window.location.search);
    const assetId = params.get('asset');

    if (!assetId) return;

    // 如果数据尚未加载，尝试从 storageManager 加载（支持 file:// 和服务器模式）
    if (assetsData.length === 0 && retryCount === 0) {
        try {
            Logger.info('Init', '数据为空，尝试从本地存储加载...');
            const data = await storageManager.getItem(STORAGE_KEYS.ASSET_MANAGEMENT_DATA);
            if (data) {
                if (Array.isArray(data)) {
                    assetsData = data;
                } else if (data && Array.isArray(data.data)) {
                    assetsData = data.data;
                }
                Logger.info('Init', '从本地存储加载成功，共', assetsData.length, '条记录');
            }
        } catch (e) {
            Logger.warn('Init', '本地存储加载失败:', e.message);
        }
    }

    // 如果仍然为空，最多重试3次
    if (assetsData.length === 0 && retryCount < 3) {
        Logger.info('Init', '资产数据尚未加载，等待重试...', retryCount + 1);
        setTimeout(() => handleAssetUrlParam(retryCount + 1), 500);
        return;
    }

    // 查找对应资产
    const asset = assetsData.find(a => a.id === assetId);

    if (asset) {
        Logger.info('Init', '扫码跳转到资产详情:', assetId);
        // 切换到资产详情页并显示资产信息
        viewAssetDetails(assetId);

        // 清除URL参数，避免刷新时重复跳转
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);
    } else {
        Logger.warn('Init', '未找到资产:', assetId, '当前数据条数:', assetsData.length);
        // 显示提示
        const tip = document.createElement('div');
        tip.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#fff3cd;color:#856404;padding:12px 24px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.15);z-index:9999;font-size:14px;';
        tip.textContent = '未找到资产编号 ' + assetId + ' 对应的资产';
        document.body.appendChild(tip);
        setTimeout(() => tip.remove(), 4000);
    }
}
    

