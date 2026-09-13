// 最终图表修复脚本 - 只保留资产状态分布、主体资产数量、部门资产分布和设备类型统计图表

// 简化版图表脚本 - 统计报表功能已更新

// 确保Chart.js库正确加载
function ensureChartLibrary() {
    if (typeof Chart === 'undefined') {
        console.warn('Chart.js库尚未加载');
        // 检查是否有Chart.js的脚本标签
        let chartScript = document.querySelector('script[src*="chart.min.js"]');
        if (!chartScript) {
            // 创建Chart.js脚本标签
            chartScript = document.createElement('script');
            chartScript.src = 'libs/chart.min.js';
            chartScript.async = true;
            chartScript.onload = function() {
                // 如果当前在报表页面，重新渲染图表
                if (document.getElementById('reports-page') && document.getElementById('reports-page').classList.contains('active')) {
                    renderAllReportsCharts();
                }
            };
            chartScript.onerror = function() {
                console.error('Chart.js库加载失败');
            };
            document.head.appendChild(chartScript);
        }
        return false;
    }
    return true;
}

// 监听数据变更，实现实时统计
function setupRealTimeStatistics() {
    ensureChartLibrary();

    // 图表重渲染防抖定时器引用：连续多次保存时只重渲染一次，避免 4 个 Chart 实例反复销毁重建
    let chartRenderTimeout = null;

    // 监听资产数据变更
    const originalSaveToLocalStorage = window.saveToLocalStorage;
    if (originalSaveToLocalStorage) {
        window.saveToLocalStorage = function() {
            // 先调用原始函数保存数据
            const result = originalSaveToLocalStorage.apply(this, arguments);
            // 然后更新统计（开销小，直接调用）
            if (window.updateStatistics) window.updateStatistics();
            // 如果当前在报表页面，防抖重渲染图表，合并连续保存触发的多次重渲染
            const reportsPage = document.getElementById('reports-page');
            if (reportsPage && reportsPage.classList.contains('active') && window.renderAllReportsCharts) {
                if (chartRenderTimeout) clearTimeout(chartRenderTimeout);
                chartRenderTimeout = setTimeout(() => {
                    chartRenderTimeout = null;
                    if (window.renderAllReportsCharts) {
                        window.renderAllReportsCharts();
                    }
                }, 200);
            }
            return result;
        };
    }

    // 监听页面切换到报表页面的情况
    const originalSwitchPage = window.switchPage;
    if (originalSwitchPage) {
        window.switchPage = function(pageName) {
            const result = originalSwitchPage.apply(this, arguments);
            // 如果切换到报表页面，确保Chart.js库加载并渲染图表
            if (pageName === 'reports') {
                if (ensureChartLibrary() && window.renderAllReportsCharts) {
                    window.renderAllReportsCharts();
                } else {
                    // Chart.js库尚未加载，设置延迟检查
                    const checkInterval = setInterval(() => {
                        if (ensureChartLibrary() && window.renderAllReportsCharts) {
                            clearInterval(checkInterval);
                            window.renderAllReportsCharts();
                        }
                    }, 300);
                    // 最多检查10次
                    setTimeout(() => clearInterval(checkInterval), 3000);
                }
            }
            return result;
        };
    }
}

// 页面加载完成后执行
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupRealTimeStatistics);
} else {
    setupRealTimeStatistics();
}

