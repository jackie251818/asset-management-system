/**
 * 事件监听绑定（核心事件 + 依赖数据的事件）
 * 从 script.js 拆分而来 - 请勿手动修改行号映射
 */

function bindDataDependentEventListeners() {
    try {
        // 初始化筛选区域的 CustomSelect 实例
        initFilterCustomSelects();

        // 初始化资产表单的 CustomSelect 实例
        initFormCustomSelects();

        // 恢复之前保存的筛选值（如果有）
        if (window._pendingFilterRestore) {
            restoreFilterCustomSelects(window._pendingFilterRestore);
            window._pendingFilterRestore = null;
        }

        // 导入数据功能
        document.getElementById('import-excel').addEventListener('click', () => {
            document.getElementById('file-import-excel').click();
        });
        
        document.getElementById('import-json').addEventListener('click', () => {
            document.getElementById('file-import-json').click();
        });
        
        document.getElementById('file-import-excel').addEventListener('change', handleExcelImport);
        document.getElementById('file-import-json').addEventListener('change', handleJsonImport);
        
        // 导出数据功能
        document.getElementById('export-excel').addEventListener('click', exportToExcel);
        document.getElementById('export-json').addEventListener('click', exportToJson);
        
        // 下载Excel模板
        document.getElementById('download-template').addEventListener('click', downloadExcelTemplate);

        // 系统设置 - 数据目录面板：展示数据路径、一键打开、复制路径、版本号 / 构建时间
        try {
            const dataDirPanel = document.getElementById('data-dir-panel');
            if (dataDirPanel) {
                (async function initDataDirPanel() {
                    const pathEl = document.getElementById('data-dir-path');
                    const hintEl = document.getElementById('data-dir-hint');
                    const verEl = document.getElementById('app-version');
                    const buildEl = document.getElementById('app-build-time');
                    const channelEl = document.getElementById('app-build-channel');
                    let dataDir = '';
                    let exeDir = '';
                    let packageVersion = '';
                    let buildTime = '';
                    let buildChannel = '';
                    try {
                        if (window.__SERVER_URL__ && typeof fetch === 'function') {
                            const resp = await fetch(window.__SERVER_URL__ + '/api/info');
                            if (resp && resp.ok) {
                                const info = await resp.json();
                                if (info && info.success) {
                                    dataDir = info.dataDir || '';
                                    exeDir = info.portableExecutableDir || '';
                                    packageVersion = info.packageVersion || '';
                                    buildTime = info.buildTime || '';
                                    buildChannel = info.buildChannel || '';
                                }
                            }
                        }
                    } catch (_) {}
                    // 兜底：直接读取主进程注入或 package
                    const bi = (typeof window.__BUILD_INFO__ === 'object') ? window.__BUILD_INFO__ : null;
                    if (bi) {
                        if (!packageVersion) packageVersion = bi.version || '';
                        if (!buildTime) buildTime = bi.buildTime || '';
                        if (!buildChannel) buildChannel = bi.channel || '';
                    }
                    // 兜底：本地方案（file:// 打开时,data 目录 = document.location 同级 data/）
                    if (!dataDir) {
                        try {
                            const here = (document.location && document.location.pathname) ? decodeURIComponent(document.location.pathname) : '';
                            if (here && here.length > 1) {
                                dataDir = here.replace(/^\/([A-Z]:\/)/i,'$1').replace(/[^/\\]+$/, '') + 'data';
                            }
                        } catch (_) {}
                    }
                    if (pathEl && dataDir) pathEl.textContent = dataDir;
                    if (verEl) {
                        verEl.textContent = packageVersion ? ('v' + packageVersion) : '未打包';
                    }
                    if (buildEl) {
                        buildEl.textContent = buildTime ? new Date(buildTime).toLocaleString('zh-CN', { hour12: false }) : '源码模式';
                    }
                    if (channelEl) {
                        if (buildChannel) channelEl.textContent = '渠道: ' + buildChannel;
                        else channelEl.textContent = '';
                    }
                    if (hintEl) {
                        const inExe = !!(exeDir && dataDir && (dataDir.indexOf(exeDir.replace(/\\/g,'/')) === 0 || dataDir.startsWith(exeDir)));
                        if (inExe) {
                            hintEl.innerHTML = '✅ 当前为<strong>传统便携模式</strong>：数据保存在 exe 旁的 data/ 目录（U盘/硬盘携带时使用）。如想关闭，请删除 exe 旁的 <code>.portable</code> / <code>便携模式.dat</code> 文件。';
                        } else {
                            hintEl.innerHTML = '🛡️ 当前数据存储在<strong>用户目录</strong>下（更安全，不会在桌面被误删）。如需「数据跟 exe 走」，请在 exe 旁边新建空文件 <code>.portable</code> 或 <code>便携模式.dat</code>，重启程序即生效。';
                        }
                    }

                    function getTokenHeaders(extra) {
                        const h = Object.assign({}, extra || {});
                        if (typeof window !== 'undefined' && window.__SERVER_TOKEN__) {
                            h['X-Server-Token'] = window.__SERVER_TOKEN__;
                        }
                        return h;
                    }

                    const openBtn = document.getElementById('open-data-dir');
                    if (openBtn) {
                        openBtn.addEventListener('click', async () => {
                            try {
                                if (!window.__SERVER_URL__) {
                                    showNotification('纯浏览器模式不支持直接打开目录，请手动复制上方路径', 'warning');
                                    return;
                                }
                                const resp = await fetch(window.__SERVER_URL__ + '/api/exec', {
                                    method: 'POST',
                                    headers: getTokenHeaders({ 'Content-Type': 'application/json' }),
                                    body: JSON.stringify({ action: 'openDataDir' })
                                });
                                if (resp && resp.ok) {
                                    const r = await resp.json();
                                    if (!r || !r.success) showNotification(r && r.error ? r.error : '打开目录失败', 'warning');
                                } else if (resp && resp.status === 401) {
                                    showNotification('权限校验失败，请刷新页面后重试', 'error');
                                } else {
                                    showNotification('无法调用本地服务器打开目录（当前为纯浏览器模式，请手动复制上方路径）', 'warning');
                                }
                            } catch (e) {
                                showNotification('打开目录失败：' + (e && e.message ? e.message : e), 'error');
                            }
                        });
                    }

                    const copyBtn = document.getElementById('copy-data-dir');
                    if (copyBtn) {
                        copyBtn.addEventListener('click', async () => {
                            if (!dataDir) { showNotification('暂无数据路径', 'warning'); return; }
                            try {
                                if (navigator.clipboard && navigator.clipboard.writeText) {
                                    await navigator.clipboard.writeText(dataDir);
                                    showNotification('路径已复制到剪贴板', 'success');
                                } else {
                                    const ta = document.createElement('textarea');
                                    ta.value = dataDir;
                                    document.body.appendChild(ta);
                                    ta.select();
                                    document.execCommand('copy');
                                    document.body.removeChild(ta);
                                    showNotification('路径已复制到剪贴板', 'success');
                                }
                            } catch (e) {
                                showNotification('复制失败：' + (e && e.message ? e.message : e), 'error');
                            }
                        });
                    }
                })();
            }
        } catch (e) {
            // 数据目录面板为可选增强,失败不阻塞其余逻辑
            console.warn('[events] 数据目录面板初始化失败：', e && e.message ? e.message : e);
        }
        
        // 状态选择联动显示损坏原因
        document.getElementById('status').addEventListener('change', (e) => {
            const damageGroup = document.getElementById('damage-reason-group');
            damageGroup.style.display = e.target.value === 'damaged' ? 'block' : 'none';
        });
        
        // 添加资产表单提交
        document.getElementById('add-asset-form').addEventListener('submit', handleAddAsset);
        
        // 文件上传预览
        document.getElementById('file-upload').addEventListener('change', handleFileUpload);
        
        // 系统设置表单提交
        document.getElementById('settings-form').addEventListener('submit', function(e) {
            e.preventDefault();
            
            // 更新每页显示记录数
            const recordsPerPageSelect = document.getElementById('records-per-page');
            if (recordsPerPageSelect) {
                const newRecordsPerPage = parseInt(recordsPerPageSelect.value);
                // 只有在实际更改了每页显示数量时才重置到第一页
                if (newRecordsPerPage !== recordsPerPage) {
                    recordsPerPage = newRecordsPerPage;
                    currentPage = 1;
                    hasUnsavedChanges = true;
                    // 同步更新资产列表页面的下拉选择器
                    if (document.getElementById('page-size-selector')) {
                        document.getElementById('page-size-selector').value = newRecordsPerPage;
                    }
                }
            }
            
            // 更新系统名称（侧边栏、移动端顶栏、浏览器标签页三处同步）
            updateSystemTitle();
            hasUnsavedChanges = true;

            // 立即保存设置到本地存储
            saveToLocalStorage();
            
            // 刷新资产列表以应用新的分页设置
            renderAllAssets();
            
            showNotification('设置已保存', 'success');
        });
        
        // 系统名称输入时实时更新标题（无需等待保存）
        const systemNameInput = document.getElementById('system-name');
        if (systemNameInput) {
            systemNameInput.addEventListener('input', function() {
                updateSystemTitle(this.value);
            });
        }
        
        // 重置设置后同步更新标题
        const settingsForm = document.getElementById('settings-form');
        if (settingsForm) {
            settingsForm.addEventListener('reset', function() {
                setTimeout(() => {
                    updateSystemTitle();
                }, 0);
            });
        }
        
        // 清空所有数据
        document.getElementById('clear-all-data').addEventListener('click', function() {
            if (confirm('确定要清空所有资产数据吗？此操作不可恢复！')) {
                assetsData = [];
                updateStatistics();
                renderRecentAssets();
                renderDamagedAssets();
                renderAllAssets();
                saveToLocalStorage();
                alert('所有数据已清空');
            }
        });
        
        // 备份数据功能 - 导出JSON文件
        document.getElementById('backup-data').addEventListener('click', function() {
            try {
                showLoadingIndicator();
                
                // 收集用户状态数据（确保元素存在时再读取，避免null引用）
                const systemSettings = {};
                const systemNameEl = document.getElementById('system-name');
                const dateFormatEl = document.getElementById('date-format');
                if (systemNameEl) systemSettings.systemName = systemNameEl.value;
                if (dateFormatEl) systemSettings.dateFormat = dateFormatEl.value;
                if (typeof recordsPerPage !== 'undefined') systemSettings.recordsPerPage = recordsPerPage;
                
                // 创建备份数据对象
                const backupData = {
                    version: (storageManager && storageManager.dataVersion) || '2.4.0',
                    timestamp: new Date().toISOString(),
                    assetsData: JSON.parse(JSON.stringify(assetsData || [])),
                    userState: {
                        systemSettings: Object.keys(systemSettings).length > 0 ? systemSettings : {
                            systemName: '电脑资产管理系统',
                            dateFormat: 'yyyy/mm/dd',
                            recordsPerPage: 20
                        }
                    }
                };
                
                // 转换为JSON字符串并创建下载链接
                const dataStr = JSON.stringify(backupData, null, 2);
                const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
                const now = new Date();
                const datePart = now.toLocaleDateString().replace(/\//g, '-');
                const timePart = now.toLocaleTimeString().replace(/:/g, '-');
                const exportFileDefaultName = `资产数据备份_${datePart}_${timePart}.json`;
                
                const linkElement = document.createElement('a');
                linkElement.setAttribute('href', dataUri);
                linkElement.setAttribute('download', exportFileDefaultName);
                document.body.appendChild(linkElement);
                linkElement.click();
                document.body.removeChild(linkElement);
                
                setTimeout(() => {
                    hideLoadingIndicator();
                    alert('数据备份成功！文件已下载到您的电脑。');
                }, 500);
            } catch (error) {
                console.error('数据备份失败:', error);
                hideLoadingIndicator();
                alert('数据备份失败，请重试。\n错误: ' + (error.message || error));
            }
        });
        
        // 恢复数据按钮点击事件
        document.getElementById('restore-data').addEventListener('click', function() {
            if (confirm('确定要恢复数据吗？当前数据将被替换，此操作不可恢复！')) {
                document.getElementById('file-restore').click();
            }
        });

        // 连接数据文件夹按钮（本地模式文件同步）
        const connectBtn = document.getElementById('connect-data-folder-btn');
        if (connectBtn) {
            connectBtn.addEventListener('click', async function() {
                if (storageManager.connectDataFolder) {
                    const success = await storageManager.connectDataFolder();
                    updateFileSyncStatus();
                    if (success) {
                        // 立即保存一次数据到 .js 文件
                        saveToLocalStorage();
                    }
                } else {
                    alert('当前环境不支持文件同步功能');
                }
            });
        }

        // 断开数据文件夹按钮
        const disconnectBtn = document.getElementById('disconnect-data-folder-btn');
        if (disconnectBtn) {
            disconnectBtn.addEventListener('click', async function() {
                if (!storageManager.isFileSyncEnabled && !storageManager.dataDirHandle) {
                    showNotification('当前未连接数据文件夹', 'info');
                    return;
                }
                if (!confirm('确定要断开数据文件夹吗？\n\n断开后：\n• 数据将只保存在浏览器内部（IndexedDB/localStorage）\n• 再次刷新页面不会自动恢复连接\n• 下次点击"连接"按钮可恢复（无需重新选择文件夹）')) {
                    return;
                }
                if (storageManager.disconnectDataFolder) {
                    const success = await storageManager.disconnectDataFolder();
                    updateFileSyncStatus();
                    if (success) {
                        showNotification('已断开数据文件夹连接', 'success');
                    } else {
                        showNotification('断开失败，请查看控制台日志', 'error');
                    }
                } else {
                    alert('当前环境不支持文件同步功能');
                }
            });
        }

        // 下载数据文件按钮（降级方案）
        const downloadBtn = document.getElementById('download-data-files-btn');
        if (downloadBtn) {
            downloadBtn.addEventListener('click', async function() {
                try {
                    // 下载所有核心数据文件
                    const assetData = await storageManager.getItem(STORAGE_KEYS.ASSET_MANAGEMENT_DATA);
                    const userState = await storageManager.getItem(STORAGE_KEYS.USER_STATE_DATA);

                    let downloadCount = 0;
                    if (assetData !== null) {
                        storageManager._downloadScriptFile(STORAGE_KEYS.ASSET_MANAGEMENT_DATA, assetData);
                        downloadCount++;
                    }
                    if (userState !== null) {
                        setTimeout(() => {
                            storageManager._downloadScriptFile(STORAGE_KEYS.USER_STATE_DATA, userState);
                        }, 300);
                        downloadCount++;
                    }

                    alert(`已下载 ${downloadCount} 个数据文件。\n\n请将下载的文件覆盖到项目的 data/ 目录下，\n下次打开时会自动加载最新数据。`);
                } catch (e) {
                    alert('下载数据文件失败: ' + e.message);
                }
            });
        }

        // 初始化文件同步状态显示
        updateFileSyncStatus();

        // 初始化本地模式文件同步提示横幅
        initFileSyncBanner();

        // 初始化同步状态指示器
        updateSyncIndicator();
        
        // 文件恢复事件处理 - 支持多版本数据恢复
        document.getElementById('file-restore').addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (!file) return;
            
            try {
                showLoadingIndicator();
                
                const reader = new FileReader();
                reader.onload = function(event) {
                    try {
                        const importedData = JSON.parse(event.target.result);
                        
                        // 验证备份文件格式 - 支持新旧版本格式
                        if (!importedData.version || (!importedData.assetsData && !Array.isArray(importedData))) {
                            throw new Error('无效的备份文件格式');
                        }
                        
                        // 处理不同版本的备份数据
                        if (importedData.assetsData) {
                            // 新版本格式
                            assetsData = importedData.assetsData;
                            
                            // 恢复系统设置
                            if (importedData.userState && importedData.userState.systemSettings) {
                                const systemSettings = importedData.userState.systemSettings;
                                
                                if (systemSettings.systemName) {
                                    const nameInput = document.getElementById('system-name');
                                    if (nameInput) nameInput.value = systemSettings.systemName;
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
                                }
                            }
                        } else if (Array.isArray(importedData)) {
                            // 旧版本格式（直接是资产数据数组）
                            assetsData = importedData;
                        }
                        
                        // 重置页码
                        currentPage = 1;
                        
                        // 刷新UI
                        updateStatistics();
                        renderRecentAssets();
                        renderDamagedAssets();
                        renderAllAssets();
                        
                        // 保存到本地存储 - 使用新的存储格式
                        saveToLocalStorage();
                        
                        // 隐藏加载指示器
                        setTimeout(() => {
                            hideLoadingIndicator();
                            alert('数据恢复成功！共恢复了 ' + assetsData.length + ' 条资产记录。\n\n数据已自动转换为最新格式并保存。');
                        }, 500);
                    } catch (error) {
                        console.error('恢复数据解析失败:', error);
                        hideLoadingIndicator();
                        alert('恢复数据失败：' + error.message);
                    }
                };
                
                reader.onerror = function() {
                    console.error('读取文件失败');
                    hideLoadingIndicator();
                    alert('读取备份文件失败，请重试。');
                };
                
                reader.readAsText(file);
            } catch (error) {
                console.error('恢复数据过程发生错误:', error);
                hideLoadingIndicator();
                alert('数据恢复过程发生错误，请重试。');
            }
            
            // 清空文件输入，以便可以再次选择同一个文件
            e.target.value = '';
        });
        
        // 搜索资产功能 - 回车搜索 + 实时搜索（统一防抖）
        const dashboardSearchInput = document.getElementById('dashboard-search');
        const dashboardSearchBtn = document.getElementById('dashboard-search-btn');
        if (dashboardSearchBtn) {
            dashboardSearchBtn.addEventListener('click', function() {
                const keyword = dashboardSearchInput ? dashboardSearchInput.value.trim() : '';
                searchAssets(keyword);
            });
        }
        if (dashboardSearchInput) {
            dashboardSearchInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    searchAssets(this.value.trim());
                }
            });
            dashboardSearchInput.addEventListener('input', function() {
                debounce('dashboard-search', () => searchAssets(this.value.trim()), 200);
            });
        }

        const assetsSearchInput = document.getElementById('assets-search');
        const assetsSearchBtn = document.getElementById('assets-search-btn');
        if (assetsSearchBtn) {
            assetsSearchBtn.addEventListener('click', function() {
                const keyword = assetsSearchInput ? assetsSearchInput.value.trim() : '';
                searchAssets(keyword);
            });
        }
        if (assetsSearchInput) {
            assetsSearchInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    searchAssets(this.value.trim());
                }
            });
            assetsSearchInput.addEventListener('input', function() {
                debounce('assets-search', () => searchAssets(this.value.trim()), 200);
            });
        }

        // 筛选功能 - 即时触发（统一防抖）
        const filterBtn = document.getElementById('filter-btn');
        if (filterBtn) {
            filterBtn.addEventListener('click', function() {
                debounce('filter', () => applyFilters(), 100);
            });
        }

        // 重置筛选功能
        document.getElementById('reset-filter-btn').addEventListener('click', function() {
            resetFilters();
        });

        // 重置所有筛选条件
        function resetFilters() {
            // 重置所有筛选器
            document.getElementById('status-filter').value = 'all';
            // 重置 CustomSelect 实例
            resetFilterCustomSelects();
            document.getElementById('date-from').value = '';
            document.getElementById('date-to').value = '';
            document.getElementById('assets-search').value = '';
            // 重置自定义筛选
            const customFieldSelect = document.getElementById('custom-field-select');
            const customFieldValue = document.getElementById('custom-field-value');
            if (customFieldSelect) customFieldSelect.value = '';
            if (customFieldValue) customFieldValue.value = '';
            
            // 重置当前页码
            currentPage = 1;
            
            // 重新应用筛选（显示所有资产）
            renderAllAssets();
            
            // 更新统计数据
            updateStatistics();
        }
        
        // 为原生筛选器添加change事件监听（CustomSelect 有自己的 onChange）
        const nativeFilters = ['status-filter', 'date-from', 'date-to'];
        nativeFilters.forEach(filterId => {
            const filterElement = document.getElementById(filterId);
            if (filterElement) {
                filterElement.addEventListener('change', function() {
                    debounce('filter', () => applyFilters(), 100);
                });
            }
        });
        
        // 每页显示数量变更事件监听 - 修复资产列表每页显示功能
        const pageSizeSelector = document.getElementById('page-size-selector');
        if (pageSizeSelector) {
            pageSizeSelector.addEventListener('change', function() {
                const newRecordsPerPage = parseInt(pageSizeSelector.value);
                if (newRecordsPerPage !== recordsPerPage) {
                    recordsPerPage = newRecordsPerPage;
                    currentPage = 1;
                    hasUnsavedChanges = true;
                    // 同步更新系统设置页面的下拉选择器
                    if (document.getElementById('records-per-page')) {
                        document.getElementById('records-per-page').value = newRecordsPerPage;
                    }
                    // 应用当前筛选条件重新渲染
                    applyFilters();
                }
            });
        }
        
        // 资产相关操作事件委托
        document.addEventListener('click', function(e) {
            // 查看资产详情
            if (e.target.closest('.view-asset')) {
                const assetId = e.target.closest('.view-asset').dataset.id;
                viewAssetDetails(assetId);
            }
            // 删除维护记录
            else if (e.target.closest('.delete-maintenance')) {
                const index = parseInt(e.target.closest('.delete-maintenance').dataset.index);
                deleteMaintenanceRecord(index);
            }
            // 移除上传文件
            else if (e.target.closest('.remove-file')) {
                const index = parseInt(e.target.closest('.remove-file').dataset.index);
                e.target.closest('.file-preview').remove();
            }
        });
        
        // 资产详情页按钮
        document.getElementById('add-maintenance-record').addEventListener('click', showAddMaintenanceDialog);
        document.getElementById('print-asset').addEventListener('click', printAssetCard);
        document.getElementById('print-label').addEventListener('click', openLabelPrintPage);
        document.getElementById('upload-template-btn').addEventListener('click', uploadAssetCardTemplate);
        
        // 图片查看器相关事件
        if (!modal) {
            modal = getElement('image-viewer-modal');
        }
        if (!closeBtn) {
            closeBtn = document.querySelector('.close-btn');
        }
        
        // 关闭文件查看器
        const closeFileViewer = function() {
            if (modal && typeof modal.cleanupImageZoomControls === 'function') {
                modal.cleanupImageZoomControls();
            }
            if (modal) {
                modal.classList.remove('active');
                modal.style.display = '';
            }
            // 清理 iframe 内容，避免 PDF 占用资源
            const pdfElement = document.getElementById('modal-pdf');
            if (pdfElement) pdfElement.src = '';
            const imageElement = getElement('modal-image');
            if (imageElement) imageElement.src = '';
            resetImageZoom();
        };

        // 关闭按钮点击事件
        if (closeBtn) {
            closeBtn.onclick = closeFileViewer;
        }

        // 底部返回按钮
        const modalCloseBtn = document.getElementById('modal-close-btn');
        if (modalCloseBtn) {
            modalCloseBtn.onclick = closeFileViewer;
        }

        // 点击模态框外部关闭
        const windowClickHandler = function(e) {
            if (e.target === modal) {
                closeFileViewer();
            }
        };
        window.onclick = windowClickHandler;

        // ESC 键关闭
        const escHandler = function(e) {
            if (e.key === 'Escape' && modal && modal.classList.contains('active')) {
                closeFileViewer();
            }
        };
        document.onkeydown = escHandler;
        
        // 缩放控制事件委托（支持图片和PDF）
        document.querySelector('.modal-controls').addEventListener('click', function(e) {
            const zoomBtn = e.target.closest('.zoom-btn');
            if (zoomBtn) {
                const action = zoomBtn.dataset.action;
                const image = getElement('modal-image');
                const pdf = document.getElementById('modal-pdf');
                const target = (image && image.style.display !== 'none') ? image : pdf;
                
                if (!target) return;

                if (action === 'zoom-in') {
                    currentZoom = (typeof currentZoom !== 'number' ? 1 : currentZoom) + 0.1;
                } else if (action === 'zoom-out') {
                    currentZoom = Math.max(0.1, (typeof currentZoom !== 'number' ? 1 : currentZoom) - 0.1);
                } else if (action === 'zoom-reset') {
                    currentZoom = 1;
                    translateX = 0;
                    translateY = 0;
                }
                
                target.style.transition = 'transform 0.2s ease';
                target.style.transformOrigin = 'center center';
                target.style.transform = `scale(${currentZoom})`;
            }
        });
    } catch (error) {
        console.error('绑定数据相关事件监听时发生错误:', error);
    }
}

