/**
 * 控制面板统计和渲染（最近资产、损坏资产）
 * 从 script.js 拆分而来 - 请勿手动修改行号映射
 */

function updateStatistics() {
    try {
        // 防御性检查确保assetsData是一个数组
        if (!Array.isArray(assetsData)) {
            console.error('updateStatistics: assetsData不是有效的数组');
            return;
        }
        
        // 获取要统计的数据 - 如果有筛选后的数据就使用筛选后的数据，否则使用完整数据
        let dataToCount = window.filteredAssetsForStatistics || assetsData;
        
        // 使用单次遍历计算所有统计数据
        let total = dataToCount.length;
        let active = 0;
        let idle = 0;
        let damaged = 0;
        let maintenance = 0;
        let retired = 0;
        
        for (let i = 0; i < dataToCount.length; i++) {
            const asset = dataToCount[i];
            // 检查asset对象是否有效
            if (!asset || typeof asset !== 'object') continue;
            
            // 空状态(null/undefined/'')默认归入闲置，与导入逻辑保持一致
            const status = asset.status || 'idle';
            if (status === 'active') {
                active++;
            } else if (status === 'idle') {
                idle++;
            } else if (status === 'damaged') {
                damaged++;
            } else if (status === 'maintenance') {
                maintenance++;
            } else if (status === 'retired') {
                retired++;
            }
        }
        
        // 计算百分比
        const calculatePercentage = (count) => total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
        
        // 批量更新DOM，减少重绘
        // 更新仪表盘页面的统计数据
        if (getElement('dashboard-total-assets')) {
            getElement('dashboard-total-assets').textContent = total;
        }
        if (getElement('dashboard-active-assets')) {
            getElement('dashboard-active-assets').textContent = `${active} (${calculatePercentage(active)}%)`;
        }
        if (getElement('dashboard-idle-assets')) {
            getElement('dashboard-idle-assets').textContent = `${idle} (${calculatePercentage(idle)}%)`;
        }
        if (getElement('dashboard-maintenance-assets')) {
            getElement('dashboard-maintenance-assets').textContent = `${maintenance} (${calculatePercentage(maintenance)}%)`;
        }
        if (getElement('dashboard-damaged-assets')) {
            getElement('dashboard-damaged-assets').textContent = `${damaged} (${calculatePercentage(damaged)}%)`;
        }
        
        // 更新资产页面的统计数据
        if (getElement('assets-total-assets')) {
            getElement('assets-total-assets').textContent = total;
        }
        if (getElement('assets-active-assets')) {
            getElement('assets-active-assets').textContent = `${active} (${calculatePercentage(active)}%)`;
        }
        if (getElement('assets-idle-assets')) {
            getElement('assets-idle-assets').textContent = `${idle} (${calculatePercentage(idle)}%)`;
        }
        if (getElement('assets-maintenance-assets')) {
            getElement('assets-maintenance-assets').textContent = `${maintenance} (${calculatePercentage(maintenance)}%)`;
        }
        if (getElement('assets-damaged-assets')) {
            getElement('assets-damaged-assets').textContent = `${damaged} (${calculatePercentage(damaged)}%)`;
        }
        
        // 仅在需要时更新图表
        const reportsPage = getElement('reports-page');
        if (reportsPage && reportsPage.classList.contains('active')) {
            // 使用requestIdleCallback延迟渲染图表
            requestIdleCallback(() => {
                renderAllReportsCharts();
            }, { timeout: 1000 });
        }
    } catch (error) {
        console.error('更新统计数据时发生错误:', error);
    }
}

// 渲染最近添加的资产 - 使用防抖和requestAnimationFrame优化
let renderRecentTimeout;
function renderRecentAssets() {
    // 防抖处理
    if (renderRecentTimeout) clearTimeout(renderRecentTimeout);
    
    renderRecentTimeout = setTimeout(() => {
        const tableBody = document.getElementById('recent-assets-table');
        
        if (!tableBody) return;
        
        requestAnimationFrame(() => {
            tableBody.innerHTML = '';
            
            if (assetsData.length === 0) {
                const { colspan } = createAssetTableRow({}, false);
                const emptyRow = document.createElement('tr');
                emptyRow.innerHTML = `<td colspan="${colspan}" style="text-align: center; padding: 20px;">暂无资产记录，请添加或导入资产</td>`;
                tableBody.appendChild(emptyRow);
                return;
            }
            
            // 按购买日期排序，取最近3条 - 使用自定义排序函数优化性能
            const recentAssets = [...assetsData].sort((a, b) => {
                // 避免重复创建Date对象
                const dateA = a.purchaseDate ? new Date(a.purchaseDate).getTime() : 0;
                const dateB = b.purchaseDate ? new Date(b.purchaseDate).getTime() : 0;
                return dateB - dateA;
            }).slice(0, 3);
            
            // 使用文档片段减少DOM重绘
            const fragment = document.createDocumentFragment();
            recentAssets.forEach(asset => {
                const { row } = createAssetTableRow(asset);
                fragment.appendChild(row);
            });
            
            tableBody.appendChild(fragment);
        });
    }, 50);
}

// 渲染损坏设备列表 - 使用防抖和requestAnimationFrame优化
let renderDamagedTimeout;
function renderDamagedAssets() {
    // 防抖处理
    if (renderDamagedTimeout) clearTimeout(renderDamagedTimeout);
    
    renderDamagedTimeout = setTimeout(() => {
        const tableBody = document.getElementById('damaged-assets-table');
        
        if (!tableBody) return;
        
        requestAnimationFrame(() => {
            tableBody.innerHTML = '';
            
            // 使用单次遍历筛选损坏设备，避免创建新数组
            const damagedAssets = [];
            for (let i = 0; i < assetsData.length; i++) {
                if (assetsData[i].status === 'damaged') {
                    damagedAssets.push(assetsData[i]);
                }
            }
            
            if (damagedAssets.length === 0) {
                const { colspan } = createAssetTableRow({}, true);
                const emptyRow = document.createElement('tr');
                emptyRow.innerHTML = `<td colspan="${colspan}" style="text-align: center; padding: 20px;">暂无损坏设备记录</td>`;
                tableBody.appendChild(emptyRow);
                return;
            }
            
            // 使用文档片段减少DOM重绘
            const fragment = document.createDocumentFragment();
            damagedAssets.forEach(asset => {
                const { row } = createAssetTableRow(asset, true);
                fragment.appendChild(row);
            });
            
            tableBody.appendChild(fragment);
        });
    }, 50);
}

// 渲染所有资产 - 实现虚拟滚动和批量渲染
let renderTimeout;
let searchTimeout;
