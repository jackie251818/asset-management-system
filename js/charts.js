/**
 * 统计报表图表渲染（资产状态、主体、部门、设备类型）
 * 从 script.js 拆分而来 - 请勿手动修改行号映射
 *
 * C/S 多人模式: 图表数据源优先使用服务端聚合统计 /api/stats/summary
 * (window.__CS_STATS__), 拉取失败时降级为本地内存统计。
 */
async function renderAllReportsCharts() {
    Logger.info('Charts', '渲染报表图表 | 资产数:', assetsData.length);

    // ============ C/S 多人模式: 拉取服务端聚合统计 ============
    if (typeof ApiClient !== 'undefined' && ApiClient.csMode) {
        try {
            window.__CS_STATS__ = await ApiClient.statsSummary();
        } catch (e) {
            Logger.warn('Charts', '获取服务端统计失败, 降级使用本地内存数据:', e && e.message);
            window.__CS_STATS__ = null;
        }
    } else {
        window.__CS_STATS__ = null;
    }

    if (typeof Chart === 'undefined') {
        Logger.warn('Charts', 'Chart.js 库尚未加载，暂时无法渲染图表');
        console.warn('Chart.js库尚未加载，暂时无法渲染图表');
        const chartContainers = document.querySelectorAll('#reports-page .chart-container');
        chartContainers.forEach(container => {
            const canvas = container.querySelector('canvas');
            if (canvas) {
                canvas.style.display = 'none';
                // 检查是否已经有提示信息，如果没有则添加
                if (!container.querySelector('.chart-fallback-message')) {
                    const messageElement = document.createElement('div');
                    messageElement.className = 'chart-fallback-message';
                    messageElement.innerText = '图表库加载失败，无法显示统计图表';
                    container.appendChild(messageElement);
                }
            }
        });
        return;
    }
    
    // 设备类型统计图表
    renderAssetTypeChart();
    
    // 资产状态分布图表
    renderAssetStatusChart();
    
    // 主体资产数量图表
    renderOwnerAssetsChart();
    
    // 部门资产分布图表
    renderDepartmentAssetsChart();
    
    // 为统计报表页面的导出按钮绑定事件处理程序
    try {
        const exportExcelBtn = document.getElementById('export-reports-excel');
        const exportJsonBtn = document.getElementById('export-reports-json');
        
        // 只有当按钮存在时才进行操作
        if (exportExcelBtn && exportJsonBtn) {
            // 移除旧的事件监听器（防止重复绑定）
            const newExportExcelBtn = exportExcelBtn.cloneNode(true);
            const newExportJsonBtn = exportJsonBtn.cloneNode(true);
            
            // 替换旧按钮
            exportExcelBtn.parentNode.replaceChild(newExportExcelBtn, exportExcelBtn);
            exportJsonBtn.parentNode.replaceChild(newExportJsonBtn, exportJsonBtn);
            
            // 为新按钮添加事件监听器
            newExportExcelBtn.addEventListener('click', function() {
                exportToExcel('reports');
            });
            
            newExportJsonBtn.addEventListener('click', function() {
                exportToJson('reports');
            });
        }
    } catch (error) {
        console.error('为导出按钮绑定事件监听器时发生错误:', error);
    }
}

// 渲染资产状态分布图表
function renderAssetStatusChart() {
    // 修复选择器，第一个卡片是资产状态分布
    const card = document.querySelector('#reports-page .card:nth-child(1) .chart-container');
    if (!card) return;
    
    // 查找现有的canvas元素，如果不存在则创建
    let canvas = document.getElementById('assetStatusChart');
    if (!canvas) {
        // 清空容器内容
        card.innerHTML = '';
        
        // 创建canvas元素
        canvas = document.createElement('canvas');
        canvas.id = 'assetStatusChart';
        card.appendChild(canvas);
    } else {
        // 移除可能存在的提示信息
        const messageElement = card.querySelector('.chart-fallback-message');
        if (messageElement) {
            messageElement.remove();
        }
        canvas.style.display = 'block';
    }
    
    const ctx = canvas.getContext('2d');
    
    // 销毁已存在的图表实例（如果有）
    if (window.assetStatusChartInstance) {
        try {
            window.assetStatusChartInstance.destroy();
        } catch (e) {
            console.error('销毁 assetStatusChartInstance 失败:', e);
            Logger?.error?.('Charts', '销毁 assetStatusChartInstance 失败:', e);
        }
        window.assetStatusChartInstance = null;
    }
    
    // 统计状态数据（C/S 模式优先服务端聚合, 否则内存统计）
    const statusStats = {
        active: 0,
        idle: 0,
        damaged: 0,
        maintenance: 0,
        retired: 0
    };

    const csStats = window.__CS_STATS__;
    if (csStats && csStats.byStatus) {
        Object.assign(statusStats, csStats.byStatus);
    } else {
        assetsData.forEach(asset => {
            if (asset.status && statusStats.hasOwnProperty(asset.status)) {
                statusStats[asset.status]++;
            }
        });
    }
    
    // 准备图表数据
    const labels = ['在用', '闲置', '损坏', '维修中', '报废'];
    const statusKeys = ['active', 'idle', 'damaged', 'maintenance', 'retired'];
    const data = statusKeys.map(key => statusStats[key]);
    const total = data.reduce((a, b) => a + b, 0);
    
    // 生成颜色数组
    const colors = [
        'rgba(82, 196, 26, 0.7)',    // 绿色 - 在用
        'rgba(250, 173, 20, 0.7)',   // 黄色 - 闲置
        'rgba(255, 77, 79, 0.7)',    // 红色 - 损坏
        'rgba(143, 105, 255, 0.7)',  // 紫色 - 维修中
        'rgba(136, 136, 136, 0.7)'   // 灰色 - 报废
    ];
    
    // 创建图表
    window.assetStatusChartInstance = new Chart(ctx, {
        type: 'pie',
        data: {
            labels: labels,
            datasets: [{
                label: '资产数量',
                data: data,
                backgroundColor: colors,
                borderColor: colors.map(color => color.replace('0.7', '1')),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'right'
                },
                title: {
                    display: true,
                    text: '资产状态分布',
                    font: {
                        size: 16
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.label || '';
                            const value = context.raw;
                            const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                            return `${label}: ${value} (${percentage}%)`;
                        }
                    }
                }
            }
        }
    });
}

