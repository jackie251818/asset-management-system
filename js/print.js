/**
 * 固定资产标签打印功能（打印、模板上传、卡片生成）
 * 从 script.js 拆分而来 - 请勿手动修改行号映射
 */

// 打开资产标签打印页面（70mm × 50mm 标签）
function openLabelPrintPage() {
    const assetIdEl = getElement('asset-id');
    const assetId = assetIdEl ? assetIdEl.textContent : '';
    const url = 'asset_label_print.html' + (assetId && assetId !== '未选择资产' ? '?asset=' + encodeURIComponent(assetId) : '');
    window.open(url, '_blank');
}

function printAssetCard() {
    // 获取当前资产ID
    const assetIdEl = getElement('asset-id');
    const assetId = assetIdEl ? assetIdEl.textContent : '';
    if (!assetId || assetId === '未选择资产') {
        alert('请先选择一个资产');
        return;
    }

    // 查找对应的资产数据
    const asset = assetsData.find(a => a.id === assetId);
    if (!asset) {
        alert('未找到对应的资产数据');
        return;
    }

    // 检查XLSX库是否加载成功
    if (!checkXlsxLibrary()) {
        // 显示加载XLSX库的提示
        alert('正在加载Excel处理库，请稍候再试...');
        
        // 尝试延迟重试
        setTimeout(() => {
            if (checkXlsxLibrary()) {
                printAssetCard();
            } else {
                alert('XLSX库加载失败，无法打印固定资产登记卡\n\n详细错误信息请查看控制台。');
                console.error('XLSX库加载失败');
            }
        }, 2000);
        return;
    }

    // 显示加载指示器
    showLoadingIndicator();

    // 使用setTimeout避免UI阻塞
    setTimeout(() => {
        try {
            // 检查是否有用户上传的模板
            if (assetCardTemplate) {
                // 提供更清晰的用户反馈
                
                // 使用用户上传的模板生成登记卡
                generateCardFromTemplate(asset, assetCardTemplate);
            } else {
                // 提供更清晰的用户反馈
                
                // 使用默认模板格式
                generateDefaultCard(asset);
            }

        } catch (error) {
            alert(`打印失败: ${error.message}\n\n详细错误信息请查看控制台。`);
            console.error('打印错误:', error);
        } finally {
            // 隐藏加载指示器
            hideLoadingIndicator();
        }
    }, 0);
}

// 上传固定资产登记卡模板
function uploadAssetCardTemplate() {
    // 检查XLSX库是否加载成功
    if (!checkXlsxLibrary()) {
        alert('正在加载Excel处理库，请稍候再试...');
        return;
    }
    
    // 创建文件上传对话框
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx, .xls';
    
    input.onchange = function(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, {type: 'array'});
                
                // 保存模板
                assetCardTemplate = workbook;
                
                // 分析模板的格式信息
                analyzedExcelFormats = analyzeExcelFormat(workbook);
                
                // 将模板和格式信息保存到本地存储
                saveTemplateToLocalStorage(data, analyzedExcelFormats);
                
                // 显示保存成功提示
                
                alert('模板上传成功！\n下次打印时将使用该模板格式。\n\n已提取模板格式信息：\n- 工作表数量: ' + workbook.SheetNames.length + '\n- 字体: ' + (analyzedExcelFormats.fonts.length > 0 ? analyzedExcelFormats.fonts.join(', ') : '未识别') + '\n- 列宽设置: ' + (analyzedExcelFormats.colWidths.length > 0 ? analyzedExcelFormats.colWidths.join(', ') : '默认') + '\n- 行高设置: ' + (analyzedExcelFormats.rowHeights.length > 0 ? analyzedExcelFormats.rowHeights.join(', ') : '默认'));
            } catch (error) {
                alert(`模板解析失败: ${error.message}`);
                console.error('模板解析错误:', error);
            }
        };
        reader.readAsArrayBuffer(file);
    };
    
    // 触发文件选择对话框
    input.click();
}

