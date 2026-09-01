/**
 * Excel/JSON 导入导出、模板下载、XLSX 库加载、状态映射
 * 从 script.js 拆分而来 - 请勿手动修改行号映射
 */

/**
 * 导入事务包装：回调抛出任何异常 → 自动回滚 data/ 到快照状态并重新抛出；
 * 正常完成 → 提交并清理快照。本地 file:// 模式下 server 不可用时自动跳过快照。
 */
async function withImportSnapshot(transactionName, fn) {
    const snapRes = await storageManager.createImportSnapshot();
    const snapshotId = (snapRes && snapRes.snapshotId) || '';
    if (snapshotId) {
        Logger.info('Import', `${transactionName} 创建快照: ${snapshotId}`);
    }
    try {
        await fn();
        if (snapshotId) await storageManager.commitImportSnapshot(snapshotId);
    } catch (err) {
        if (snapshotId) {
            try {
                const r = await storageManager.rollbackImportSnapshot(snapshotId);
                if (r && r.ok) {
                    // 回滚完成后，内存也需要回到导入前：强制刷新内存资产数据
                    if (typeof refreshAssetsFromStorage === 'function') {
                        try { await refreshAssetsFromStorage(); } catch (_) {}
                    }
                    Logger.warn('Import', `${transactionName} 失败，已回滚到快照`);
                }
            } catch (rbErr) {
                Logger.error('Import', `${transactionName} 回滚失败: ` + rbErr.message);
            }
        }
        throw err;
    }
}