// 更新文件同步状态显示
function updateFileSyncStatus() {
    const statusElement = document.getElementById('file-sync-status-text');
    const statusBox = document.getElementById('file-sync-status');
    const connectBtn = document.getElementById('connect-data-folder-btn');
    const disconnectBtn = document.getElementById('disconnect-data-folder-btn');
    if (!statusElement || !statusBox) return;

    // 等待 storageManager 完整初始化完成（仅等待一次，防止递归）
    if (storageManager._initPromise && !updateFileSyncStatus._waited) {
        updateFileSyncStatus._waited = true;
        storageManager._initPromise.then(() => {
            updateFileSyncStatus();
        }).catch(() => {
            updateFileSyncStatus();
        });
        return;
    }

    if (storageManager.fileApiReady) {
        // 服务器模式 — 不需要连接/断开按钮（已自动保存）
        statusBox.style.background = '#e6f7ff';
        statusBox.style.borderColor = '#91d5ff';
        // 区分单机(内嵌服务)与 C/S 服务器模式, 文案分别表述
        const isEmbedded = typeof ApiClient !== 'undefined' && ApiClient.embeddedMode === true;
        statusElement.innerHTML = isEmbedded
            ? '✅ <strong>单机模式</strong>：数据通过内嵌服务自动保存到本机 JSON 文件（见上方「数据保存位置」），无需手动同步。'
            : '✅ <strong>服务器模式</strong>：数据通过服务器自动保存到 JSON 文件，无需手动同步。';
        if (connectBtn) connectBtn.style.display = 'none';
        if (disconnectBtn) disconnectBtn.style.display = 'none';
    } else if (storageManager.isFileSyncEnabled && storageManager.dataDirHandle) {
        // 本地模式 + 文件同步已启用 — 隐藏连接按钮，显示断开按钮
        statusBox.style.background = '#f6ffed';
        statusBox.style.borderColor = '#b7eb8f';
        statusElement.innerHTML = '✅ <strong>文件同步已启用</strong>：数据会自动保存到 data/*.js 文件，下次打开时自动加载最新数据。';
        if (connectBtn) connectBtn.style.display = 'none';
        if (disconnectBtn) disconnectBtn.style.display = '';
    } else if ('showDirectoryPicker' in window) {
        // 本地模式 + 浏览器支持但未连接 — 显示连接按钮供用户手动触发
        statusBox.style.background = '#e6f7ff';
        statusBox.style.borderColor = '#91d5ff';
        statusElement.innerHTML = '⏳ <strong>文件同步未启用</strong>：点击上方"连接数据文件夹"按钮或此处的"连接"按钮启用文件同步，启用后数据将自动保存到 data/*.js 文件。<br>当前协议: ' + window.location.protocol + '，数据来源: ' + (typeof window.__LOCAL_DATA__ !== 'undefined' ? 'data/*.js 已加载' : 'IndexedDB/localStorage');
        if (connectBtn) connectBtn.style.display = '';
        if (disconnectBtn) disconnectBtn.style.display = 'none';
    } else {
        // 本地模式 + 浏览器不支持 — 两个按钮都不显示
        statusBox.style.background = '#fff1f0';
        statusBox.style.borderColor = '#ffa39e';
        statusElement.innerHTML = '❌ <strong>浏览器不支持文件同步</strong>：请使用"下载数据文件"按钮手动保存数据到 data/*.js 文件。<br>建议使用 Chrome 86+ 或 Edge 86+ 浏览器以获得最佳体验。';
        if (connectBtn) connectBtn.style.display = 'none';
        if (disconnectBtn) disconnectBtn.style.display = 'none';
    }
}

