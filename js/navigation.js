/**
 * 页面导航切换、图片缩放重置、系统设置加载
 * 从 script.js 拆分而来 - 请勿手动修改行号映射
 */

function resetImageZoom() {
    currentZoom = 1;
    translateX = 0;
    translateY = 0;
    const imageElement = getElement('modal-image');
    if (imageElement) {
        imageElement.style.transform = '';
        imageElement.style.cursor = 'grab';
    }
    const pdfElement = document.getElementById('modal-pdf');
    if (pdfElement) {
        pdfElement.style.transform = '';
    }
}

// 页面切换函数
function switchPage(pageName) {
    try {
        // 记录当前页面并同步保存到 localStorage（确保刷新后能恢复）
        currentView = pageName;
        try {
            // 读取并完全解包现有数据
            const raw = localStorage.getItem(STORAGE_KEYS.USER_STATE_DATA);
            let userState = {};
            if (raw) {
                let obj = JSON.parse(raw);
                while (obj && typeof obj === 'object' && 'data' in obj) {
                    obj = obj.data;
                }
                if (obj && typeof obj === 'object') userState = obj;
            }
            userState.currentView = currentView;
            userState.currentPage = currentPage;
            // 用 _saveToLocalStorage 重新包装保存
            storageManager._saveToLocalStorage(STORAGE_KEYS.USER_STATE_DATA, userState);
        } catch(e) {}

        // 移除所有活跃状态
        document.querySelectorAll('.menu-item').forEach(i => {
            i.classList.remove('active');
        });
        document.querySelectorAll('.page-content').forEach(page => {
            page.classList.remove('active');
        });
        
        // 添加当前活跃状态
        const activeMenuItem = document.querySelector(`.menu-item[data-target="${pageName}"]`);
        if (activeMenuItem) {
            activeMenuItem.classList.add('active');
        } else {
            console.error('未找到目标菜单项：', pageName);
            // 对于资产详情页面，不需要菜单项激活
            if (pageName === 'asset-detail') {
            }
        }
        
        const targetPage = document.getElementById(`${pageName}-page`);
        if (targetPage) {
            targetPage.classList.add('active');
            
            // 验证页面是否真的可见
            const computedStyle = window.getComputedStyle(targetPage);
        } else {
            console.error('未找到目标页面：', pageName + '-page');
        }
    } catch (error) {
        console.error('页面切换过程中发生错误:', error);
        
        // 尝试手动恢复基本功能
        try {
            // 确保至少有一个页面是可见的
            const dashboardPage = document.getElementById('dashboard-page');
            if (dashboardPage) {
                dashboardPage.classList.add('active');
            }
        } catch (recoveryError) {
            console.error('恢复功能时也发生错误:', recoveryError);
        }
    }
    
    // 根据不同页面执行相应的刷新操作
    // 加载系统设置页面数据
    function loadSystemSettings() {
        // 这里可以添加实际的系统设置加载逻辑
        // 例如：从localStorage读取设置、初始化表单等
    }
    
    const pageHandlers = {
        'reports': function() {
            renderAllReportsCharts();
        },
        'dashboard': function() {
            updateStatistics();
            renderRecentAssets();
            renderDamagedAssets();
        },
        'assets': function() {
            renderAllAssets();
        },
        'add-asset': function() {
            const addAssetForm = getElement('add-asset-form');
            if (addAssetForm) addAssetForm.reset();
            
            // 确保损坏原因区域正确显示
            const statusSelect = getElement('status');
            const damageReasonGroup = getElement('damage-reason-group');
            if (statusSelect && damageReasonGroup) {
                damageReasonGroup.style.display = statusSelect.value === 'damaged' ? 'block' : 'none';
            }
            
            // 清空文件预览
            const filePreviews = getElement('file-previews');
            if (filePreviews) filePreviews.innerHTML = '';
        },
        'settings': function() {
            loadSystemSettings();
            if (typeof updateFileSyncStatus === 'function') {
                try { updateFileSyncStatus(); } catch(e) {}
            }
        },
        'users': function() {
            // 用户管理页: 仅 C/S admin 可见, 切入时刷新列表
            if (typeof renderUsersList === 'function') {
                renderUsersList();
            }
        }
    };
    
    // 调用对应的页面处理函数
    if (pageHandlers[pageName]) {
        pageHandlers[pageName]();
    }
}

// 更新统计数据 - 优化性能并添加防御性编程