function handleExcelImport(e) {
    Logger.info('Import', 'Excel 导入触发');
    if (!checkXlsxLibrary()) {
        // 本地版本：直接提示用户需要手动下载库文件
        showNotification('XLSX库未正确加载。请手动下载XLSX库文件并放置到libs目录。\n下载地址: https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js\n\n即将切换到JSON导入方式。', 'error', 8000);

        // 清空文件选择，允许重复选择同一文件
        e.target.value = '';
        hideLoadingIndicator();
        document.getElementById('import-json').click();
        return;
    }

    const file = e.target.files[0];
    if (!file) return;

    // 只接受Excel文件
    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
        showNotification('请导入Excel格式的文件', 'warning');
        hideLoadingIndicator();
        return;
    }

    // 显示加载指示器
    showLoadingIndicator();

    const reader = new FileReader();
    reader.onerror = function() {
        console.error('读取Excel文件失败');
        showNotification('读取Excel文件失败，请重试', 'error');
        hideLoadingIndicator();
    };
    reader.onload = async function(event) {
        await withImportSnapshot('Excel导入', async () => {
            const data = new Uint8Array(event.target.result);
            const workbook = XLSX.read(data, { type: 'array' });

            // 获取第一个工作表
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];

            // 转换为JSON
            const importedData = XLSX.utils.sheet_to_json(worksheet);

            // 验证导入的数据格式
            if (!Array.isArray(importedData) || importedData.length === 0) {
                throw new Error('导入的Excel文件中没有有效数据');
            }
            
            // 映射Excel列到系统字段
            const mappedData = importedData.map((item, index) => {
                // 购入日期解析：兼容 Excel 序列号日期 / ISO 字符串 / 中文斜杠格式
                let purchaseDate = '';
                const rawDate = item['购入日期'];
                if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
                    // Excel 序列号（1900 日期系统）
                    if (typeof rawDate === 'number') {
                        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                        const utcDays = Math.floor(rawDate - 1); // 修正 Excel 闰年 Bug
                        const targetDate = new Date(excelEpoch.getTime() + utcDays * 86400000);
                        purchaseDate = targetDate.toISOString().split('T')[0];
                    } else {
                        const parsed = new Date(String(rawDate).replace(/\//g, '-'));
                        if (!isNaN(parsed.getTime())) {
                            purchaseDate = parsed.toISOString().split('T')[0];
                        }
                    }
                }

                // 状态映射：未知状态或空时默认闲置，避免验证失败
                const mappedStatus = mapStatus(item['状态']);
                const status = mappedStatus || 'idle';

                return {
                    id: (item['资产编号'] && String(item['资产编号']).trim()) ? String(item['资产编号']).trim() : `AUTO-${Date.now()}-${index}`,
                    owner: item['主体'] || '',
                    type: item['设备类型'] || '',
                    brandModel: item['品牌型号'] || '',
                    configuration: item['配置信息'] || '',
                    purchaseDate,
                    status,
                    user: item['使用人'] || '',
                    department: item['部门'] || '',
                    location: item['位置'] || '',
                    manager: item['负责人'] || '',
                    unit: item['单位'] || '台',
                    quantity: parseInt(item['数量']) || 1,
                    value: parseFloat(item['价值(元)']) || 0,
                    depreciationYears: parseInt(item['折旧年限']) || 0,
                    purchaseNo: item['采购编号'] || '',
                    paymentNo: item['付款编号'] || '',
                    damageReason: item['损坏原因'] || '',
                    maintenanceRecords: [],
                    attachments: []
                };
            });
            
            // 验证数据结构：只校验模板中标注的必填字段
            const REQUIRED_FIELDS = ['owner', 'type', 'brandModel', 'purchaseDate', 'status', 'department'];
            const REQUIRED_LABELS = {
                owner: '主体', type: '设备类型', brandModel: '品牌型号',
                purchaseDate: '购入日期', status: '状态', department: '部门'
            };
            const validationErrors = [];
            mappedData.forEach((item, index) => {
                const missing = REQUIRED_FIELDS.filter(f => !item[f] || String(item[f]).trim() === '');
                if (missing.length > 0) {
                    validationErrors.push(`第${index+1}条数据缺少必要字段: ${missing.map(m => REQUIRED_LABELS[m]).join('、')}`);
                }
                // 验证日期格式（purchaseDate 已非空才检查）
                if (item.purchaseDate && isNaN(new Date(item.purchaseDate).getTime())) {
                    validationErrors.push(`第${index+1}条数据的购入日期格式不正确（请使用 YYYY-MM-DD 或标准日期格式）`);
                }
                // 数量/价值合理性检查
                if (item.quantity <= 0 || isNaN(item.quantity)) {
                    validationErrors.push(`第${index+1}条数据的数量必须是大于0的整数`);
                }
                if (item.value < 0 || isNaN(item.value)) {
                    validationErrors.push(`第${index+1}条数据的价值不能为负数`);
                }
            });
            
            if (validationErrors.length > 0) {
                throw new Error(`数据验证失败：\n${validationErrors.slice(0, 5).join('\n')}${validationErrors.length > 5 ? '\n...等更多错误' : ''}`);
            }

            // ============ C/S 多人模式: 服务端单事务批量导入(全部成功或全部回滚) ============
            if (typeof ApiClient !== 'undefined' && ApiClient.csMode) {
                try {
                    const result = await ApiClient.batchImport(mappedData, 'merge');
                    ApiClient.markLocalChange();
                    // 以服务端为权威源, 重新拉取全量数据刷新内存与缓存
                    await ApiClient.reloadAssetsData();
                    updateStatistics();
                    renderRecentAssets();
                    renderDamagedAssets();
                    renderAllAssets();
                    saveToLocalStorage();   // C/S 模式下仅刷新本地缓存
                    showNotification(`成功导入 ${result.inserted} 条新资产，更新 ${result.updated} 条现有资产（服务端事务）`, 'success', 4000);
                } catch (err) {
                    Logger.error('Import', 'C/S 批量导入失败:', err);
                    if (err && err.code === 40300) {
                        showNotification('导入失败：当前账号没有导入数据的权限', 'error', 6000);
                    } else {
                        showNotification('导入失败（服务端已整体回滚，未产生任何变更）: ' + ((err && err.message) || err), 'error', 8000);
                    }
                } finally {
                    hideLoadingIndicator();
                }
                return;
            }

            // 分批导入（大数据优化）
            const BATCH_SIZE = 100; // 每批处理100条数据
            // 创建一个临时的DOM元素显示进度
            let progressElement = document.createElement('div');
            progressElement.className = 'loading-indicator progress';
            progressElement.innerHTML = `
                <div class="progress-text">正在导入数据...</div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width: 0%"></div>
                </div>
                <div class="progress-percentage">0%</div>
            `;
            document.body.appendChild(progressElement);

            // 将 RAF 分批导入包装成 Promise，让快照事务能等待完成 / 失败回滚
            await new Promise((resolve, reject) => {
                let currentIndex = 0;
                let addedCount = 0;
                let updatedCount = 0;

                function processBatch() {
                    try {
                        const batch = mappedData.slice(currentIndex, currentIndex + BATCH_SIZE);
                        if (batch.length === 0) {
                            document.body.removeChild(progressElement);

                            updateStatistics();
                            renderRecentAssets();
                            renderDamagedAssets();
                            renderAllAssets();

                            saveToLocalStorage();

                            showNotification(`成功导入 ${addedCount} 条新资产，更新 ${updatedCount} 条现有资产`, 'success', 4000);
                            hideLoadingIndicator();
                            resolve();
                            return;
                        }

                        batch.forEach(newAsset => {
                            const existingIndex = assetsData.findIndex(a => a.id === newAsset.id);
                            if (existingIndex === -1) {
                                assetsData.push(newAsset);
                                addedCount++;
                            } else {
                                assetsData[existingIndex] = newAsset;
                                updatedCount++;
                            }
                        });

                        currentIndex += BATCH_SIZE;
                        const progress = Math.min(100, Math.floor((currentIndex / mappedData.length) * 100));
                        progressElement.querySelector('.progress-fill').style.width = `${progress}%`;
                        progressElement.querySelector('.progress-percentage').textContent = `${progress}%`;

                        requestAnimationFrame(processBatch);
                    } catch (err) {
                        reject(err);
                    }
                }

                processBatch();
            });
        });
    };

    reader.readAsArrayBuffer(file);

    // 清空文件选择，允许重复选择同一文件
    e.target.value = '';
}