// 初始化本地模式文件同步提示横幅
function initFileSyncBanner() {
    const banner = document.getElementById('file-sync-banner');
    if (!banner) return;

    // 等待 storageManager 初始化完成
    const checkBanner = () => {
        if (storageManager._initPromise) {
            storageManager._initPromise.then(() => {
                checkBannerState();
            }).catch(() => {
                checkBannerState();
            });
        } else {
            setTimeout(checkBanner, 100);
        }
    };

    function checkBannerState() {
        // 仅在本地模式（file:// 或无服务器）且文件同步未启用时显示
        const isLocalProtocol = window.location.protocol === 'file:';
        const isServerMode = storageManager.fileApiReady;
        const isFileSynced = storageManager.isFileSyncEnabled;

        if (isLocalProtocol && !isServerMode && !isFileSynced) {
            // 本地模式且未启用文件同步 — 显示横幅引导用户连接
            banner.style.display = 'flex';
            if (!('showDirectoryPicker' in window)) {
                // 浏览器不支持 File System Access API — 显示下载提示
                const connectBtn = document.getElementById('banner-connect-folder-btn');
                if (connectBtn) {
                    connectBtn.textContent = '下载数据文件';
                    connectBtn.onclick = null;
                    connectBtn.addEventListener('click', function() {
                        const downloadBtn = document.getElementById('download-data-files-btn');
                        if (downloadBtn) downloadBtn.click();
                    });
                }
            }
            // 浏览器支持时保持原有"连接数据文件夹"按钮文字，
            // 用户点击即触发 showDirectoryPicker（用户手势满足浏览器安全要求）
        } else {
            banner.style.display = 'none';
        }
    }

    // 横幅"连接数据文件夹"按钮事件
    const connectBtn = document.getElementById('banner-connect-folder-btn');
    if (connectBtn) {
        connectBtn.addEventListener('click', async function() {
            if (storageManager.connectDataFolder) {
                const success = await storageManager.connectDataFolder();
                if (success) {
                    banner.style.display = 'none';
                    saveToLocalStorage();
                }
            }
        });
    }

    // 横幅关闭按钮
    const dismissBtn = document.getElementById('banner-dismiss-btn');
    if (dismissBtn) {
        dismissBtn.addEventListener('click', function() {
            banner.style.display = 'none';
            // 记住用户关闭了横幅，本次会话不再显示
            sessionStorage.setItem('banner-dismissed', '1');
        });
    }

    // 如果用户本次会话已关闭横幅，不再显示
    if (sessionStorage.getItem('banner-dismissed') === '1') {
        banner.style.display = 'none';
        return;
    }

    checkBanner();
}