// 渲染主体资产数量图表
function renderOwnerAssetsChart() {
    // 修复选择器，第二个卡片是主体资产数量
    const card = document.querySelector('#reports-page .card:nth-child(2) .chart-container');
    if (!card) return;
    
    // 查找现有的canvas元素，如果不存在则创建
    let canvas = document.getElementById('ownerAssetsChart');
    if (!canvas) {
        // 清空容器内容
        card.innerHTML = '';
        
        // 创建canvas元素
        canvas = document.createElement('canvas');
        canvas.id = 'ownerAssetsChart';
        card.appendChild(canvas);
    } else {
        // 移除可能存在的提示信息
        const messageElement = card.querySelector('.chart-fallback-message');
        if (messageElement) {
            messageElement.remove();
        }
        canvas.style.display = 'block';
    }
    
    const ctx = canvas.getContext('2d');
    
    // 销毁已存在的图表实例（如果有）
    if (window.ownerAssetsChartInstance) {
        try {
            window.ownerAssetsChartInstance.destroy();
        } catch (e) {
            console.error('销毁 ownerAssetsChartInstance 失败:', e);
            Logger?.error?.('Charts', '销毁 ownerAssetsChartInstance 失败:', e);
        }
        window.ownerAssetsChartInstance = null;
    }
    
    // 统计主体数据（C/S 模式优先服务端聚合）
    const csStats = window.__CS_STATS__;
    let ownerStats;
    if (csStats && csStats.byOwner) {
        ownerStats = Object.assign({}, csStats.byOwner);
    } else {
        ownerStats = {};
        assetsData.forEach(asset => {
            const owner = asset.owner || '未知主体';
            ownerStats[owner] = (ownerStats[owner] || 0) + 1;
        });
    }
    
    // 准备图表数据
    const labels = Object.keys(ownerStats);
    const data = Object.values(ownerStats);
    const total = data.reduce((a, b) => a + b, 0);
    
    // 生成颜色数组
    const colors = generateColors(labels.length);
    
    // 创建图表
    window.ownerAssetsChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: '资产数量',
                data: data,
                backgroundColor: colors,
                borderColor: colors.map(color => color.replace('0.7', '1')),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                title: {
                    display: true,
                    text: '主体资产数量',
                    font: {
                        size: 16
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.dataset.label || '';
                            const value = context.raw;
                            const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                            return `${label}: ${value} (${percentage}%)`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        stepSize: 1
                    }
                },
                x: {
                    ticks: {
                        maxRotation: 45,
                        minRotation: 45
                    }
                }
            }
        }
    });
}

// 渲染部门资产分布图表
function renderDepartmentAssetsChart() {
    // 修复选择器，第三个卡片是部门资产分布
    const card = document.querySelector('#reports-page .card:nth-child(3) .chart-container');
    if (!card) return;
    
    // 查找现有的canvas元素，如果不存在则创建
    let canvas = document.getElementById('departmentAssetsChart');
    if (!canvas) {
        // 清空容器内容
        card.innerHTML = '';
        
        // 创建canvas元素
        canvas = document.createElement('canvas');
        canvas.id = 'departmentAssetsChart';
        card.appendChild(canvas);
    } else {
        // 移除可能存在的提示信息
        const messageElement = card.querySelector('.chart-fallback-message');
        if (messageElement) {
            messageElement.remove();
        }
        canvas.style.display = 'block';
    }
    
    const ctx = canvas.getContext('2d');
    
    // 销毁已存在的图表实例（如果有）
    if (window.departmentAssetsChartInstance) {
        try {
            window.departmentAssetsChartInstance.destroy();
        } catch (e) {
            console.error('销毁 departmentAssetsChartInstance 失败:', e);
            Logger?.error?.('Charts', '销毁 departmentAssetsChartInstance 失败:', e);
        }
        window.departmentAssetsChartInstance = null;
    }
    
    // 统计部门数据（C/S 模式优先服务端聚合）
    const csStats = window.__CS_STATS__;
    let departmentStats;
    if (csStats && csStats.byDepartment) {
        departmentStats = Object.assign({}, csStats.byDepartment);
    } else {
        departmentStats = {};
        assetsData.forEach(asset => {
            const department = asset.department || '未知部门';
            departmentStats[department] = (departmentStats[department] || 0) + 1;
        });
    }
    
    // 准备图表数据
    const labels = Object.keys(departmentStats);
    const data = Object.values(departmentStats);
    const total = data.reduce((a, b) => a + b, 0);
    
    // 生成颜色数组
    const colors = generateColors(labels.length);
    
    // 创建图表
    window.departmentAssetsChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: '资产数量',
                data: data,
                backgroundColor: colors,
                borderColor: colors.map(color => color.replace('0.7', '1')),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                title: {
                    display: true,
                    text: '部门资产分布',
                    font: {
                        size: 16
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.dataset.label || '';
                            const value = context.raw;
                            const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                            return `${label}: ${value} (${percentage}%)`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        stepSize: 1
                    }
                },
                x: {
                    ticks: {
                        maxRotation: 45,
                        minRotation: 45
                    }
                }
            }
        }
    });
}