// 处理JSON导入
function handleJsonImport(e) {
    Logger.info('Import', 'JSON 导入触发');
    const file = e.target.files[0];
    if (!file) return;
    
    // 只接受JSON文件
    if (!file.name.endsWith('.json')) {
        showNotification('请导入JSON格式的文件', 'warning');
        hideLoadingIndicator();
        return;
    }
    
    // 显示加载指示器
    showLoadingIndicator();
    
    const reader = new FileReader();
    reader.onerror = function() {
        console.error('读取JSON文件失败');
        showNotification('读取JSON文件失败，请重试', 'error');
        hideLoadingIndicator();
    };
    reader.onload = async function(event) {
        await withImportSnapshot('JSON导入', async () => {
            const rawImport = JSON.parse(event.target.result);
            let assetsToImport = [];
            let importSourceInfo = '';

            // 兼容「备份数据」按钮导出的格式（version + assetsData + userState）
            const isBackupFormat = !!(rawImport && rawImport.version && rawImport.assetsData && rawImport.userState);
            // 兼容「导出JSON」按钮导出的格式（version + assetsData + exportTime）
            const isJsonExportFormat = !!(rawImport && rawImport.version && rawImport.assetsData && !rawImport.userState && (rawImport.exportType === 'json' || rawImport.exportTime));

            let importedData = rawImport;
            if (isBackupFormat) {
                importedData = {
                    version: rawImport.version,
                    exportTime: rawImport.timestamp || new Date().toISOString(),
                    assetsData: rawImport.assetsData,
                    _backupFormat: true
                };
            }

            // 检查是否为新版本导出格式
            if (importedData && importedData.version && importedData.assetsData) {
                // 版本兼容性检查（容错：缺失方法时按兼容处理）
                const versionOk = (typeof storageManager.checkVersionCompatibility === 'function')
                    ? storageManager.checkVersionCompatibility(importedData.version)
                    : true;

                if (versionOk) {
                    const exportedAt = importedData.exportTime || importedData.timestamp || '';
                    const timeStr = exportedAt ? new Date(exportedAt).toLocaleString() : '未知';
                    importSourceInfo = `${importedData._backupFormat ? '(备份数据格式' : '(版本: '}${importedData.version}${importedData._backupFormat ? ')' : `, 导出时间: ${timeStr})`}`;
                    if (!importedData._backupFormat && exportedAt) {
                        importSourceInfo = `(版本: ${importedData.version}, 导出时间: ${timeStr})`;
                    }

                    let rawAssets = importedData.assetsData;

                    // 压缩数据可能是非数组字符串或压缩对象，先尝试解压缩
                    let decompressed = rawAssets;
                    try {
                        if (typeof storageManager.decompressData === 'function') {
                            decompressed = storageManager.decompressData(rawAssets);
                        }
                    } catch (compressionError) {
                        console.warn('解压缩失败，尝试直接使用原始数据:', compressionError);
                        decompressed = rawAssets;
                    }

                    // 如果 assetsData 仍是字符串（双重序列化），再 parse 一次
                    if (typeof decompressed === 'string') {
                        try { decompressed = JSON.parse(decompressed); } catch (_) { /* keep as-is */ }
                    }

                    if (!Array.isArray(decompressed)) {
                        throw new Error('导入文件中的资产数据不是有效的资产列表（缺少 assetsData 数组）');
                    }
                    assetsToImport = decompressed;
                } else {
                    const currentVer = (storageManager && storageManager.dataVersion) || '未知';
                    throw new Error(`导入的文件版本(${importedData.version})与当前系统版本(${currentVer})不兼容`);
                }
            } else if (Array.isArray(importedData)) {
                // 旧版本格式（直接是资产数组）
                assetsToImport = importedData;
                importSourceInfo = '(旧版本格式)';
            } else {
                throw new Error('导入的数据格式不正确，不是有效的资产数据');
            }

            // 为每条导入数据补齐默认字段，避免校验失败
            assetsToImport = assetsToImport.map((item, idx) => Object.assign({
                id: '',
                owner: '',
                type: '',
                brandModel: '',
                purchaseDate: '',
                status: '',
                department: '',
                quantity: 1,
                value: 0,
                unit: '台',
                maintenanceRecords: [],
                attachments: []
            }, item || {}));

            // 验证数据结构（模板中标注的必填字段）
            const REQUIRED_LABELS = { owner: '主体', type: '设备类型', brandModel: '品牌型号', purchaseDate: '购入日期', status: '状态', department: '部门' };
            const REQUIRED_FIELDS = Object.keys(REQUIRED_LABELS);
            assetsToImport.forEach((item, index) => {
                const missing = REQUIRED_FIELDS.filter(f => !item[f] || String(item[f]).trim() === '');
                if (missing.length > 0) {
                    throw new Error(`第${index + 1}条数据缺少必要字段: ${missing.map(m => REQUIRED_LABELS[m]).join('、')}`);
                }
                if (item.purchaseDate && isNaN(new Date(item.purchaseDate).getTime())) {
                    throw new Error(`第${index + 1}条数据的购入日期格式不正确`);
                }
                if (item.quantity <= 0 || isNaN(Number(item.quantity))) {
                    throw new Error(`第${index + 1}条数据的数量必须为正整数`);
                }
            });

            // ============ C/S 多人模式: 服务端单事务批量导入(按编号 upsert) ============
            if (typeof ApiClient !== 'undefined' && ApiClient.csMode) {
                // 编号为空的自动生成
                assetsToImport.forEach((item, idx) => {
                    if (!item.id || String(item.id).trim() === '') {
                        item.id = `AUTO-${Date.now()}-${idx}`;
                    }
                });
                try {
                    const result = await ApiClient.batchImport(assetsToImport, 'merge');
                    ApiClient.markLocalChange();
                    await ApiClient.reloadAssetsData();   // 以服务端为权威源刷新内存
                    updateStatistics();
                    renderRecentAssets();
                    renderDamagedAssets();
                    renderAllAssets();
                    saveToLocalStorage();   // C/S 模式下仅刷新本地缓存
                    showNotification(`成功导入 ${result.inserted} 条新资产，更新 ${result.updated} 条现有资产（服务端事务）\n${importSourceInfo}`, 'success', 5000);
                } catch (err) {
                    Logger.error('Import', 'C/S 批量导入失败:', err);
                    if (err && err.code === 40300) {
                        showNotification('导入失败：当前账号没有导入数据的权限', 'error', 6000);
                    } else {
                        showNotification('导入失败（服务端已整体回滚，未产生任何变更）: ' + ((err && err.message) || err), 'error', 8000);
                    }
                } finally {
                    hideLoadingIndicator();
                }
                return;
            }

            // 合并数据（去重）
            let addedCount = 0;
            let updatedCount = 0;
            
            assetsToImport.forEach(newAsset => {
                // 导入时若 id 为空自动生成
                if (!newAsset.id || String(newAsset.id).trim() === '') {
                    newAsset.id = `AUTO-${Date.now()}-${addedCount}-${updatedCount}`;
                }
                const existingIndex = assetsData.findIndex(a => a.id === newAsset.id);
                if (existingIndex === -1) {
                    // 添加新资产
                    assetsData.push(newAsset);
                    addedCount++;
                } else {
                    // 更新现有资产
                    assetsData[existingIndex] = newAsset;
                    updatedCount++;
                }
            });
            
            // 更新UI
            updateStatistics();
            renderRecentAssets();
            renderDamagedAssets();
            renderAllAssets();

            // 保存到本地存储
            saveToLocalStorage();

            // 记录导入操作
            showNotification(`成功导入 ${addedCount} 条新资产，更新 ${updatedCount} 条现有资产\n${importSourceInfo}`, 'success', 5000);
        });
    };
    
    reader.readAsText(file);
    
    // 清空文件选择，允许重复选择同一文件
    e.target.value = '';
}