// 分析Excel文件的字体、行高、列宽和特殊符号等格式信息
function analyzeExcelFormat(workbook) {
    const formats = {
        fonts: new Set(),
        rowHeights: new Set(),
        colWidths: new Set(),
        specialSymbols: new Set(),
        mergedCells: 0,
        cellStyles: new Set(),
        sheets: [],
        detailedFontInfo: []  // 存储详细的字体信息用于调试
    };
    
    // 遍历所有工作表
    workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        const sheetInfo = {
            name: sheetName,
            rows: 0,
            cols: 0,
            fonts: new Set(),
            mergedCells: 0
        };
        
        // 存储列宽信息
        if (sheet['!cols']) {
            sheet['!cols'].forEach(col => {
                if (col && col.wch) {
                    formats.colWidths.add(`${col.wch}字符`);
                }
            });
        }
        
        // 存储行高信息
        if (sheet['!rows']) {
            sheet['!rows'].forEach(row => {
                if (row && row.hpx) {
                    formats.rowHeights.add(`${row.hpx}像素`);
                }
            });
        }
        
        // 统计合并单元格
        if (sheet['!merges']) {
            formats.mergedCells = sheet['!merges'].length;
            sheetInfo.mergedCells = sheet['!merges'].length;
        }
        
        // 遍历所有单元格以分析字体、样式和特殊符号
        const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
        sheetInfo.rows = range.e.r + 1;
        sheetInfo.cols = range.e.c + 1;
        
        for (let R = range.s.r; R <= range.e.r; ++R) {
            for (let C = range.s.c; C <= range.e.c; ++C) {
                const cellAddress = XLSX.utils.encode_cell({r: R, c: C});
                const cell = sheet[cellAddress];
                
                if (!cell) continue;
                
                // 分析单元格值中的特殊符号
                if (cell.v && typeof cell.v === 'string') {
                    // 检测常见的特殊符号
                    const specialChars = cell.v.match(/[•●★☆◆◇△▲□■※§¶€£¥$¢©®™°±×÷≠≈≤≥∞∑∫√∂∆π²³¹⁄₂¼¾]/g);
                    if (specialChars) {
                        specialChars.forEach(char => formats.specialSymbols.add(char));
                    }
                }
                
                // 分析单元格样式和字体
                if (cell.s) {
                    // 详细记录单元格样式信息用于调试
                    formats.detailedFontInfo.push({
                        cell: cellAddress,
                        hasStyle: !!cell.s,
                        hasFont: !!cell.s.font,
                        styleDetails: cell.s
                    });
                    
                    // 字体信息 - 增强的字体识别逻辑
                    if (cell.s.font) {
                        const fontInfo = [];
                        
                        // 字体名称 - 尝试从不同可能的位置获取
                        let fontName = cell.s.font.name;
                        
                        // 如果没有直接的字体名称，尝试从其他属性推断
                        if (!fontName) {
                            // 可以在这里添加更多字体识别逻辑
                            fontName = '未知字体';
                        }
                        
                        fontInfo.push(fontName);
                        
                        // 字体大小
                        if (cell.s.font.size) {
                            fontInfo.push(`${cell.s.font.size}pt`);
                        } else if (cell.s.font.sz) {
                            fontInfo.push(`${cell.s.font.sz}pt`);
                        }
                        
                        // 字体样式
                        if (cell.s.font.bold || cell.s.font.b) {
                            fontInfo.push('粗体');
                        }
                        if (cell.s.font.italic || cell.s.font.i) {
                            fontInfo.push('斜体');
                        }
                        if (cell.s.font.underline || cell.s.font.u) {
                            fontInfo.push('下划线');
                        }
                        if (cell.s.font.strike || cell.s.font.st) {
                            fontInfo.push('删除线');
                        }
                        
                        const fontString = fontInfo.join(', ');
                        formats.fonts.add(fontString);
                        sheetInfo.fonts.add(fontString);
                    } else {
                        // 如果没有明确的字体信息，添加默认字体标记
                        formats.fonts.add('默认字体');
                        sheetInfo.fonts.add('默认字体');
                    }
                    
                    // 单元格样式
                    const styleInfo = [];
                    if (cell.s.fill && cell.s.fill.fgColor) {
                        styleInfo.push('有色背景');
                    }
                    if (cell.s.border) {
                        styleInfo.push('有边框');
                    }
                    if (cell.s.alignment) {
                        const alignments = [];
                        if (cell.s.alignment.horizontal) alignments.push(cell.s.alignment.horizontal);
                        if (cell.s.alignment.vertical) alignments.push(cell.s.alignment.vertical);
                        if (alignments.length > 0) {
                            styleInfo.push(alignments.join(', '));
                        }
                    }
                    
                    if (styleInfo.length > 0) {
                        formats.cellStyles.add(styleInfo.join(', '));
                    }
                } else {
                    // 如果单元格没有样式信息，也记录下来
                    formats.detailedFontInfo.push({
                        cell: cellAddress,
                        hasStyle: false,
                        note: '单元格没有样式信息'
                    });
                    
                    // 添加默认字体标记
                    formats.fonts.add('默认字体');
                    sheetInfo.fonts.add('默认字体');
                }
            }
        }
        
        formats.sheets.push(sheetInfo);
    });
    
    // 输出调试信息
    
    // 转换Set为数组，便于显示
    return {
        fonts: Array.from(formats.fonts),
        rowHeights: Array.from(formats.rowHeights),
        colWidths: Array.from(formats.colWidths),
        specialSymbols: Array.from(formats.specialSymbols),
        mergedCells: formats.mergedCells,
        cellStyles: Array.from(formats.cellStyles),
        sheets: formats.sheets,
        detailedFontInfo: formats.detailedFontInfo
    };
}