/**
 * 显示同步状态 Toast 提示
 * @param {string} message - 提示消息
 * @param {string} type - 类型: 'success' | 'info' | 'error'
 */
function showSyncToast(message, type = 'info') {
    // 移除已有的 toast
    const existing = document.getElementById('sync-toast');
    if (existing) existing.remove();

    const colors = {
        success: { bg: '#f6ffed', border: '#b7eb8f', text: '#389e0d', icon: 'fa-check-circle' },
        info:    { bg: '#e6f7ff', border: '#91d5ff', text: '#096dd9', icon: 'fa-info-circle' },
        error:   { bg: '#fff2f0', border: '#ffccc7', text: '#cf1322', icon: 'fa-exclamation-circle' }
    };
    const c = colors[type] || colors.info;

    const toast = document.createElement('div');
    toast.id = 'sync-toast';
    toast.style.cssText = `position:fixed; top:20px; right:20px; z-index:10000; background:${c.bg}; border:1px solid ${c.border}; color:${c.text}; padding:12px 20px; border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,0.1); display:flex; align-items:center; gap:10px; font-size:14px; transition:opacity 0.3s, transform 0.3s; opacity:0; transform:translateX(20px);`;
    toast.innerHTML = `<i class="fas ${c.icon}" style="font-size:18px;"></i><span>${message}</span>`;
    document.body.appendChild(toast);

    // 动画进入
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(0)';
    });

    // 3秒后自动消失
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