// 导出到Excel - 优化版本
async function exportToExcel(exportType = 'assets') {
    Logger.info('Import', 'Excel 导出触发 | 类型:', exportType, '| 资产数:', assetsData.length);

    // C/S 多人模式: 以服务端全量数据为权威导出源(顺带刷新内存与本地缓存)
    if (typeof ApiClient !== 'undefined' && ApiClient.csMode) {
        try {
            showLoadingIndicator();
            assetsData = await ApiClient.allAssets();
            ApiClient._stamp = null;    // 重建指纹基线, 避免拉取后误报
            saveToLocalStorage();
        } catch (err) {
            hideLoadingIndicator();
            showNotification('获取服务端数据失败，导出已取消: ' + ((err && err.message) || err), 'error', 6000);
            return;
        }
    }

    if (assetsData.length === 0) {
        hideLoadingIndicator();
        showNotification('没有可导出的资产数据', 'warning');
        return;
    }

    // 检查XLSX库是否加载成功
    if (!checkXlsxLibrary()) {
        // 显示加载XLSX库的提示
        showNotification('正在加载Excel处理库，请稍候再试...', 'info');

        // 尝试延迟重试
        setTimeout(() => {
            if (checkXlsxLibrary()) {
                exportToExcel(exportType);
            } else {
                showNotification('XLSX库加载失败，您可以使用导出JSON的方式进行数据管理。\n即将导出JSON格式数据。', 'warning', 6000);
                exportToJson(exportType);
            }
        }, 2000);
        return;
    }
    
    // 显示加载指示器
    showLoadingIndicator();
    
    // 使用setTimeout避免UI阻塞
    setTimeout(() => {
        try {
            // 创建工作簿
            const workbook = XLSX.utils.book_new();
            
            if (exportType === 'reports') {
                // 导出统计报表数据
                
                // 1. 资产状态分布数据
                const statusStats = {
                    active: 0,
                    idle: 0,
                    damaged: 0,
                    maintenance: 0,
                    retired: 0
                };
                
                assetsData.forEach(asset => {
                    if (asset.status && statusStats.hasOwnProperty(asset.status)) {
                        statusStats[asset.status]++;
                    }
                });
                
                const statusReportData = [
                    { '类别': '状态', '在用': statusStats.active, '闲置': statusStats.idle, '损坏': statusStats.damaged, '维修中': statusStats.maintenance, '报废': statusStats.retired, '合计': assetsData.length }
                ];
                
                // 2. 设备类型统计数据
                const typeStats = {};
                assetsData.forEach(asset => {
                    if (!typeStats[asset.type]) {
                        typeStats[asset.type] = 0;
                    }
                    typeStats[asset.type]++;
                });
                
                const typeReportData = Object.keys(typeStats).map(type => ({
                    '设备类型': type,
                    '数量': typeStats[type]
                }));
                
                // 3. 主体资产数量统计数据
                const ownerStats = {};
                assetsData.forEach(asset => {
                    if (!ownerStats[asset.owner]) {
                        ownerStats[asset.owner] = 0;
                    }
                    ownerStats[asset.owner]++;
                });
                
                const ownerReportData = Object.keys(ownerStats).map(owner => ({
                    '主体': owner,
                    '数量': ownerStats[owner]
                }));
                
                // 4. 部门资产分布统计数据
                const departmentStats = {};
                assetsData.forEach(asset => {
                    if (!departmentStats[asset.department]) {
                        departmentStats[asset.department] = 0;
                    }
                    departmentStats[asset.department]++;
                });
                
                const departmentReportData = Object.keys(departmentStats).map(dept => ({
                    '部门': dept,
                    '数量': departmentStats[dept]
                }));
                
                // 创建工作表
                const statusSheet = XLSX.utils.json_to_sheet(statusReportData);
                const typeSheet = XLSX.utils.json_to_sheet(typeReportData);
                const ownerSheet = XLSX.utils.json_to_sheet(ownerReportData);
                const deptSheet = XLSX.utils.json_to_sheet(departmentReportData);
                
                // 添加工作表到工作簿
                XLSX.utils.book_append_sheet(workbook, statusSheet, '资产状态分布');
                XLSX.utils.book_append_sheet(workbook, typeSheet, '设备类型统计');
                XLSX.utils.book_append_sheet(workbook, ownerSheet, '主体资产数量');
                XLSX.utils.book_append_sheet(workbook, deptSheet, '部门资产分布');
                
                // 设置所有工作表的格式
                [statusSheet, typeSheet, ownerSheet, deptSheet].forEach((sheet, index) => {
                    // 设置表头样式
                    const range = XLSX.utils.decode_range(sheet['!ref']);
                    for (let C = range.s.c; C <= range.e.c; ++C) {
                        const cellAddress = XLSX.utils.encode_cell({r: 0, c: C});
                        sheet[cellAddress].s = {
                            font: {bold: true, color: {rgb: 'FFFFFF'}},
                            fill: {fgColor: {rgb: '3081EB'}},
                            alignment: {horizontal: 'center', vertical: 'center'}
                        };
                    }
                    
                    // 设置列宽自适应
                    const colWidths = [];
                    for (let C = range.s.c; C <= range.e.c; ++C) {
                        let maxWidth = 0;
                        for (let R = range.s.r; R <= range.e.r; ++R) {
                            const cellAddress = XLSX.utils.encode_cell({r: R, c: C});
                            const cell = sheet[cellAddress];
                            if (cell && cell.v) {
                                const cellText = String(cell.v);
                                const textWidth = cellText.split('').reduce((acc, char) => {
                                    return acc + (char.charCodeAt(0) > 255 ? 2 : 1);
                                }, 0);
                                maxWidth = Math.max(maxWidth, textWidth);
                            }
                        }
                        colWidths.push({wch: Math.min(50, maxWidth + 2)});
                    }
                    sheet['!cols'] = colWidths;
                });
                
                // 导出文件名
                const fileName = `资产统计报表_${new Date().toLocaleDateString().replace(/\//g, '-')}.xlsx`;
                XLSX.writeFile(workbook, fileName);
                
            } else {
                // 导出全部资产数据（原有逻辑）
                const exportData = assetsData.map(asset => {
                    return {
                        '资产编号': asset.id,
                        '主体': asset.owner,
                        '设备类型': asset.type,
                        '品牌型号': asset.brandModel,
                        '配置信息': asset.configuration,
                        '购入日期': formatDate(asset.purchaseDate),
                        '状态': getStatusText(asset.status),
                        '使用人': asset.user || '',
                        '部门': asset.department,
                        '位置': asset.location || '',
                        '负责人': asset.manager || '',
                        '单位': asset.unit || '台',
                        '数量': asset.quantity || 1,
                        '价值(元)': asset.value || 0,
                        '折旧年限': asset.depreciationYears || 0,
                        '采购编号': asset.purchaseNo || '',
                        '付款编号': asset.paymentNo || '',
                        '损坏原因': asset.damageReason || ''
                    };
                });
                
                // 创建工作表
                const worksheet = XLSX.utils.json_to_sheet(exportData);
                XLSX.utils.book_append_sheet(workbook, worksheet, '资产数据');
                
                // 优化工作表格式
                const range = XLSX.utils.decode_range(worksheet['!ref']);
                
                // 设置表头样式
                for (let C = range.s.c; C <= range.e.c; ++C) {
                    const cellAddress = XLSX.utils.encode_cell({r: 0, c: C});
                    worksheet[cellAddress].s = {
                        font: {bold: true, color: {rgb: 'FFFFFF'}},
                        fill: {fgColor: {rgb: '3081EB'}},
                        alignment: {horizontal: 'center', vertical: 'center'}
                    };
                }
                
                // 设置所有列宽自适应内容
                const colWidths = [];
                // 计算每列所需的宽度
                for (let C = range.s.c; C <= range.e.c; ++C) {
                    let maxWidth = 0;
                    for (let R = range.s.r; R <= range.e.r; ++R) {
                        const cellAddress = XLSX.utils.encode_cell({r: R, c: C});
                        const cell = worksheet[cellAddress];
                        if (cell && cell.v) {
                            // 计算内容长度（中文字符算2个字符宽度）
                            const cellText = String(cell.v);
                            const textWidth = cellText.split('').reduce((acc, char) => {
                                return acc + (char.charCodeAt(0) > 255 ? 2 : 1);
                            }, 0);
                            maxWidth = Math.max(maxWidth, textWidth);
                        }
                    }
                    // 添加一些边距
                    colWidths.push({wch: Math.min(50, maxWidth + 2)});
                }
                worksheet['!cols'] = colWidths;
                
                // 设置行高
                for (let R = range.s.r; R <= range.e.r; ++R) {
                    worksheet['!rows'] = worksheet['!rows'] || [];
                    worksheet['!rows'][R] = {hpx: 25};
                }
                
                // 导出文件
                const fileName = `资产数据_${new Date().toLocaleDateString().replace(/\//g, '-')}.xlsx`;
                XLSX.writeFile(workbook, fileName);
            }
        } catch (error) {
            showNotification(`导出失败: ${error.message}`, 'error', 4000);
            console.error('导出错误:', error);
        } finally {
            // 隐藏加载指示器
            hideLoadingIndicator();
        }
    }, 0);
}