// 从用户模板生成固定资产登记卡
function generateCardFromTemplate(asset, template) {
    try {
        showLoadingIndicator();
        
        // 创建模板的副本以避免修改原始单元格样式
        const workbook = XLSX.utils.book_new();
        
        // 分析模板格式信息
        const templateFormats = analyzeExcelFormat(template);
        
        // 复制模板中的所有工作表并应用格式
        template.SheetNames.forEach(sheetName => {
            // 直接复制工作表对象以保留所有原始格式
            const newWorksheet = JSON.parse(JSON.stringify(template.Sheets[sheetName]));
            
            // 获取工作表数据范围
            const range = XLSX.utils.decode_range(newWorksheet['!ref'] || 'A1:A1');
            
            // 遍历所有单元格查找关键字并替换为资产数据
            for (let R = range.s.r; R <= range.e.r; ++R) {
                for (let C = range.s.c; C <= range.e.c; ++C) {
                    const cellAddress = XLSX.utils.encode_cell({r: R, c: C});
                    const cell = newWorksheet[cellAddress];
                    
                    if (cell) {
                        // 深拷贝原始单元格样式，确保完全保留样式信息
                        const originalStyle = cell.s ? JSON.parse(JSON.stringify(cell.s)) : null;
                        
                        // 检查是否为特殊格式单元格（如分割线）
                        if (cell.v && typeof cell.v === 'string') {
                            // 特殊处理包含分割线或特殊符号的单元格
                            const isSpecialFormatCell = cell.v.match(/^[•●★☆◆◇△▲□■※§¶-]+$/);
                            if (isSpecialFormatCell) {
                            }
                            
                            // 查找并替换关键字，同时保留原始样式
                            if (cell.v.includes('{资产编号}')) {
                                cell.v = cell.v.replace(/{资产编号}/g, asset.id);
                            } else if (cell.v.includes('{主体}')) {
                                cell.v = cell.v.replace(/{主体}/g, asset.owner);
                            } else if (cell.v.includes('{设备类型}')) {
                                cell.v = cell.v.replace(/{设备类型}/g, asset.type);
                            } else if (cell.v.includes('{品牌型号}')) {
                                cell.v = cell.v.replace(/{品牌型号}/g, asset.brandModel);
                            } else if (cell.v.includes('{配置信息}')) {
                                cell.v = cell.v.replace(/{配置信息}/g, asset.configuration || '-');
                            } else if (cell.v.includes('{购入日期}')) {
                                cell.v = cell.v.replace(/{购入日期}/g, formatDate(asset.purchaseDate));
                            } else if (cell.v.includes('{状态}')) {
                                cell.v = cell.v.replace(/{状态}/g, getStatusText(asset.status));
                            } else if (cell.v.includes('{使用人}')) {
                                cell.v = cell.v.replace(/{使用人}/g, asset.user || '-');
                            } else if (cell.v.includes('{部门}')) {
                                cell.v = cell.v.replace(/{部门}/g, asset.department || '-');
                            } else if (cell.v.includes('{位置}')) {
                                cell.v = cell.v.replace(/{位置}/g, asset.location || '-');
                            } else if (cell.v.includes('{负责人}')) {
                                cell.v = cell.v.replace(/{负责人}/g, asset.manager || '-');
                            } else if (cell.v.includes('{单位}')) {
                                cell.v = cell.v.replace(/{单位}/g, asset.unit || '台');
                            } else if (cell.v.includes('{数量}')) {
                                cell.v = cell.v.replace(/{数量}/g, asset.quantity || 1);
                            } else if (cell.v.includes('{价值}')) {
                                cell.v = cell.v.replace(/{价值}/g, asset.value ? '¥' + Number(asset.value).toLocaleString('zh-CN', {minimumFractionDigits: 2}) : '');
                            } else if (cell.v.includes('{折旧年限}')) {
                                cell.v = cell.v.replace(/{折旧年限}/g, asset.depreciationYears || '');
                            } else if (cell.v.includes('{采购编号}')) {
                                cell.v = cell.v.replace(/{采购编号}/g, asset.purchaseNo || '');
                            } else if (cell.v.includes('{付款编号}')) {
                                cell.v = cell.v.replace(/{付款编号}/g, asset.paymentNo || '');
                            } else if (cell.v.includes('{填卡人}')) {
                                cell.v = cell.v.replace(/{填卡人}/g, asset.manager || '');
                            } else if (cell.v.includes('{资产名称}')) {
                                cell.v = cell.v.replace(/{资产名称}/g, asset.type || '-');
                            } else if (cell.v.includes('{资产规格}')) {
                                cell.v = cell.v.replace(/{资产规格}/g, asset.configuration || asset.brandModel || '-');
                            } else if (cell.v.includes('{损坏原因}')) {
                                cell.v = cell.v.replace(/{损坏原因}/g, (asset.damageReason && asset.status === 'damaged') ? asset.damageReason : '');
                            }
                        }
                        
                        // 强制恢复原始单元格样式，确保字体和格式不丢失
                        if (originalStyle) {
                            cell.s = originalStyle;
                            
                            // 如果有字体信息，记录日志
                            if (cell.s.font) {
                                const fontInfo = [];
                                if (cell.s.font.name) fontInfo.push(cell.s.font.name);
                                if (cell.s.font.size || cell.s.font.sz) fontInfo.push(`${cell.s.font.size || cell.s.font.sz}pt`);
                                if (cell.s.font.bold || cell.s.font.b) fontInfo.push('粗体');
                                if (cell.s.font.italic || cell.s.font.i) fontInfo.push('斜体');
                            }
                        } else {
                        }
                    }
                }
            }
            
            XLSX.utils.book_append_sheet(workbook, newWorksheet, sheetName);
        });
        
        // 导出文件
        const fileName = `固定资产登记卡_${asset.id}_${new Date().toLocaleDateString().replace(/\//g, '-')}.xlsx`;
        XLSX.writeFile(workbook, fileName);
        
        // 生成格式信息摘要
        let formatSummary = `\n\n模板格式信息:\n`;
        formatSummary += `- 工作表数量: ${templateFormats.sheets.length}\n`;
        formatSummary += `- 字体: ${templateFormats.fonts.length > 0 ? templateFormats.fonts.join(', ') : '未识别'}\n`;
        formatSummary += `- 列宽设置: ${templateFormats.colWidths.length > 0 ? templateFormats.colWidths.join(', ') : '默认'}\n`;
        formatSummary += `- 行高设置: ${templateFormats.rowHeights.length > 0 ? templateFormats.rowHeights.join(', ') : '默认'}\n`;
        
        if (templateFormats.specialSymbols.length > 0) {
            formatSummary += `- 特殊符号: ${templateFormats.specialSymbols.join(', ')}\n`;
        }
        
        if (templateFormats.mergedCells > 0) {
            formatSummary += `- 合并单元格: ${templateFormats.mergedCells}个\n`;
        }
        
        if (templateFormats.cellStyles.length > 0) {
            formatSummary += `- 单元格样式: ${templateFormats.cellStyles.slice(0, 3).join(', ')}${templateFormats.cellStyles.length > 3 ? '...' : ''}`;
        }
        
        alert(`固定资产登记卡已生成: ${fileName}\n\n该文件完全保留了您上传模板的所有格式和样式，可以直接打印使用。${formatSummary}\n\n字体和分割线等特殊格式已特别处理并保留。`);
    } catch (error) {
        alert(`使用模板生成失败: ${error.message}\n\n将使用默认模板格式。\n\n详细错误信息请查看控制台。`);
        console.error('模板生成错误:', error);
        // 回退到默认模板
        generateDefaultCard(asset);
    } finally {
        hideLoadingIndicator();
    }
}