// 渲染设备类型统计图表
function renderAssetTypeChart() {
    // 修复选择器，第四个卡片是设备类型统计
    const card = document.querySelector('#reports-page .card:nth-child(4) .chart-container');
    if (!card) {
        console.warn('未找到设备类型统计图表的容器');
        return;
    }
    
    // 查找现有的canvas元素，如果不存在则创建
    let canvas = document.getElementById('assetTypeChart');
    if (!canvas) {
        // 清空容器内容
        card.innerHTML = '';
        
        // 创建canvas元素
        canvas = document.createElement('canvas');
        canvas.id = 'assetTypeChart';
        card.appendChild(canvas);
    } else {
        // 移除可能存在的提示信息
        const messageElement = card.querySelector('.chart-fallback-message');
        if (messageElement) {
            messageElement.remove();
        }
        canvas.style.display = 'block';
    }
    
    const ctx = canvas.getContext('2d');
    
    // 销毁已存在的图表实例（如果有）
    if (window.assetTypeChartInstance) {
        try {
            window.assetTypeChartInstance.destroy();
        } catch (e) {
            console.error('销毁 assetTypeChartInstance 失败:', e);
            Logger?.error?.('Charts', '销毁 assetTypeChartInstance 失败:', e);
        }
        window.assetTypeChartInstance = null;
    }
    
    // 统计设备类型数据（C/S 模式优先服务端聚合）
    const csStats = window.__CS_STATS__;
    let typeStats;
    if (csStats && csStats.byType) {
        typeStats = Object.assign({}, csStats.byType);
    } else {
        typeStats = {};
        assetsData.forEach(asset => {
            const type = asset.type || '未知类型';
            typeStats[type] = (typeStats[type] || 0) + 1;
        });
    }
    
    // 准备图表数据
    const labels = Object.keys(typeStats);
    const data = Object.values(typeStats);
    
    // 生成颜色数组
    const colors = generateColors(labels.length);
    
    // 创建图表
    window.assetTypeChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: '设备数量',
                data: data,
                backgroundColor: colors,
                borderColor: colors.map(color => color.replace('0.7', '1')), // 不透明的边框色
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                title: {
                    display: true,
                    text: '按设备类型统计',
                    font: {
                        size: 16
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.dataset.label || '';
                            const value = context.raw;
                            const total = data.reduce((a, b) => a + b, 0);
                            const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                            return `${label}: ${value} (${percentage}%)`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        stepSize: 1
                    }
                },
                x: {
                    ticks: {
                        maxRotation: 45,
                        minRotation: 45
                    }
                }
            }
        }
    });
}

// 生成随机颜色数组
function generateColors(count) {
    const colors = [];
    const colorPalette = [
        'rgba(48, 129, 235, 0.7)',  // 蓝色
        'rgba(82, 196, 26, 0.7)',   // 绿色
        'rgba(250, 173, 20, 0.7)',  // 黄色
        'rgba(255, 77, 79, 0.7)',   // 红色
        'rgba(143, 105, 255, 0.7)', // 紫色
        'rgba(255, 106, 0, 0.7)',   // 橙色
        'rgba(0, 176, 255, 0.7)',   // 浅蓝色
        'rgba(136, 136, 136, 0.7)', // 灰色
        'rgba(255, 0, 255, 0.7)',   // 粉色
        'rgba(0, 255, 127, 0.7)'    // 青色
    ];
    
    for (let i = 0; i < count; i++) {
        // 如果颜色不够，循环使用或生成随机色
        if (i < colorPalette.length) {
            colors.push(colorPalette[i]);
        } else {
            // 生成随机颜色
            const r = Math.floor(Math.random() * 200);
            const g = Math.floor(Math.random() * 200);
            const b = Math.floor(Math.random() * 200);
            colors.push(`rgba(${r}, ${g}, ${b}, 0.7)`);
        }
    }
    
    return colors;
}

// 显示添加维护记录对话框