// 全局变量，用于跟踪XLSX库加载状态
let xlsxLibraryLoaded = false;
let xlsxLoadAttempts = 0;
const MAX_XLSX_LOAD_ATTEMPTS = 3;

// 检查XLSX库是否加载成功
function checkXlsxLibrary() {
    if (typeof XLSX !== 'undefined') {
        xlsxLibraryLoaded = true;

        // 隐藏任何加载失败提示
        const xlsxErrorElement = document.getElementById('xlsx-load-error');
        if (xlsxErrorElement) {
            xlsxErrorElement.style.display = 'none';
        }
        
        return true;
    }
    return false;
}

// 尝试加载XLSX库（本地版本）
function attemptLoadXlsxLibrary() {
    if (xlsxLoadAttempts >= MAX_XLSX_LOAD_ATTEMPTS) {
        showXlsxLoadError();
        return;
    }
    
    xlsxLoadAttempts++;
    
    if (!checkXlsxLibrary()) {
        setTimeout(() => {
            // 本地版本：不再尝试从CDN重新加载，直接提示用户
            if (xlsxLoadAttempts < MAX_XLSX_LOAD_ATTEMPTS) {
                // 只进行本地检查，不再尝试远程加载
                if (!checkXlsxLibrary()) {
                    attemptLoadXlsxLibrary();
                }
            } else {
                showXlsxLoadError();
            }
        }, 2000);
    }
}