/**
 * 更新同步状态指示器
 */
function updateSyncIndicator() {
    const indicator = document.getElementById('sync-indicator');
    if (!indicator) return;

    if (storageManager.isFileSyncEnabled) {
        indicator.style.display = 'inline-flex';
        indicator.title = '文件同步已启用 - 数据自动保存到 data/*.js 文件';
        const dot = indicator.querySelector('.sync-dot');
        if (dot) dot.style.background = '#52c41a';
    } else {
        indicator.style.display = 'none';
    }
}

/**
 * 只刷新当前活跃页面的内容，不切换页面
 * @param {boolean} dataChanged - 数据是否有变化
 */
function refreshActivePageContent(dataChanged) {
    const activePage = document.querySelector('.page-content.active');
    if (!activePage) return;

    const pageId = activePage.id;

    switch (pageId) {
        case 'dashboard-page':
            if (typeof renderRecentAssets === 'function') renderRecentAssets();
            if (typeof renderDamagedAssets === 'function') renderDamagedAssets();
            break;
        case 'assets-page':
            if (typeof renderAllAssets === 'function') renderAllAssets();
            break;
        case 'reports-page':
            if (typeof renderAllReportsCharts === 'function') renderAllReportsCharts();
            break;
        // 其他页面无需特殊刷新
    }
}

