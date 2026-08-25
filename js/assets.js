/**
 * 资产列表渲染、分页、详情查看、附件展示、图片查看器
 * 从 script.js 拆分而来 - 请勿手动修改行号映射
 */

// 状态徽章模板缓存（避免每个 createAssetTableRow 重建对象 + 字符串拼接）
const __ASSET_STATUS_BADGE_CACHE = Object.create(null);
(function initStatusBadgeCache() {
    const items = [
        ['active', 'status-active', 'fa-check-circle', '在用'],
        ['idle', 'status-idle', 'fa-pause-circle', '闲置'],
        ['damaged', 'status-damaged', 'fa-exclamation-circle', '损坏'],
        ['maintenance', 'status-maintenance', 'fa-wrench', '维修中'],
        ['retired', 'status-retired', 'fa-ban', '报废']
    ];
    for (const [k, cls, icon, text] of items) {
        __ASSET_STATUS_BADGE_CACHE[k] = '<span class="status-badge ' + cls + '"><i class="fas ' + icon + '"></i> ' + text + '</span>';
    }
})();

// HTML 转义：防止资产字段里包含 <>&"' 时把表格结构打坏或触发 XSS
function __escapeHtml(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.length === 0) return '';
    // 无特殊字符的常见场景快速返回
    if (!/[<>&"']/.test(s)) return s;
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderAllAssets(filteredAssets = null) {
    // 防抖处理，避免频繁渲染（50ms，平衡性能与响应速度）
    if (renderTimeout) clearTimeout(renderTimeout);

    renderTimeout = setTimeout(() => {
        const tableBody = getElement('all-assets-table');

        if (!tableBody) return;

        let assetsToRender = filteredAssets || assetsData;

        // 分页处理
        const totalCount = assetsToRender.length;
        const totalPages = Math.max(1, Math.ceil(totalCount / recordsPerPage));
        if (currentPage > totalPages) currentPage = totalPages;
        if (currentPage < 1) currentPage = 1;
        const pageStart = (currentPage - 1) * recordsPerPage;
        const pageEnd = Math.min(pageStart + recordsPerPage, totalCount);
        const pageSlice = (totalCount > 0) ? assetsToRender.slice(pageStart, pageEnd) : [];

        if (pageSlice.length === 0) {
            // 资产表格固定 8 列（id/owner/type/brandModel/user/department/status/操作）
            tableBody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 20px;">暂无资产记录，请添加或导入资产</td></tr>';
        } else {
            // 单字符串拼接 + 一次 innerHTML 赋值，比 DocumentFragment + 每行 createElement/innerHTML 快
            // （浏览器对整段 innerHTML 有专门的快速解析路径，N 次 DOM 插入合并为 1 次）
            let rowsHtml = '';
            for (let i = 0, len = pageSlice.length; i < len; i++) {
                rowsHtml += buildAssetTableRowHtml(pageSlice[i], false);
            }
            tableBody.innerHTML = rowsHtml;
        }

        // 渲染分页控件
        renderPagination(filteredAssets, totalCount, totalPages);
    }, 50); // 50ms防抖延迟
}

// 基于字符串构建行 HTML（避免为每行创建 DOM 节点、避免创建独立对象）
function buildAssetTableRowHtml(asset, showDamageReason) {
    const assetId = asset ? asset.id : '';
    const statusBadge = __ASSET_STATUS_BADGE_CACHE[asset && asset.status] || '';
    const damageReasonCell = showDamageReason
        ? '<td>' + __escapeHtml((asset && asset.damageReason) || '-') + '</td>'
        : '';

    return '<tr data-id="' + __escapeHtml(assetId) + '">' +
        '<td>' + __escapeHtml(assetId) + '</td>' +
        '<td>' + __escapeHtml(asset ? asset.owner : '') + '</td>' +
        '<td>' + __escapeHtml(asset ? asset.type : '') + '</td>' +
        '<td>' + __escapeHtml(asset ? asset.brandModel : '') + '</td>' +
        '<td>' + __escapeHtml((asset && asset.user) || '-') + '</td>' +
        '<td>' + __escapeHtml((asset && asset.department) || '-') + '</td>' +
        damageReasonCell +
        '<td>' + statusBadge + '</td>' +
        '<td>' +
            '<button class="btn btn-sm btn-primary view-asset" data-id="' + __escapeHtml(assetId) + '">' +
                '<i class="fas fa-eye"></i> 查看' +
            '</button>' +
        '</td>' +
    '</tr>';
}

// 渲染分页控件 - 根据实际数据量动态生成
// 允许传入预计算的 totalCount/totalPages（renderAllAssets 已算过），避免重复计算
function renderPagination(filteredAssets = null, totalCountIn, totalPagesIn) {
    const paginationContainer = document.querySelector('#assets-page .pagination');
    if (!paginationContainer) return;
    
    // 获取数据
    let dataToUse = filteredAssets || assetsData;
    const totalCount = (typeof totalCountIn === 'number' && totalCountIn >= 0)
        ? totalCountIn
        : dataToUse.length;
    let totalPages = (typeof totalPagesIn === 'number' && totalPagesIn >= 1)
        ? totalPagesIn
        : Math.ceil(totalCount / recordsPerPage);
    if (totalPages < 1) totalPages = 1;
    
    // 更新"共X条记录"文本
    const totalRecordsEl = document.getElementById('total-records');
    if (totalRecordsEl) {
        totalRecordsEl.textContent = `共 ${totalCount} 条记录`;
    }
    
    // 清空现有的分页控件
    paginationContainer.innerHTML = '';
    
    if (totalCount === 0) {
        // 如果没有数据，不显示分页控件按钮
        return;
    }
    
    // （totalPages 已在函数入口基于传入参数或 recordsPerPage 计算完成）
    // 确保currentPage不超过总页数
    if (currentPage > totalPages) {
        currentPage = totalPages;
    }
    if (currentPage < 1) {
        currentPage = 1;
    }
    
    // 使用 DocumentFragment 批量构建分页控件，避免多次 reflow
    const fragment = document.createDocumentFragment();

    // 添加上一页按钮
    const prevPageItem = document.createElement('div');
    prevPageItem.className = `pagination-item${currentPage <= 1 ? ' disabled' : ''}`;
    prevPageItem.id = 'prev-page';
    prevPageItem.innerHTML = '<i class="fas fa-chevron-left"></i>';
    if (currentPage > 1) {
        prevPageItem.addEventListener('click', () => {
            currentPage--;
            hasUnsavedChanges = true;
            applyFilters();
        });
    }
    fragment.appendChild(prevPageItem);

    // 限制显示的页码数量，最多显示10个页码
    const maxVisiblePages = 10;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

    // 调整起始页码，确保显示足够的页码
    if (endPage - startPage + 1 < maxVisiblePages) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }

    // 如果只有一页或不需要省略号，简化显示
    if (totalPages <= maxVisiblePages) {
        startPage = 1;
        endPage = totalPages;
    }

    // 添加首页按钮
    if (startPage > 1) {
        const firstPageItem = createPageItem(1);
        fragment.appendChild(firstPageItem);

        // 如果首页和起始页之间有间隔，添加省略号
        if (startPage > 2) {
            const ellipsis = document.createElement('div');
            ellipsis.className = 'pagination-item';
            ellipsis.textContent = '...';
            ellipsis.style.cursor = 'default';
            ellipsis.style.pointerEvents = 'none';
            fragment.appendChild(ellipsis);
        }
    }

    // 添加可见的页码
    for (let i = startPage; i <= endPage; i++) {
        const pageItem = createPageItem(i);
        fragment.appendChild(pageItem);
    }

    // 添加尾页按钮
    if (endPage < totalPages) {
        // 如果结束页和尾页之间有间隔，添加省略号
        if (endPage < totalPages - 1) {
            const ellipsis = document.createElement('div');
            ellipsis.className = 'pagination-item';
            ellipsis.textContent = '...';
            ellipsis.style.cursor = 'default';
            ellipsis.style.pointerEvents = 'none';
            fragment.appendChild(ellipsis);
        }

        const lastPageItem = createPageItem(totalPages);
        fragment.appendChild(lastPageItem);
    }

    // 添加下一页按钮
    const nextPageItem = document.createElement('div');
    nextPageItem.className = `pagination-item${currentPage >= totalPages ? ' disabled' : ''}`;
    nextPageItem.id = 'next-page';
    nextPageItem.innerHTML = '<i class="fas fa-chevron-right"></i>';
    if (currentPage < totalPages) {
        nextPageItem.addEventListener('click', () => {
            currentPage++;
            hasUnsavedChanges = true;
            applyFilters();
        });
    }
    fragment.appendChild(nextPageItem);

    // 一次性追加所有分页元素（仅1次 reflow）
    paginationContainer.appendChild(fragment);
    
    // 创建页码项的辅助函数
    function createPageItem(pageNumber) {
        const pageItem = document.createElement('div');
        pageItem.className = `pagination-item ${pageNumber === currentPage ? 'active' : ''}`;
        pageItem.textContent = pageNumber;
        
        // 为非当前页添加点击事件
        if (pageNumber !== currentPage) {
            pageItem.addEventListener('click', () => {
                currentPage = pageNumber;
                // 设置为有未保存的更改，确保在页面卸载时保存currentPage
                hasUnsavedChanges = true;
                // 使用applyFilters而不是直接传入filteredAssets，确保总是使用最新的筛选条件
                applyFilters();
            });
        }
        
        return pageItem;
    }
}

// 创建资产表格行 - 优化DOM操作和状态处理
// 说明：renderAllAssets 使用 buildAssetTableRowHtml 走字符串拼接（快路径）。
// 这里保留 createElement 版本，用于单条插入 / 外部调用者需要拿到真实 DOM 的场景。
function createAssetTableRow(asset, showDamageReason = false) {
    const row = document.createElement('tr');
    if (asset && asset.id) row.setAttribute('data-id', String(asset.id));
    row.innerHTML = buildAssetTableRowHtml(asset, showDamageReason);
    const colspan = showDamageReason ? 9 : 8;
    return { row, colspan };
}

// 查看资产详情 - 优化DOM操作和防抖处理
let viewAssetTimeout;
function viewAssetDetails(assetId) {
    // 防抖处理
    if (viewAssetTimeout) clearTimeout(viewAssetTimeout);

    viewAssetTimeout = setTimeout(() => {
        // 使用requestAnimationFrame优化UI渲染
        requestAnimationFrame(() => {
            const asset = assetsData.find(a => a.id === assetId);
            if (!asset) return;
            // 记录当前查看的资产ID，供 openFileViewer 按需加载附件 url
            window._currentViewingAssetId = assetId;
            // 创建一个对象存储需要更新的元素
            const elementsToUpdate = {
                'asset-id': asset.id,
                'detail-asset-code': asset.id,
                'detail-owner': asset.owner,
                'detail-asset-type': asset.type,
                'detail-brand-model': asset.brandModel,
                'detail-configuration': asset.configuration || '-',
                'detail-purchase-date': formatDate(asset.purchaseDate),
                'detail-status': getStatusText(asset.status),
                'detail-user': asset.user || '-',
                'detail-department': asset.department || '-',
                'detail-location': asset.location || '-',
                'detail-manager': asset.manager || '-',
                'detail-unit': asset.unit || '-',
                'detail-quantity': asset.quantity || 1,
                'detail-value': asset.value ? '¥' + Number(asset.value).toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '-',
                'detail-depreciation-years': asset.depreciationYears ? asset.depreciationYears + ' 年' : '-',
                'detail-purchase-no': asset.purchaseNo || '-',
                'detail-payment-no': asset.paymentNo || '-'
            };
            
            // 批量更新DOM，减少重绘
            Object.keys(elementsToUpdate).forEach(id => {
                const element = getElement(id);
                if (element) {
                    element.textContent = elementsToUpdate[id];
                }
            });
            
            // 更新状态徽章
            const statusBadge = getElement('asset-status-badge');
            if (statusBadge) {
                statusBadge.className = 'status-badge';
                statusBadge.classList.add(`status-${asset.status}`);
                statusBadge.innerHTML = `<i class="fas ${getStatusIcon(asset.status)}"></i> ${getStatusText(asset.status)}`;
            }
            
            // 处理损坏原因显示
            const damageContainer = getElement('damage-reason-container');
            const damageReason = getElement('detail-damage-reason');
            if (damageContainer && damageReason) {
                if (asset.status === 'damaged' && asset.damageReason) {
                    damageReason.textContent = asset.damageReason;
                    damageContainer.style.display = 'block';
                } else {
                    damageContainer.style.display = 'none';
                }
            }
            
            // 延迟渲染附件和维护记录，让主UI先渲染完成
            requestAnimationFrame(() => {
                renderAttachments(asset.attachments);
                renderMaintenanceRecords(asset.maintenanceRecords);
            });
            
            // 切换到详情页 - 直接显示资产详情页面，不通过菜单切换
            try {
                // 移除所有页面的活跃状态
                document.querySelectorAll('.page-content').forEach(page => {
                    page.classList.remove('active');
                });
                
                // 激活资产详情页面
                const assetDetailPage = document.getElementById('asset-detail-page');
                if (assetDetailPage) {
                    assetDetailPage.classList.add('active');
                } else {
                    console.error('找不到资产详情页面元素');
                }
            } catch (error) {
                console.error('切换资产详情页面时发生错误:', error);
            }
        });
    }, 50); // 50ms防抖延迟
}

// 渲染附件
function renderAttachments(attachments) {
    const container = getElement('attachments-container');
    const list = getElement('attachments-list');
    const noAttachments = getElement('no-attachments');

    list.innerHTML = '';

    if (!attachments || attachments.length === 0) {
        noAttachments.style.display = 'block';
        list.style.display = 'none';
        return;
    }

    noAttachments.style.display = 'none';
    list.style.display = 'block';

    // 使用文档片段减少DOM重绘
    const fragment = document.createDocumentFragment();
    attachments.forEach(attachment => {
        const isImage = attachment.type && attachment.type.startsWith('image/');
        const isPdf = attachment.type === 'application/pdf';

        const item = document.createElement('div');
        item.className = 'attachment-item';
        item.dataset.type = attachment.type || '';
        item.dataset.url = attachment.url || '';

        // 图片/PDF 缩略图懒加载：src 留空，真实值放 data-src，滚动到视口再赋值
        // 避免打开详情模态一次性展开几百 MB base64 导致页面卡顿
        function lazyImgAttrs(src) {
            if (!src) return { src: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="200"><rect width="100%" height="100%" fill="%23f3f4f6"/></svg>'), dataSrc: '' };
            return {
                src: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="200"><rect width="100%" height="100%" fill="%23f3f4f6"/><text x="50%" y="50%" text-anchor="middle" fill="%239ca3af" font-size="14" dy=".3em">loading...</text></svg>'),
                dataSrc: src
            };
        }

        let thumbnailHtml = '';
        if (isImage) {
            const src = attachment.thumbnail || attachment.url || '';
            const a = lazyImgAttrs(src);
            thumbnailHtml = `<img src="${a.src}" data-src="${a.dataSrc}" class="attachment-thumbnail att-lazy" alt="${attachment.name}" loading="lazy" decoding="async">`;
        } else if (isPdf) {
            if (attachment.thumbnail) {
                const a = lazyImgAttrs(attachment.thumbnail);
                thumbnailHtml = `<img src="${a.src}" data-src="${a.dataSrc}" class="attachment-thumbnail att-lazy" alt="${attachment.name}" loading="lazy" decoding="async" style="object-fit: contain; border: 1px solid var(--border, #e0e0e0); border-radius: 4px; background: #fff;">`;
            } else {
                thumbnailHtml = `
                    <div class="attachment-thumbnail" style="display: flex; align-items: center; justify-content: center;">
                        <i class="fas fa-file-pdf fa-5x" style="color: var(--danger, #ff4d4f);"></i>
                    </div>
                `;
                // url 在 IndexedDB 里，异步生成缩略图
                if (attachment.url && typeof createPdfThumbnail === 'function') {
                    createPdfThumbnail(attachment.url, 160, 200, (thumb) => {
                        if (thumb) {
                            attachment.thumbnail = thumb;
                            const img = item.querySelector('.attachment-thumbnail');
                            if (img) {
                                const repl = document.createElement('img');
                                repl.src = thumb;
                                repl.alt = attachment.name;
                                repl.loading = 'lazy';
                                repl.decoding = 'async';
                                repl.className = 'attachment-thumbnail att-lazy';
                                repl.style.cssText = 'object-fit: contain; border: 1px solid var(--border, #e0e0e0); border-radius: 4px; background: #fff;';
                                img.replaceWith(repl);
                            }
                        }
                    }, attachment.name);
                }
            }
        } else {
            thumbnailHtml = `
                <div class="attachment-thumbnail" style="display: flex; align-items: center; justify-content: center;">
                    <i class="fas fa-file fa-5x" style="color: var(--brand, #3081eb);"></i>
                </div>
            `;
        }

        item.innerHTML = `
            ${thumbnailHtml}
            <div class="attachment-name">${attachment.name || ''}</div>
        `;

        item.addEventListener('click', () => openFileViewer(attachment));
        fragment.appendChild(item);
    });

    list.appendChild(fragment);

    // IntersectionObserver：只把进入视口的懒加载图真实赋值（从 data-src → src）
    if (!window.__attLazyObserver) {
        try {
            const io = new IntersectionObserver((entries) => {
                for (const e of entries) {
                    if (!e.isIntersecting) continue;
                    const el = e.target;
                    const src = el.getAttribute('data-src');
                    if (src) { el.src = src; el.removeAttribute('data-src'); }
                    io.unobserve(el);
                }
            }, { rootMargin: '200px' });
            window.__attLazyObserver = io;
        } catch (_) { /* 老内核不支持 IO，则下面兜底直接赋值 */ }
    }
    const io = window.__attLazyObserver;
    list.querySelectorAll('img.att-lazy').forEach(img => {
        if (io && typeof io.observe === 'function') { io.observe(img); }
        else {
            const ds = img.getAttribute('data-src');
            if (ds) { img.src = ds; img.removeAttribute('data-src'); }
        }
    });
}

// 打开文件查看器
async function openFileViewer(attachment) {
    // 使用全局modal变量，避免重复声明
    const modal = getElement('image-viewer-modal');
    const imageElement = getElement('modal-image');
    const pdfElement = document.getElementById('modal-pdf');
    const modalTitle = document.getElementById('modal-title');

    // 确保所有元素都存在
    if (!modal || !imageElement || !pdfElement || !modalTitle) {
        console.error('文件查看器元素未找到');
        return;
    }

    // 在打开新图片前，先清理之前可能存在的事件监听器
    if (typeof modal.cleanupImageZoomControls === 'function') {
        modal.cleanupImageZoomControls();
    }

    // 重置图片缩放
    resetImageZoom();

    // 设置模态框标题
    modalTitle.textContent = `查看文件: ${attachment.name || '未知文件名'}`;

    // 如果 attachment.url 不存在（localStorage 瘦身后），从 IndexedDB 加载完整数据
    if (!attachment.url) {
        const assetId = window._currentViewingAssetId;
        if (assetId && storageManager) {
            try {
                const fullData = await storageManager.getItem(STORAGE_KEYS.ASSET_MANAGEMENT_DATA);
                if (fullData) {
                    const assets = Array.isArray(fullData) ? fullData : (fullData.data || []);
                    const fullAsset = assets.find(a => a.id === assetId);
                    if (fullAsset && fullAsset.attachments) {
                        const fullAtt = fullAsset.attachments.find(a => a.name === attachment.name);
                        if (fullAtt && fullAtt.url) {
                            attachment.url = fullAtt.url;
                        }
                    }
                }
            } catch(e) {
                console.warn('从 IndexedDB 加载附件 url 失败:', e);
            }
        }
        if (!attachment.url) {
            console.warn('附件 url 不可用:', attachment.name);
            return;
        }
    }

    if (attachment.type && attachment.type.startsWith('image/')) {
        // 预加载图片，加载完成后再显示到页面中，避免"先空白后图片"的视觉闪烁
        const tempImg = new Image();
        const showModalNow = () => {
            imageElement.style.display = 'block';
            pdfElement.style.display = 'none';
            setupImageZoomControls();
            modal.classList.add('active');
        };
        tempImg.onload = function() {
            imageElement.src = attachment.url;
            showModalNow();
        };
        tempImg.onerror = function() {
            console.warn('图片加载失败:', attachment.name);
            if (attachment.thumbnail && attachment.thumbnail !== attachment.url) {
                imageElement.src = attachment.thumbnail;
            } else {
                imageElement.style.display = 'none';
                const placeholder = document.createElement('div');
                placeholder.className = 'image-placeholder';
                placeholder.textContent = '图片无法加载（数据可能已损坏）';
                const mdBody = modal.querySelector('.modal-body') || modal;
                mdBody.appendChild(placeholder);
                setTimeout(() => {
                    const ph = modal.querySelector('.image-placeholder');
                    if (ph) ph.remove();
                }, 3000);
            }
            modal.classList.add('active');
        };
        tempImg.src = attachment.url;
        // DataURL 通常会从缓存命中；若 complete 直接走显示逻辑避免等待
        if (tempImg.complete && tempImg.naturalWidth) {
            imageElement.src = attachment.url;
            showModalNow();
        }
    } else if (attachment.type === 'application/pdf') {
        pdfElement.src = attachment.url;
        pdfElement.style.display = 'block';
        imageElement.style.display = 'none';
        modal.classList.add('active');
    } else {
        alert('不支持的文件类型');
        return;
    }
}

// 全局变量，用于图片拖动
let translateX = 0;
let translateY = 0;

// 缩放图片函数
function zoomImage(imageElement, zoomAmount) {
    // 健壮性检查
    if (!imageElement || typeof zoomAmount !== 'number') {
        console.error('zoomImage: 参数无效');
        return;
    }
    
    // 确保currentZoom已定义
    if (typeof currentZoom !== 'number') {
        currentZoom = 1;
    }
    
    const newZoom = currentZoom + zoomAmount;
    if (newZoom > 0.1 && newZoom < 10) {
        currentZoom = newZoom;
        
        // 更新图片变换，保持当前拖动位置
        imageElement.style.transform = `scale(${currentZoom}) translate(${translateX}px, ${translateY}px)`;
    }
}

// 设置图片缩放控制
function setupImageZoomControls() {
    const imageElement = getElement('modal-image');
    const zoomInBtn = document.getElementById('zoom-in-btn');
    const zoomOutBtn = document.getElementById('zoom-out-btn');
    const zoomResetBtn = document.getElementById('zoom-reset-btn');
    const modal = getElement('image-viewer-modal');
    
    // 确保元素存在
    if (!imageElement || !zoomInBtn || !zoomOutBtn || !zoomResetBtn || !modal) {
        console.error('图片查看器元素未找到');
        return;
    }
    
    // 确保只有在图片显示时才激活缩放控制
    if (imageElement.style.display === 'block') {
        // 重置拖动状态
        translateX = 0;
        translateY = 0;
        
        // 创建事件处理函数，方便后续清理
        const handleZoomIn = () => zoomImage(imageElement, 0.1);
        const handleZoomOut = () => zoomImage(imageElement, -0.1);
        const handleZoomReset = resetImageZoom;
        
        const handleWheel = (e) => {
            e.preventDefault();
            zoomImage(imageElement, e.deltaY < 0 ? 0.1 : -0.1);
        };
        
        let isDragging = false;
        let startX, startY;
        
        const handleMouseDown = (e) => {
            isDragging = true;
            startX = e.clientX - translateX;
            startY = e.clientY - translateY;
            imageElement.style.cursor = 'grabbing';
        };
        
        const handleMouseMove = (e) => {
            if (!isDragging) return;
            
            translateX = e.clientX - startX;
            translateY = e.clientY - startY;
            
            // 仅在缩放后允许拖动
            if (currentZoom > 1.01) {
                imageElement.style.transform = `scale(${currentZoom}) translate(${translateX}px, ${translateY}px)`;
            } else {
                // 重置拖动
                translateX = 0;
                translateY = 0;
            }
        };
        
        const handleMouseUp = () => {
            isDragging = false;
            imageElement.style.cursor = 'grab';
        };
        
        const handleMouseLeave = () => {
            isDragging = false;
            imageElement.style.cursor = 'grab';
        };
        
        // 绑定事件监听器
        zoomInBtn.addEventListener('click', handleZoomIn);
        zoomOutBtn.addEventListener('click', handleZoomOut);
        zoomResetBtn.addEventListener('click', handleZoomReset);
        imageElement.addEventListener('wheel', handleWheel);
        imageElement.addEventListener('mousedown', handleMouseDown);
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        document.addEventListener('mouseleave', handleMouseLeave);
        
        // 添加模态框关闭时的清理函数
        // 先移除可能存在的旧的清理函数
        const cleanupFuncName = 'cleanupImageZoomControls';
        
        // 移除旧的清理函数
        const oldCleanup = modal[cleanupFuncName];
        if (typeof oldCleanup === 'function') {
            oldCleanup();
        }
        
        // 保存新的清理函数到模态框元素上
        modal[cleanupFuncName] = function() {
            zoomInBtn.removeEventListener('click', handleZoomIn);
            zoomOutBtn.removeEventListener('click', handleZoomOut);
            zoomResetBtn.removeEventListener('click', handleZoomReset);
            imageElement.removeEventListener('wheel', handleWheel);
            imageElement.removeEventListener('mousedown', handleMouseDown);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.removeEventListener('mouseleave', handleMouseLeave);
        };
    }
}

// 获取状态文本
function getStatusText(status) {
    const statusMap = {
        'active': '在用',
        'idle': '闲置',
        'damaged': '损坏',
        'maintenance': '维修中',
        'retired': '报废'
    };
    return statusMap[status] || status;
}

// 获取状态图标
function getStatusIcon(status) {
    const iconMap = {
        'active': 'fa-check-circle',
        'idle': 'fa-pause-circle',
        'damaged': 'fa-exclamation-circle',
        'maintenance': 'fa-wrench',
        'retired': 'fa-ban'
    };
    return iconMap[status] || 'fa-question-circle';
}

// 渲染维护记录 - 使用防抖和requestAnimationFrame优化
let renderMaintenanceTimeout;
function renderMaintenanceRecords(records) {
    // 防抖处理
    if (renderMaintenanceTimeout) clearTimeout(renderMaintenanceTimeout);
    
    renderMaintenanceTimeout = setTimeout(() => {
        const table = getElement('maintenance-records-table');
        const tableBody = table ? table.querySelector('tbody') : null;
        
        if (!tableBody) return;
        
        requestAnimationFrame(() => {
            tableBody.innerHTML = '';
            
            if (!records || records.length === 0) {
                // 使用动态colspan值
                const colspan = 5; // 固定为5列，但如果将来列数变化可以改为动态计算
                const emptyRow = document.createElement('tr');
                emptyRow.innerHTML = `<td colspan="${colspan}" style="text-align: center; padding: 20px;">暂无维护记录</td>`;
                tableBody.appendChild(emptyRow);
                return;
            }
            
            // 创建HTML字符串一次性更新DOM，减少DOM操作
            let rowsHTML = '';
            records.forEach((record, index) => {
                rowsHTML += `
                    <tr>
                        <td>${formatDate(record.date)}</td>
                        <td>${record.type}</td>
                        <td>${record.description}</td>
                        <td>${record.manager}</td>
                        <td>
                            <button class="btn btn-sm btn-secondary delete-maintenance" data-index="${index}">
                                <i class="fas fa-trash"></i> 删除
                            </button>
                        </td>
                    </tr>
                `;
            });
            
            tableBody.innerHTML = rowsHTML;
        });
    }, 50);
}

// 处理文件上传 - 优化图片处理和用户体验
let uploadTimeout;