// 显示XLSX库加载错误
function showXlsxLoadError() {
    // 检查是否已存在错误提示
    let errorElement = document.getElementById('xlsx-load-error');
    if (!errorElement) {
        errorElement = document.createElement('div');
        errorElement.id = 'xlsx-load-error';
        errorElement.className = 'alert alert-error fixed-top';
        errorElement.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background-color: #f8d7da;
            color: #721c24;
            padding: 15px;
            border: 1px solid #f5c6cb;
            border-radius: 5px;
            z-index: 10000;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            max-width: 80%;
            text-align: center;
        `;
        errorElement.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between;">
                <div>
                    <strong>Excel功能不可用</strong><br>
                    <small>XLSX库未正确加载。请手动下载XLSX库文件并放置到libs目录。<br>下载地址: https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js<br>您仍可以使用JSON导入/导出功能</small>
                </div>
                <button onclick="this.parentElement.parentElement.style.display='none'" 
                        style="background: none; border: none; color: #721c24; cursor: pointer;">
                    ×
                </button>
            </div>
        `;
        document.body.appendChild(errorElement);
    } else {
        errorElement.style.display = 'block';
    }
}

// 全局变量存储用户上传的模板
let assetCardTemplate = null;

// 全局变量存储分析过的Excel格式信息
let analyzedExcelFormats = null;

// 打印固定资产登记卡 - 支持模板上传匹配