// 页面加载完成后初始化

function bindCoreEventListeners() {
    // 侧边栏菜单事件委托
    const sidebarElement = document.querySelector('.sidebar');
    
    if (sidebarElement) {
        sidebarElement.addEventListener('click', (e) => {
            const menuItem = e.target.closest('.menu-item');
            
            if (menuItem) {
                const targetPage = menuItem.dataset.target;
                
                // 检查菜单项是否有正确的data-target属性
                if (!targetPage) {
                    console.error('菜单项缺少data-target属性:', menuItem);
                } else {
                    // 确认目标页面元素存在
                    const pageElement = document.getElementById(`${targetPage}-page`);
                    
                    if (!pageElement) {
                        console.error('目标页面不存在:', targetPage + '-page');
                    } else {
                        // 尝试手动执行页面切换逻辑
                        try {
                            switchPage(targetPage);
                        } catch (error) {
                            console.error('页面切换函数执行失败:', error);
                        }
                    }
                }
            }
        });
    } else {
        console.error('未找到侧边栏元素');
    }
    
    // 面包屑导航事件委托
    document.addEventListener('click', (e) => {
        if (e.target.closest('.go-to-dashboard')) {
            e.preventDefault();
            switchPage('dashboard');
        } else if (e.target.closest('.go-to-assets')) {
            e.preventDefault();
            switchPage('assets');
        }
    });
    
    // 查看全部资产按钮
    document.getElementById('view-all-assets').addEventListener('click', () => {
        switchPage('assets');
    });
    
    // 刷新按钮事件监听器（支持从 .js 文件手动同步数据）
    const refreshDashboardBtn = document.getElementById('refresh-dashboard');
    if (refreshDashboardBtn) {
        refreshDashboardBtn.addEventListener('click', async () => {
            // 显示加载状态
            refreshDashboardBtn.classList.add('loading');
            refreshDashboardBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 同步中...';

            try {
                let dataChanged = false;

                // 如果文件同步已启用，先从 .js 文件同步数据
                if (storageManager.isFileSyncEnabled && storageManager.dataDirHandle) {
                    const syncResult = await storageManager.syncFromFiles();
                    dataChanged = syncResult.changed;

                    // 如果数据有变化，重新加载到全局变量
                    if (dataChanged) {
                        for (const detail of syncResult.details) {
                            if (detail.status === 'file_to_idb') {
                                const newData = await storageManager.getItem(detail.key);
                                if (detail.key === 'assetManagementData') {
                                    assetsData = newData || [];
                                }
                            }
                        }
                    }
                }

                // 重新计算并更新统计数据（所有页面的统计卡片）
                updateStatistics();

                // 只刷新当前活跃页面的内容，不切换页面
                refreshActivePageContent(dataChanged);

                if (dataChanged) {
                    showSyncToast('数据已从文件同步', 'success');
                }
            } catch(e) {
                console.error('刷新出错:', e);
                showSyncToast('刷新失败: ' + e.message, 'error');
            } finally {
                // 恢复按钮状态
                setTimeout(() => {
                    refreshDashboardBtn.classList.remove('loading');
                    refreshDashboardBtn.innerHTML = '<i class="fas fa-sync-alt"></i> 刷新';
                }, 300);
            }
        });
    }

    // 注册文件变化回调（自动检测到其他浏览器修改时触发）
    if (storageManager.onFileChange) {
        storageManager.onFileChange(async (changedKeys) => {
            // 内部写入期间（如自动连接同步）已由 storageManager._notifyFileChange 过滤，
            // 此处再做一次防御性检查
            if (storageManager._suppressWatchNotification) return;
            // 重新加载变化的数据到全局变量
            for (const item of changedKeys) {
                if (item.key === 'assetManagementData') {
                    assetsData = item.data || [];
                }
                // 自定义下拉选项变化时，重新加载 CustomSelect 实例
                if (item.key.startsWith('custom_options_')) {
                    // 找到对应的 CustomSelect 实例并刷新
                    const instanceMap = {
                        'custom_options_owner': 'owner',
                        'custom_options_type': 'type',
                        'custom_options_department': 'department',
                        'custom_options_owner_deleted': 'owner',
                        'custom_options_type_deleted': 'type',
                        'custom_options_department_deleted': 'department'
                    };
                    const instanceKey = instanceMap[item.key];
                    if (instanceKey && typeof customSelectInstances !== 'undefined' && customSelectInstances[instanceKey]) {
                        // 更新内存中的数据
                        if (item.key.endsWith('_deleted')) {
                            customSelectInstances[instanceKey]._deletedPresets = item.data || [];
                        } else {
                            customSelectInstances[instanceKey].customOptions = item.data || [];
                        }
                        // 重新加载并重建选项
                        customSelectInstances[instanceKey].loadOptionsSync();
                        customSelectInstances[instanceKey].rebuildOptions();
                    }
                    // 同步刷新表单中的 CustomSelect
                    if (typeof formCustomSelects !== 'undefined' && formCustomSelects[instanceKey]) {
                        if (item.key.endsWith('_deleted')) {
                            formCustomSelects[instanceKey]._deletedPresets = item.data || [];
                        } else {
                            formCustomSelects[instanceKey].customOptions = item.data || [];
                        }
                        formCustomSelects[instanceKey].loadOptionsSync();
                        formCustomSelects[instanceKey].rebuildOptions();
                    }
                    if (typeof editFormCustomSelects !== 'undefined' && editFormCustomSelects[instanceKey]) {
                        if (item.key.endsWith('_deleted')) {
                            editFormCustomSelects[instanceKey]._deletedPresets = item.data || [];
                        } else {
                            editFormCustomSelects[instanceKey].customOptions = item.data || [];
                        }
                        editFormCustomSelects[instanceKey].loadOptionsSync();
                        editFormCustomSelects[instanceKey].rebuildOptions();
                    }
                }
            }

            // 更新统计数据（所有页面的统计卡片，不会切换页面）
            if (typeof updateStatistics === 'function') updateStatistics();

            // 只刷新当前活跃页面的内容，不切换页面
            refreshActivePageContent(true);

            // 显示同步提示
            const changedNames = changedKeys.map(c => {
                const nameMap = {
                    'assetManagementData': '资产数据',
                    'userStateData': '用户状态',
                    'systemSettings': '系统设置',
                    'categoryOptions': '分类选项',
                    'printRecords': '打印记录',
                    'labelPrintRecords': '标签打印记录',
                    'custom_options_owner': '主体选项',
                    'custom_options_type': '设备类型选项',
                    'custom_options_department': '部门选项',
                    'custom_options_owner_deleted': '主体删除选项',
                    'custom_options_type_deleted': '设备类型删除选项',
                    'custom_options_department_deleted': '部门删除选项'
                };
                return nameMap[c.key] || c.key;
            });
            showSyncToast(`检测到数据变化: ${changedNames.join('、')}`, 'info');
        });
    }
    
    // 资产详情页面的编辑和删除按钮事件监听
    document.addEventListener('click', function(e) {
        // 为编辑按钮添加事件监听
        if (e.target.closest('#edit-asset-btn')) {
            e.preventDefault();
            enterEditMode();
        }
        
        // 为删除按钮添加事件监听
        if (e.target.closest('#delete-asset-btn')) {
            e.preventDefault();
            // 检查是否处于编辑模式（限定在活动页面内）
            const activePage = getActivePage();
            const isEditMode = activePage ? activePage.querySelector('.edit-form') !== null : false;
            if (isEditMode) {
                // 取消编辑
                cancelEditMode();
            } else {
                // 确认删除
                confirmDeleteAsset();
            }
        }
    });
    
    // 移动端汉堡菜单
    initMobileMenu();
}