// 生成默认格式的固定资产登记卡
function generateDefaultCard(asset) {
    try {
        // 默认公司名取系统名称(系统设置 → updateSystemTitle → document.title), 不硬编码历史公司名
        const companyName = (document.title || '').trim() || '固定资产管理系统';
        
        // 格式化价值
        const formatValue = (v) => {
            if (!v || Number(v) === 0) return '';
            return '¥' + Number(v).toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2});
        };
        
        // 格式化日期为中文格式
        const formatDateCn = (dateStr) => {
            if (!dateStr) return '';
            const parts = dateStr.split('-');
            if (parts.length !== 3) return dateStr;
            return `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日`;
        };
        
        const assetName = asset.type || '-';
        const assetSpec = asset.configuration || asset.brandModel || '-';
        
        // 构建单份登记卡 HTML
        function buildCardHTML(cardTitle) {
            return `
                <table class="card-table">
                    <tr>
                        <td colspan="4" class="card-title">${companyName}固定资产登记卡（${cardTitle}）</td>
                    </tr>
                    <tr>
                        <td class="label">购买日期</td>
                        <td class="value">${formatDateCn(asset.purchaseDate)}</td>
                        <td class="label">购买主体</td>
                        <td class="value">${asset.owner || ''}</td>
                    </tr>
                    <tr>
                        <td class="label">资产编号</td>
                        <td class="value">${asset.id}</td>
                        <td class="label">资产名称</td>
                        <td class="value">${assetName}</td>
                    </tr>
                    <tr>
                        <td class="label">资产规格</td>
                        <td class="value">${assetSpec}</td>
                        <td class="label">单位</td>
                        <td class="value center">${asset.unit || '台'}</td>
                    </tr>
                    <tr>
                        <td class="label">数量</td>
                        <td class="value center">${asset.quantity || 1}</td>
                        <td class="label">价值</td>
                        <td class="value center">${formatValue(asset.value)}</td>
                    </tr>
                    <tr>
                        <td class="label">折旧年限</td>
                        <td class="value center">${asset.depreciationYears ? asset.depreciationYears + '年' : ''}</td>
                        <td class="label">使用部门</td>
                        <td class="value">${asset.department || ''}</td>
                    </tr>
                    <tr>
                        <td class="label">备注</td>
                        <td class="value remark-col">
                            <div class="remark-item"><span class="remark-key">采购编号：</span><span class="remark-val">${asset.purchaseNo || ''}</span></div>
                            <div class="remark-item"><span class="remark-key">付款编号：</span><span class="remark-val">${asset.paymentNo || ''}</span></div>
                        </td>
                        <td class="label">填卡人</td>
                        <td class="value center sign">${asset.manager || ''}</td>
                    </tr>
                </table>`;
        }
        
        // 构建完整 HTML 页面
        const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>固定资产登记卡 - ${asset.id}</title>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    @page {
        size: A4 portrait;
        margin: 5mm 8mm;
    }
    html, body {
        width: 100%;
        height: 100%;
        font-family: '宋体', SimSun, serif;
        color: #000;
    }
    .page {
        /* A4 可用区域: 210mm - 16mm = 194mm 宽; 297mm - 10mm = 287mm 高 */
        width: 194mm;
        height: 287mm;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
    }
    .card-table {
        flex: 1 1 auto;
        width: 100%;
        border-collapse: collapse;
        border: 2.5px solid #000;
        table-layout: fixed;
    }
    .card-table tr {
        height: calc((100% - 42px) / 6);
    }
    .card-table tr:first-child {
        height: 42px;
    }
    .card-table td {
        border: 1.2px solid #000;
        padding: 6px 12px;
        font-size: 13.5px;
        line-height: 1.35;
        vertical-align: middle;
    }
    .card-table .card-title {
        text-align: center;
        font-weight: bold;
        font-size: 18px;
        letter-spacing: 2px;
        border-bottom: 2.5px solid #000;
    }
    .card-table .label {
        text-align: center;
        font-weight: bold;
        background-color: #fafafa;
        width: 14%;
    }
    .card-table .value {
        width: 36%;
    }
    .card-table .center {
        text-align: center;
    }
    .card-table .remark-col {
        padding: 4px 10px;
    }
    .card-table .remark-item {
        padding: 2px 0;
        font-size: 13px;
        display: flex;
        align-items: center;
    }
    .card-table .remark-key {
        font-weight: bold;
        margin-right: 4px;
        white-space: nowrap;
    }
    .card-table .remark-val {
        flex: 1;
    }
    .card-table .sign {
        font-family: '楷体', 'KaiTi', '华文行楷', cursive;
        font-size: 18px;
        letter-spacing: 2px;
    }
    .divider {
        flex: 0 0 12px;
        border-top: 2px dashed #444;
        border-bottom: 2px dashed #444;
        text-align: center;
        line-height: 12px;
        font-size: 10px;
        color: #555;
        padding: 2px 0;
        margin: 0;
    }
    @media print {
        body { padding: 0; }
        .page { width: 100%; height: calc(100vh - 0.1px); }
    }
</style>
</head>
<body>
<div class="page">
${buildCardHTML('行政联')}
<div class="divider">✂ ── 裁切线（行政联/财务联分开存档）── ✂</div>
${buildCardHTML('财务联')}
</div>
<script>
    window.onload = function() {
        setTimeout(function() { window.print(); }, 300);
    };
</script>
</body>
</html>`;
        
        // 打开新窗口并写入 HTML
        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            alert('无法打开打印窗口，请检查浏览器是否阻止了弹出窗口');
            return;
        }
        printWindow.document.write(html);
        printWindow.document.close();
        
    } catch (error) {
        alert(`打印失败: ${error.message}`);
        console.error('打印错误:', error);
    }
}

// 初始化时检查XLSX库
checkXlsxLibrary();

// 如果未加载成功，尝试备用加载方式
if (!xlsxLibraryLoaded) {
    attemptLoadXlsxLibrary();
}

// 下载Excel模板