function downloadExcelTemplate() {
    try {
        // 再次检查XLSX库是否加载成功
        if (!checkXlsxLibrary()) {
            // 本地版本：直接提示用户需要手动下载库文件
            showNotification('XLSX库未正确加载。请手动下载XLSX库文件并放置到libs目录。\n下载地址: https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js\n\n您仍可以使用JSON导入/导出功能进行数据管理。', 'error', 8000);
            return;
        }
        
        // 显示加载指示器
        showLoadingIndicator();
        
        // 定义模板数据结构
        const templateData = [
            {
                '资产编号': 'ASSET-2024-001',
                '主体': '花满堂网络科技服务（济宁）有限公司',
                '设备类型': '笔记本电脑',
                '品牌型号': 'ThinkPad X1 Carbon',
                '配置信息': 'i7-1165G7/16GB/512GB SSD',
                '购入日期': '2024-01-15',
                '状态': '在用',
                '使用人': '张三',
                '部门': '数据中心',
                '位置': '3楼301室',
                '负责人': '李四',
                '单位': '台',
                '数量': 1,
                '价值(元)': 12800.00,
                '折旧年限': 3,
                '采购编号': 'PO-202401001',
                '付款编号': '0',
                '损坏原因': ''
            },
            {
                '资产编号': '',
                '主体': '浮一梦网络科技发展（济宁）有限公司',
                '设备类型': '台式电脑',
                '品牌型号': 'Dell OptiPlex 7090',
                '配置信息': 'i5-11500/8GB/256GB SSD',
                '购入日期': '2024-02-10',
                '状态': '闲置',
                '使用人': '',
                '部门': '财务部',
                '位置': '2楼205室',
                '负责人': '王五',
                '单位': '台',
                '数量': 1,
                '价值(元)': 6500.00,
                '折旧年限': 3,
                '采购编号': '',
                '付款编号': '',
                '损坏原因': ''
            }
        ];
        
        // 创建工作簿和工作表
        const worksheet = XLSX.utils.json_to_sheet(templateData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, '资产模板');
        
        // 添加说明工作表
        const instructions = [
            { '说明': '请按照模板格式填写资产信息' },
            { '说明': '必填字段：资产编号、主体、设备类型、品牌型号、购入日期、状态、部门' },
            { '说明': '状态可选值：在用、闲置、维修中、损坏、报废' },
            { '说明': '资产编号为空时，系统将自动生成' },
            { '说明': '购入日期格式：YYYY-MM-DD' },
            { '说明': '单位默认：台；数量默认：1' },
            { '说明': '价值(元)：填写数字即可，系统会自动添加货币符号' },
            { '说明': '折旧年限：填写整数年数' },
            { '说明': '导入时会自动跳过此说明页' }
        ];
        const instructionSheet = XLSX.utils.json_to_sheet(instructions);
        XLSX.utils.book_append_sheet(workbook, instructionSheet, '使用说明');
        
        // 优化模板格式
        const range = XLSX.utils.decode_range(worksheet['!ref']);
        
        // 设置表头样式
        for (let C = range.s.c; C <= range.e.c; ++C) {
            const cellAddress = XLSX.utils.encode_cell({r: 0, c: C});
            worksheet[cellAddress].s = {
                font: {bold: true, color: {rgb: 'FFFFFF'}},
                fill: {fgColor: {rgb: '3081EB'}},
                alignment: {horizontal: 'center', vertical: 'center'}
            };
        }
        
        // 设置列宽
        const colWidths = [];
        const headers = Object.keys(templateData[0]);
        headers.forEach(header => {
            // 计算表头所需宽度（中文字符算2个字符宽度）
            const headerWidth = header.split('').reduce((acc, char) => {
                return acc + (char.charCodeAt(0) > 255 ? 2 : 1);
            }, 0);
            colWidths.push({wch: Math.min(50, headerWidth + 4)});
        });
        worksheet['!cols'] = colWidths;
        
        // 导出模板文件
        XLSX.writeFile(workbook, '资产导入模板.xlsx');
        
        // 隐藏加载指示器并显示成功提示
        setTimeout(() => {
            hideLoadingIndicator();
            showNotification('模板下载成功！请按照模板格式填写资产信息后导入。', 'success', 4000);
        }, 500);
    } catch (error) {
        hideLoadingIndicator();
        showNotification(`模板下载失败: ${error.message}`, 'error', 4000);
        console.error('模板生成错误:', error);
    }
}