// ==================== 移动端菜单功能 ====================
function initMobileMenu() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const menuBtn = document.getElementById('mobile-menu-btn');
    
    if (!sidebar || !overlay || !menuBtn) return;
    
    function openSidebar() {
        sidebar.classList.add('active');
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
    
    function closeSidebar() {
        sidebar.classList.remove('active');
        overlay.classList.remove('active');
        document.body.style.overflow = '';
    }
    
    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (sidebar.classList.contains('active')) {
            closeSidebar();
        } else {
            openSidebar();
        }
    });
    
    overlay.addEventListener('click', closeSidebar);
    
    // 菜单项点击后自动关闭侧边栏（移动端）
    const sidebarItems = sidebar.querySelectorAll('.menu-item');
    sidebarItems.forEach(item => {
        item.addEventListener('click', () => {
            if (window.innerWidth <= 768) {
                setTimeout(closeSidebar, 100);
            }
        });
    });
    
    // ESC 键关闭
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && sidebar.classList.contains('active')) {
            closeSidebar();
        }
    });
    
    // 窗口尺寸变化时重置状态
    window.addEventListener('resize', () => {
        if (window.innerWidth > 768 && sidebar.classList.contains('active')) {
            closeSidebar();
        }
    });
    
    // 暴露到全局
    window.toggleSidebar = function() {
        if (sidebar.classList.contains('active')) {
            closeSidebar();
        } else {
            openSidebar();
        }
    };
    
    window.closeSidebar = closeSidebar;
    window.openSidebar = openSidebar;
}

// 重置图片缩放