// 导出到JSON
async function exportToJson(exportType = 'assets') {
    Logger.info('Import', 'JSON 导出触发 | 类型:', exportType, '| 资产数:', assetsData.length);

    // C/S 多人模式: 以服务端全量数据为权威导出源(顺带刷新内存与本地缓存)
    if (typeof ApiClient !== 'undefined' && ApiClient.csMode) {
        try {
            showLoadingIndicator();
            assetsData = await ApiClient.allAssets();
            ApiClient._stamp = null;    // 重建指纹基线, 避免拉取后误报
            saveToLocalStorage();
        } catch (err) {
            hideLoadingIndicator();
            showNotification('获取服务端数据失败，导出已取消: ' + ((err && err.message) || err), 'error', 6000);
            return;
        }
    }

    if (assetsData.length === 0) {
        hideLoadingIndicator();
        showNotification('没有可导出的资产数据', 'warning');
        return;
    }
    
    // 显示加载指示器
    showLoadingIndicator();
    
    // 使用setTimeout避免UI阻塞
    setTimeout(() => {
        try {
            let exportPackage, exportFileDefaultName;
            
            if (exportType === 'reports') {
                // 导出统计报表数据
                
                // 1. 资产状态分布数据
                const statusStats = {
                    active: 0,
                    idle: 0,
                    damaged: 0,
                    maintenance: 0,
                    retired: 0
                };
                
                assetsData.forEach(asset => {
                    if (asset.status && statusStats.hasOwnProperty(asset.status)) {
                        statusStats[asset.status]++;
                    }
                });
                
                // 2. 设备类型统计数据
                const typeStats = {};
                assetsData.forEach(asset => {
                    if (!typeStats[asset.type]) {
                        typeStats[asset.type] = 0;
                    }
                    typeStats[asset.type]++;
                });
                
                // 3. 主体资产数量统计数据
                const ownerStats = {};
                assetsData.forEach(asset => {
                    if (!ownerStats[asset.owner]) {
                        ownerStats[asset.owner] = 0;
                    }
                    ownerStats[asset.owner]++;
                });
                
                // 4. 部门资产分布统计数据
                const departmentStats = {};
                assetsData.forEach(asset => {
                    if (!departmentStats[asset.department]) {
                        departmentStats[asset.department] = 0;
                    }
                    departmentStats[asset.department]++;
                });
                
                // 创建统计报表数据包
                const reportsData = {
                    version: storageManager.dataVersion,
                    exportTime: new Date().toISOString(),
                    totalAssets: assetsData.length,
                    statusDistribution: {
                        '在用': statusStats.active,
                        '闲置': statusStats.idle,
                        '损坏': statusStats.damaged,
                        '维修中': statusStats.maintenance,
                        '报废': statusStats.retired
                    },
                    assetTypeStatistics: typeStats,
                    ownerAssetStatistics: ownerStats,
                    departmentAssetDistribution: departmentStats,
                    exportType: 'reports'
                };
                
                // 将数据转换为格式化的JSON字符串
                const dataStr = JSON.stringify(reportsData, null, 2);
                const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
                
                // 生成文件名
                exportFileDefaultName = `资产统计报表_${new Date().toLocaleDateString().replace(/\//g, '-')}.json`;
                
                // 创建并触发下载链接
                const linkElement = document.createElement('a');
                linkElement.setAttribute('href', dataUri);
                linkElement.setAttribute('download', exportFileDefaultName);
                linkElement.click();
                
            } else {
                // 导出全部资产数据（原有逻辑）
                // 使用LocalStorageManager的压缩方法处理数据
                const exportData = storageManager.compressData(assetsData);
                
                // 创建完整的导出数据包，包含版本信息
                const exportPackage = {
                    version: storageManager.dataVersion,
                    exportTime: new Date().toISOString(),
                    assetCount: assetsData.length,
                    assetsData: exportData,
                    exportType: 'json'
                };
                
                // 将数据转换为格式化的JSON字符串
                const dataStr = JSON.stringify(exportPackage, null, 2);
                const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
                
                // 生成文件名，包含导出日期和资产数量
                exportFileDefaultName = `资产数据_${new Date().toLocaleDateString().replace(/\//g, '-')}_${assetsData.length}条.json`;
                
                // 创建并触发下载链接
                const linkElement = document.createElement('a');
                linkElement.setAttribute('href', dataUri);
                linkElement.setAttribute('download', exportFileDefaultName);
                linkElement.click();
                
            }
        } catch (error) {
            showNotification(`导出失败: ${error.message}`, 'error', 4000);
            console.error('导出错误:', error);
        } finally {
            // 隐藏加载指示器
            hideLoadingIndicator();
        }
    }, 0);
}

// 状态映射（Excel导入时使用）
function mapStatus(statusText) {
    // 已是系统状态值，直接返回
    const systemStatuses = ['active', 'idle', 'maintenance', 'damaged', 'retired'];
    if (systemStatuses.includes(statusText)) {
        return statusText;
    }

    // 中文状态文本映射到系统状态值，覆盖常见同义说法
    const statusMap = {
        '在用': 'active',
        '使用中': 'active',
        '使用': 'active',
        '正常': 'active',
        '启用': 'active',
        '闲置': 'idle',
        '空闲': 'idle',
        '停用': 'idle',
        '未使用': 'idle',
        '维修中': 'maintenance',
        '维修': 'maintenance',
        '维护中': 'maintenance',
        '修理中': 'maintenance',
        '损坏': 'damaged',
        '故障': 'damaged',
        '坏': 'damaged',
        '报废': 'retired',
        '已报废': 'retired',
        '废弃': 'retired'
    };

    // 标准化输入：去除首尾空格，未知状态返回 null（由调用方决定如何处理）
    const normalized = String(statusText || '').trim();
    if (!normalized) return null;
    return statusMap[normalized] || null;
}

// 全局通知函数
