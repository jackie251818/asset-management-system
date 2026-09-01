/**
 * 资产编辑模式（表单创建、附件编辑、保存、删除）
 * 从 script.js 拆分而来 - 请勿手动修改行号映射
 */
function enterEditMode() {
    try {
        const assetIdElement = getElement('asset-id');
        if (!assetIdElement) {
            console.error('enterEditMode: 找不到资产ID元素');
            showNotification('错误：无法获取资产ID', 'error');
            return;
        }
        
        const assetId = assetIdElement.textContent;
        if (!assetId || assetId === '未选择资产') {
            console.error('enterEditMode: 资产ID无效或未选择资产');
            showNotification('请先选择一个有效的资产', 'warning');
            return;
        }
        
        // 查找当前资产
        const asset = assetsData.find(a => a.id === assetId);
        if (!asset) {
            console.error('enterEditMode: 找不到对应的资产数据');
            showNotification('错误：找不到该资产的数据', 'error');
            return;
        }
        
        // 切换到编辑模式
        toggleEditMode(asset);
    } catch (error) {
        console.error('enterEditMode: 发生错误:', error);
        showNotification('进入编辑模式时发生错误', 'error');
    }
}

// 切换编辑模式
function toggleEditMode(asset) {
    const activePage = getActivePage();
    const assetDetails = activePage ? activePage.querySelector('.asset-details') : document.querySelector('.asset-details');
    const attachmentsContainer = getElement('attachments-container');
    const maintenanceTable = document.getElementById('maintenance-records-table');
    const maintenanceHeader = maintenanceTable ? maintenanceTable.previousElementSibling : null;
    const editAssetBtn = getElement('edit-asset-btn');
    const deleteAssetBtn = getElement('delete-asset-btn');

    // 添加防御性检查
    if (!asset) {
        console.error('toggleEditMode: 资产对象不存在');
        showNotification('错误：无法获取资产信息', 'error');
        return;
    }
    
    if (!assetDetails || !editAssetBtn || !deleteAssetBtn) {
        console.error('toggleEditMode: 找不到必要的DOM元素');
        showNotification('错误：无法找到必要的界面元素', 'error');
        return;
    }
    
    // 检查是否已处于编辑模式（限定在活动页面内）
    const isEditMode = activePage ? activePage.querySelector('.edit-form') !== null : false;
    if (isEditMode) {
        // 保存编辑并退出编辑模式
        saveEditedAsset();
    } else {
        // 进入编辑模式
        editAssetBtn.textContent = '保存';
        deleteAssetBtn.textContent = '取消';
        
        // 隐藏详情视图、附件容器、维护记录表，只显示编辑表单
        // 避免详情页残留下半部分造成"两个页面同时显示"的视觉混乱
        assetDetails.style.display = 'none';
        
        if (attachmentsContainer) {
            attachmentsContainer.style.display = 'none';
        }
        
        if (maintenanceTable) {
            maintenanceTable.style.display = 'none';
        }
        if (maintenanceHeader) {
            maintenanceHeader.style.display = 'none';
        }
        
        // 创建编辑表单
        createEditForm(asset);
        
        // 添加编辑模式标记
        const body = document.body;
        body.dataset.editMode = 'true';
    }
}

// 取消编辑模式
function cancelEditMode() {
    try {
        const activePage = getActivePage();
        
        // 移除活动页面内的编辑表单
        const editForm = activePage ? activePage.querySelector('.edit-form') : document.querySelector('.edit-form');
        if (editForm) {
            editForm.remove();
        } else {
            console.warn('cancelEditMode: 未找到编辑表单');
        }
        
        // 重置编辑模式状态
        document.body.removeAttribute('data-edit-mode');
        // 恢复按钮状态
        const editAssetBtn = getElement('edit-asset-btn');
        const deleteAssetBtn = getElement('delete-asset-btn');

        if (editAssetBtn) {
            editAssetBtn.textContent = '编辑';
            editAssetBtn.classList.remove('btn-save');
            editAssetBtn.classList.add('btn-primary');
        }
        
        if (deleteAssetBtn) {
            deleteAssetBtn.textContent = '删除';
            deleteAssetBtn.style.display = 'inline-block';
        }
        
        // 显示详情视图、附件容器、维护记录表（限定在活动页面内）
        const assetDetails = activePage ? activePage.querySelector('.asset-details') : document.querySelector('.asset-details');
        const attachmentsContainer = getElement('attachments-container');
        const attachmentContainer = document.getElementById('attachment-container'); // 兼容不同ID
        const maintenanceTable = document.getElementById('maintenance-records-table');
        const maintenanceHeader = maintenanceTable ? maintenanceTable.previousElementSibling : null;

        if (assetDetails) {
            assetDetails.style.display = 'flex';
        }
        
        if (attachmentsContainer) {
            attachmentsContainer.style.display = 'block';
        } else if (attachmentContainer) {
            // 如果找不到attachments-container，尝试使用attachment-container
            attachmentContainer.style.display = 'block';
        } else {
            console.warn('cancelEditMode: 未找到附件容器元素');
        }
        
        if (maintenanceTable) {
            maintenanceTable.style.display = '';
        }
        if (maintenanceHeader) {
            maintenanceHeader.style.display = '';
        }
    } catch (error) {
        console.error('cancelEditMode: 发生错误:', error);
        showNotification('取消编辑模式时发生错误', 'error');
    }
}

// 创建编辑表单
function createEditForm(asset) {
    // 优先在当前激活的页面内查找 .card，避免选到其他不可见页面的 card
    const activePage = document.querySelector('.page-content.active');
    const card = activePage ? activePage.querySelector('.card') : document.querySelector('.card');
    const assetDetails = activePage ? activePage.querySelector('.asset-details') : document.querySelector('.asset-details');

    if (!card || !assetDetails) {
        console.error('找不到卡片或资产详情元素');
        return;
    }
    
    // 移除活动页面内可能存在的旧表单
    const oldForm = activePage ? activePage.querySelector('.edit-form') : document.querySelector('.edit-form');
    if (oldForm) {
        oldForm.remove();
    }
    
    // 创建表单容器
    const formContainer = document.createElement('div');
    formContainer.className = 'edit-form';
    formContainer.style.display = 'block';
    formContainer.style.width = '100%';
    formContainer.style.minHeight = '300px';
    formContainer.style.padding = '20px';
    formContainer.style.margin = '20px 0';

    // 复制添加资产表单的结构，但填充现有数据
    formContainer.innerHTML = `
        <div class="form-row">
            <div class="form-group">
                <label for="edit-asset-code">资产编号 <span class="required">*</span></label>
                <input type="text" id="edit-asset-code" value="${asset.id || ''}" disabled>
            </div>
            
            <div class="form-group">
                <label for="edit-asset-owner">主体 <span class="required">*</span></label>
                <div id="edit-asset-owner-container" class="form-custom-select-wrapper">
                    <!-- 由 CustomSelect 组件渲染 -->
                </div>
            </div>
        </div>
        
        <div class="form-row">
            <div class="form-group">
                <label for="edit-asset-type">设备类型 <span class="required">*</span></label>
                <div id="edit-asset-type-container" class="form-custom-select-wrapper">
                    <!-- 由 CustomSelect 组件渲染 -->
                </div>
            </div>
            
            <div class="form-group">
                <label for="edit-brand-model">品牌型号 <span class="required">*</span></label>
                <input type="text" id="edit-brand-model" value="${asset.brandModel || ''}" required>
            </div>
        </div>
        
        <div class="form-row">
            <div class="form-group">
                <label for="edit-configuration">配置信息</label>
                <textarea id="edit-configuration" rows="2">${asset.configuration || ''}</textarea>
            </div>
            
            <div class="form-group">
                <label for="edit-purchase-date">购入日期 <span class="required">*</span></label>
                <input type="date" id="edit-purchase-date" value="${asset.purchaseDate || ''}" required>
            </div>
        </div>
        
        <div class="form-row">
            <div class="form-group">
                <label for="edit-status">使用状态 <span class="required">*</span></label>
                <select id="edit-status" required>
                    <option value="active" ${asset.status === 'active' ? 'selected' : ''}>在用</option>
                    <option value="idle" ${asset.status === 'idle' ? 'selected' : ''}>闲置</option>
                    <option value="maintenance" ${asset.status === 'maintenance' ? 'selected' : ''}>维修中</option>
                    <option value="damaged" ${asset.status === 'damaged' ? 'selected' : ''}>损坏</option>
                    <option value="retired" ${asset.status === 'retired' ? 'selected' : ''}>报废</option>
                </select>
            </div>
            
            <div class="form-group">
                <label for="edit-user">使用人</label>
                <input type="text" id="edit-user" value="${asset.user || ''}">
            </div>
        </div>
        
        <div class="form-row">
            <div class="form-group">
                <label for="edit-department">部门 <span class="required">*</span></label>
                <div id="edit-department-container" class="form-custom-select-wrapper">
                    <!-- 由 CustomSelect 组件渲染 -->
                </div>
            </div>
            
            <div class="form-group">
                <label for="edit-location">位置</label>
                <input type="text" id="edit-location" value="${asset.location || ''}">
            </div>
        </div>
        
        <div class="form-row">
            <div class="form-group">
                <label for="edit-manager">负责人</label>
                <input type="text" id="edit-manager" value="${asset.manager || ''}">
            </div>
            
            <div class="form-group" id="edit-damage-reason-group" style="display: ${asset.status === 'damaged' ? 'block' : 'none'}">
                <label for="edit-damage-reason">损坏原因</label>
                <textarea id="edit-damage-reason" rows="2">${asset.damageReason || ''}</textarea>
            </div>
        </div>
        
        <div class="form-row">
            <div class="form-group">
                <label for="edit-unit">单位</label>
                <input type="text" id="edit-unit" value="${asset.unit || '台'}">
            </div>
            
            <div class="form-group">
                <label for="edit-quantity">数量</label>
                <input type="number" id="edit-quantity" min="1" value="${asset.quantity || 1}">
            </div>
            
            <div class="form-group">
                <label for="edit-value">价值（元）</label>
                <input type="number" id="edit-value" step="0.01" min="0" value="${asset.value || 0}">
            </div>
        </div>
        
        <div class="form-row">
            <div class="form-group">
                <label for="edit-depreciation-years">折旧年限</label>
                <input type="number" id="edit-depreciation-years" min="0" value="${asset.depreciationYears || 0}">
            </div>
            
            <div class="form-group">
                <label for="edit-purchase-no">采购编号</label>
                <input type="text" id="edit-purchase-no" value="${asset.purchaseNo || ''}">
            </div>
            
            <div class="form-group">
                <label for="edit-payment-no">付款编号</label>
                <input type="text" id="edit-payment-no" value="${asset.paymentNo || ''}">
            </div>
        </div>
        
        <!-- 编辑模式下的附件上传 -->
        <div class="card-header" style="margin-top: 20px;">
            <h2 class="card-title">
                <i class="fas fa-paperclip"></i>
                附件
            </h2>
        </div>
        
        <div class="file-upload-container">
            <label class="file-upload-label">
                <i class="fas fa-cloud-upload-alt"></i> 添加附件
                <input type="file" id="edit-file-upload" multiple accept="image/*,.pdf">
            </label>
            <div id="edit-file-previews" class="file-previews"></div>
        </div>
    `;
    
    // 插入表单 - 使用更安全的方式
    // 检查assetDetails是否是card的子元素
    if (card && assetDetails && card.contains(assetDetails)) {
        try {
            card.insertBefore(formContainer, assetDetails);
        } catch (error) {
            console.error('insertBefore失败，使用appendChild:', error);
            card.appendChild(formContainer);
        }
    } else if (card) {
        card.appendChild(formContainer);
    } else {
        // 如果找不到卡片，直接添加到body
        document.body.appendChild(formContainer);
    }

    // 添加状态变更事件
    const editStatus = getElement('edit-status');
    if (editStatus) {
        editStatus.addEventListener('change', function() {
            const damageReasonGroup = getElement('edit-damage-reason-group');
            if (damageReasonGroup) {
                damageReasonGroup.style.display = this.value === 'damaged' ? 'block' : 'none';
            }
        });
    }

    // 初始化编辑表单的 CustomSelect 实例
    initEditFormCustomSelects(asset);
    
    // 添加文件上传事件
    const editFileUpload = getElement('edit-file-upload');
    if (editFileUpload) {
        editFileUpload.addEventListener('change', function(e) {
            handleEditFileUpload(e);
        });
    }
    
    // 显示现有附件
    renderEditModeAttachments(asset);
}

// 渲染编辑模式下的附件
function renderEditModeAttachments(asset) {
    const container = document.getElementById('edit-file-previews');
    if (!container) return;
    if (!asset.attachments || asset.attachments.length === 0) return;
    
    // 遍历现有附件
    asset.attachments.forEach((attachment, index) => {
        const preview = document.createElement('div');
        preview.className = 'file-preview';
        preview.dataset.index = index;
        
        if (attachment.type.startsWith('image/')) {
            preview.innerHTML = `
                <img src="${attachment.thumbnail || attachment.url}" class="preview-image" style="width:50px;height:50px;object-fit:contain;border-radius:4px;flex-shrink:0;cursor:pointer;" alt="${attachment.name}">
                <div class="file-name">${attachment.name}</div>
                <div class="remove-file" data-index="${index}">&times;</div>
            `;
            const imgElement = preview.querySelector('.preview-image');
            if (imgElement) {
                imgElement.addEventListener('click', function() {
                    openFileViewer(attachment);
                });
            }
        } else if (attachment.type === 'application/pdf') {
            if (attachment.thumbnail) {
                preview.innerHTML = `
                    <img src="${attachment.thumbnail}" class="preview-image" style="width:50px;height:50px;object-fit:contain;border:1px solid #e0e0e0;border-radius:4px;background:#fff;flex-shrink:0;cursor:pointer;" alt="${attachment.name}">
                    <div class="file-name">${attachment.name}</div>
                    <div class="remove-file" data-index="${index}">&times;</div>
                `;
                const imgElement = preview.querySelector('.preview-image');
                if (imgElement) {
                    imgElement.addEventListener('click', function() {
                        openFileViewer(attachment);
                    });
                }
            } else {
                preview.innerHTML = `
                    <i class="fas fa-file-pdf" style="color: #ff4d4f; font-size: 50px;"></i>
                    <div class="file-name">${attachment.name}</div>
                    <div class="remove-file" data-index="${index}">&times;</div>
                `;
                // 异步生成缩略图
                if (attachment.url && typeof createPdfThumbnail === 'function') {
                    createPdfThumbnail(attachment.url, 160, 200, (thumb) => {
                        if (thumb) {
                            attachment.thumbnail = thumb;
                            preview.innerHTML = `
                                <img src="${thumb}" class="preview-image" style="max-width: 80px; max-height: 80px; object-fit: contain; border: 1px solid #e0e0e0; border-radius: 4px; background: #fff; cursor: pointer;" alt="${attachment.name}">
                                <div class="file-name">${attachment.name}</div>
                                <div class="remove-file" data-index="${index}">&times;</div>
                            `;
                            const imgEl = preview.querySelector('.preview-image');
                            if (imgEl) {
                                imgEl.addEventListener('click', function() {
                                    openFileViewer(attachment);
                                });
                            }
                        }
                    }, attachment.name);
                }
            }
        } else {
            preview.innerHTML = `
                <i class="fas fa-file" style="color: #3081eb; font-size: 50px;"></i>
                <div class="file-name">${attachment.name}</div>
                <div class="remove-file" data-index="${index}">&times;</div>
            `;
        }
        
        container.appendChild(preview);
    });
}

// 处理编辑模式下的文件上传
function handleEditFileUpload(e) {
    const files = e.target.files;
    const previewContainer = document.getElementById('edit-file-previews');
    if (!previewContainer) return;

    // 限制最多上传5个文件
    const existingFiles = previewContainer.querySelectorAll('.file-preview');
    if (existingFiles.length + files.length > 5) {
        alert('最多只能上传5个文件');
        e.target.value = '';
        return;
    }
    
    // 处理每个文件
    Array.from(files).forEach((file, index) => {
        // 检查文件类型
        if (!file.type.startsWith('image/') && file.type !== 'application/pdf') {
            alert(`文件 "${file.name}" 类型不支持，只支持图片和PDF文件`);
            e.target.value = '';
            return;
        }
        
        // 检查文件大小
        const maxSize = file.type.startsWith('image/') ? 10 * 1024 * 1024 : 20 * 1024 * 1024;
        if (file.size > maxSize) {
            alert(`文件 "${file.name}" 太大，${file.type.startsWith('image/') ? '图片' : 'PDF'}最大支持${file.type.startsWith('image/') ? '10MB' : '20MB'}`);
            e.target.value = '';
            return;
        }
        
        const preview = document.createElement('div');
        preview.className = 'file-preview new-file';
        preview.dataset.filename = file.name;
        preview.dataset.filetype = file.type;
        
        // 添加初始加载状态
        preview.innerHTML = `
            <div class="file-loading">
                <i class="fas fa-spinner fa-spin"></i>
            </div>
            <div class="file-name">${file.name}</div>
        `;
        
        previewContainer.appendChild(preview);
        
        // 对于PDF，生成首页缩略图
        if (file.type === 'application/pdf') {
            const pdfReader = new FileReader();
            pdfReader.onload = function(event) {
                createPdfThumbnail(event.target.result, 160, 200, (thumbnailUrl) => {
                    if (thumbnailUrl) {
                        preview.innerHTML = `
                            <img src="${thumbnailUrl}" style="width:50px;height:50px;object-fit:contain;border:1px solid #e0e0e0;border-radius:4px;background:#fff;flex-shrink:0;" alt="${file.name}">
                            <div class="file-name">${file.name}</div>
                            <div class="remove-file">&times;</div>
                        `;
                        // 点击缩略图查看PDF
                        const imgEl = preview.querySelector('img');
                        if (imgEl) {
                            imgEl.style.cursor = 'pointer';
                            imgEl.addEventListener('click', function() {
                                openFileViewer({
                                    name: file.name,
                                    type: file.type,
                                    url: event.target.result
                                });
                            });
                        }
                    } else {
                        preview.innerHTML = `
                            <i class="fas fa-file-pdf" style="color: #ff4d4f; font-size: 50px;"></i>
                            <div class="file-name">${file.name}</div>
                            <div class="remove-file">&times;</div>
                        `;
                    }
                }, file.name);
            };
            pdfReader.readAsDataURL(file);
        } else if (file.type.startsWith('image/')) {
            // 对于图片，读取并创建缩略图
            const reader = new FileReader();
            reader.onload = function(event) {
                // 创建缩略图
                createImageThumbnail(event.target.result, 100, 100, (thumbnailDataUrl) => {
                    preview.innerHTML = `
                        <img src="${thumbnailDataUrl}" class="preview-image new-image-preview" style="max-width: 80px; max-height: 80px; object-fit: cover; cursor: pointer;" alt="${file.name}">
                        <div class="file-name">${file.name}</div>
                        <div class="remove-file">&times;</div>
                    `;
                    
                    // 为新上传的图片添加查看功能
                    const imgElement = preview.querySelector('.preview-image');
                    if (imgElement) {
                        imgElement.addEventListener('click', function() {
                            openFileViewer({
                                name: file.name,
                                type: file.type,
                                url: event.target.result,
                                thumbnail: thumbnailDataUrl
                            });
                        });
                    }
                });
            };
            
            reader.readAsDataURL(file);
        }
    });
}

// 保存编辑后的资产
function saveEditedAsset() {
    const assetIdEl = getElement('asset-id');
    const assetId = assetIdEl ? assetIdEl.textContent : '';
    Logger.info('AssetEdit', '保存编辑资产:', assetId);

    const index = assetsData.findIndex(a => a.id === assetId);
    if (index === -1) {
        Logger.error('AssetEdit', 'saveEditedAsset: 资产不存在:', assetId);
        return;
    }

    const currentAsset = assetsData[index];

    
    const ownerInput = getElement('edit-asset-owner');
    const typeInput = getElement('edit-asset-type');
    const brandModelInput = getElement('edit-brand-model');
    const configurationInput = getElement('edit-configuration');
    const purchaseDateInput = getElement('edit-purchase-date');
    const statusInput = getElement('edit-status');
    const userInput = getElement('edit-user');
    const departmentInput = getElement('edit-department');
    const locationInput = getElement('edit-location');
    const managerInput = getElement('edit-manager');
    const damageReasonInput = getElement('edit-damage-reason');

    
    if (!ownerInput || !typeInput || !brandModelInput || !purchaseDateInput || !statusInput || !departmentInput) {
        Logger.error('AssetEdit', '缺少必要的表单元素');
        alert('表单加载失败，请刷新页面重试');
        return;
    }

    
    // 收集表单数据
    const updatedAsset = {
        ...currentAsset,
        owner: ownerInput.value,
        type: typeInput.value,
        brandModel: brandModelInput.value,
        configuration: configurationInput ? configurationInput.value : '',
        purchaseDate: purchaseDateInput.value,
        status: statusInput.value,
        user: userInput ? userInput.value : '',
        department: departmentInput.value,
        location: locationInput ? locationInput.value : '',
        manager: managerInput ? managerInput.value : '',
        unit: getElement('edit-unit')?.value || '台',
        quantity: parseInt(getElement('edit-quantity')?.value) || 1,
        value: parseFloat(getElement('edit-value')?.value) || 0,
        depreciationYears: parseInt(getElement('edit-depreciation-years')?.value) || 0,
        purchaseNo: getElement('edit-purchase-no')?.value || '',
        paymentNo: getElement('edit-payment-no')?.value || '',
        damageReason: statusInput.value === 'damaged' && damageReasonInput ? damageReasonInput.value : ''
    };

    // 保存新上传的文件（直接从编辑表单的预览容器获取）
    const previewContainer = document.getElementById('edit-file-previews');
    const newFilePreviews = previewContainer ? previewContainer.querySelectorAll('.file-preview.new-file') : [];

    // 统一的 UI 清理逻辑：恢复按钮、移除编辑表单、显示详情视图、附件、维护记录表
    // 放在保存流程完成后再执行，避免异步保存尚未结束时表单已被移除
    const cleanupEditUI = () => {
        const editAssetBtn = getElement('edit-asset-btn');
        const deleteAssetBtn = getElement('delete-asset-btn');
        if (editAssetBtn) editAssetBtn.textContent = '编辑';
        if (deleteAssetBtn) deleteAssetBtn.textContent = '删除';

        const currentPage = getActivePage();
        const editForm = currentPage ? currentPage.querySelector('.edit-form') : document.querySelector('.edit-form');
        if (editForm) editForm.remove();

        const assetDetails = currentPage ? currentPage.querySelector('.asset-details') : document.querySelector('.asset-details');
        const attachmentsContainer = getElement('attachments-container');
        const maintenanceTable = document.getElementById('maintenance-records-table');
        const maintenanceHeader = maintenanceTable ? maintenanceTable.previousElementSibling : null;
        if (assetDetails) assetDetails.style.display = 'flex';
        if (attachmentsContainer) attachmentsContainer.style.display = 'block';
        if (maintenanceTable) maintenanceTable.style.display = '';
        if (maintenanceHeader) maintenanceHeader.style.display = '';
    };

    // 统一的保存逻辑：合并附件、更新数据、持久化、刷新视图，完成后清理 UI
    const finalizeSave = async (newFiles) => {
        // 从 DOM 读取未被删除的已有附件（用户可能手动删除了部分）
        const previewContainer = document.getElementById('edit-file-previews');
        const remainingPreviews = previewContainer
            ? previewContainer.querySelectorAll('.file-preview:not(.new-file)')
            : [];
        const remainingAttachments = Array.from(remainingPreviews)
            .map(preview => {
                const idx = parseInt(preview.dataset.index);
                return !isNaN(idx) && currentAsset.attachments ? currentAsset.attachments[idx] : null;
            })
            .filter(a => a !== null && a !== undefined);

        updatedAsset.attachments = [...remainingAttachments, ...newFiles];

        // ============ C/S 多人模式: REST 乐观锁更新 ============
        if (typeof ApiClient !== 'undefined' && ApiClient.csMode) {
            try {
                // updatedAsset 继承自 currentAsset, 携带 version 字段 → 服务端乐观锁校验
                const doc = await ApiClient.updateAsset(assetId, updatedAsset);
                assetsData[index] = doc;
                ApiClient.markLocalChange();
                Logger.info('AssetEdit', '编辑保存完成(服务端):', assetId, '| 新版本:', doc.version);
                saveToLocalStorage();   // C/S 模式下仅刷新本地缓存
                viewAssetDetails(assetId);
                cleanupEditUI();
                alert('资产信息已更新');
            } catch (err) {
                Logger.error('AssetEdit', '服务端更新失败:', err);
                if (err && err.code === 40901) {
                    alert('保存冲突：数据已被其他用户修改，您的修改未保存。\n请从列表重新打开该资产(获取最新数据)后再编辑。');
                } else if (err && err.code === 40300) {
                    alert('保存失败：当前账号没有编辑资产的权限');
                } else {
                    alert('保存失败：' + ((err && err.message) || '未知错误'));
                }
                cleanupEditUI();
            }
            return;
        }

        // ============ 本地模式 / Electron 旧服务模式: 原有逻辑 ============
        assetsData[index] = updatedAsset;
        Logger.info('AssetEdit', '编辑保存完成:', assetId, '| 附件总数:', updatedAsset.attachments.length);
        hasUnsavedChanges = true;
        saveToLocalStorage();
        viewAssetDetails(assetId);
        cleanupEditUI();
        alert('资产信息已更新');
    };

    if (newFilePreviews.length === 0) {
        // 没有新文件，直接保存（仍需处理已删除的已有附件）
        Logger.debug('AssetEdit', '无新文件，直接保存');
        finalizeSave([]);
    } else {
        Logger.debug('AssetEdit', '处理新文件，数量:', newFilePreviews.length);
        const fileInput = getElement('edit-file-upload');
        const fileMap = new Map();
        if (fileInput && fileInput.files && fileInput.files.length > 0) {
            Array.from(fileInput.files).forEach(file => {
                fileMap.set(`${file.name}|${file.type}`, file);
            });
        }

        // 为每个预览创建一个读取 Promise，匹配失败或读取失败均 resolve(null) 跳过，避免卡死
        const filePromises = Array.from(newFilePreviews).map(preview => {
            const filename = preview.dataset.filename;
            const filetype = preview.dataset.filetype;
            const file = fileMap.get(`${filename}|${filetype}`);

            if (!file) {
                console.warn('未找到匹配的文件，跳过:', filename);
                return Promise.resolve(null);
            }

            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = function(event) {
                    const fileData = {
                        name: file.name,
                        type: file.type,
                        size: file.size,
                        url: event.target.result
                    };
                    // 如果是图片，使用预览中已生成的缩略图
                    if (file.type.startsWith('image/')) {
                        const imgElement = preview.querySelector('img');
                        if (imgElement) {
                            fileData.thumbnail = imgElement.src;
                        }
                    } else if (file.type === 'application/pdf') {
                        createPdfThumbnail(event.target.result, 160, 200, (thumbnailUrl) => {
                            if (thumbnailUrl) {
                                fileData.thumbnail = thumbnailUrl;
                            }
                            resolve(fileData);
                        }, file.name);
                        return;
                    }
                    resolve(fileData);
                };
                reader.onerror = function() {
                    console.error('文件读取失败，跳过:', file.name);
                    resolve(null);
                };
                reader.readAsDataURL(file);
            });
        });

        // 等待所有文件处理完成（无论成功或跳过），过滤掉 null 后统一保存
        Promise.all(filePromises).then(results => {
            const validFiles = results.filter(f => f !== null);
            finalizeSave(validFiles);
        }).catch(error => {
            console.error('保存文件时出错:', error);
            alert('保存失败：' + error.message);
            // 即使保存失败也清理 UI，让用户能继续操作
            cleanupEditUI();
        });
    }
}

// 确认删除资产
function confirmDeleteAsset() {
    const assetIdEl = getElement('asset-id');
    const assetId = assetIdEl ? assetIdEl.textContent : '';
    if (!assetId || assetId === '未选择资产') return;

    if (confirm('确定要删除资产 ' + assetId + ' 吗？此操作不可恢复！')) {
        // ============ C/S 多人模式: REST 删除(级联维保记录/附件) ============
        if (typeof ApiClient !== 'undefined' && ApiClient.csMode) {
            Logger.info('AssetEdit', '删除资产(服务端):', assetId, '| 删除前总数:', assetsData.length);
            ApiClient.deleteAsset(assetId).then(() => {
                assetsData = assetsData.filter(asset => asset.id !== assetId);
                ApiClient.markLocalChange();
                Logger.info('AssetEdit', '删除完成，剩余:', assetsData.length);
                saveToLocalStorage();   // C/S 模式下仅刷新本地缓存
                updateStatistics();
                renderRecentAssets();
                renderDamagedAssets();
                renderAllAssets();
                switchPage('assets');
                alert('资产已删除');
            }).catch(err => {
                Logger.error('AssetEdit', '服务端删除失败:', err);
                if (err && err.code === 40300) {
                    alert('删除失败：当前账号没有删除资产的权限');
                } else if (err && err.code === 40400) {
                    alert('删除失败：该资产已被其他用户删除');
                    // 同步本地缓存并刷新列表
                    assetsData = assetsData.filter(asset => asset.id !== assetId);
                    saveToLocalStorage();
                    updateStatistics();
                    renderRecentAssets();
                    renderDamagedAssets();
                    renderAllAssets();
                    switchPage('assets');
                } else {
                    alert('删除失败：' + ((err && err.message) || '未知错误'));
                }
            });
            return;
        }

        // ============ 本地模式 / Electron 旧服务模式: 原有逻辑 ============
        Logger.info('AssetEdit', '删除资产:', assetId, '| 删除前总数:', assetsData.length);
        assetsData = assetsData.filter(asset => asset.id !== assetId);
        Logger.info('AssetEdit', '删除完成，剩余:', assetsData.length);
        // 更新UI
        updateStatistics();
        renderRecentAssets();
        renderDamagedAssets();
        renderAllAssets();

        // 保存到本地存储
        saveToLocalStorage();

        // 回到资产列表
        switchPage('assets');
        alert('资产已删除');
    }
}

// 渲染所有统计报表图表

// 编辑表单的 CustomSelect 实例
let editFormCustomSelects = {};

function initEditFormCustomSelects(asset) {
    const ownerContainer = document.getElementById('edit-asset-owner-container');
    const typeContainer = document.getElementById('edit-asset-type-container');
    const departmentContainer = document.getElementById('edit-department-container');

    if (!ownerContainer || !typeContainer || !departmentContainer) {
        console.warn('编辑表单容器不存在，跳过 CustomSelect 初始化');
        return;
    }

    // 销毁旧的实例（如果存在）
    editFormCustomSelects = {};

    // 主体
    editFormCustomSelects.owner = new CustomSelect(ownerContainer, {
        id: 'edit-asset-owner',
        label: '主体',
        storageKey: 'custom_options_owner',
        presetOptions: CUSTOM_SELECT_PRESETS.owner,
        includeAll: false,
        allValue: '',
        allLabel: '请选择主体',
        hideLabel: true
    });

    // 设备类型
    editFormCustomSelects.type = new CustomSelect(typeContainer, {
        id: 'edit-asset-type',
        label: '设备类型',
        storageKey: 'custom_options_type',
        presetOptions: CUSTOM_SELECT_PRESETS.type,
        includeAll: false,
        allValue: '',
        allLabel: '请选择设备类型',
        hideLabel: true
    });

    // 部门
    editFormCustomSelects.department = new CustomSelect(departmentContainer, {
        id: 'edit-department',
        label: '部门',
        storageKey: 'custom_options_department',
        presetOptions: CUSTOM_SELECT_PRESETS.department,
        includeAll: false,
        allValue: '',
        allLabel: '请选择部门',
        hideLabel: true
    });

    // 设置当前值（静默模式，不触发 onChange）
    if (asset.owner) editFormCustomSelects.owner.setValue(asset.owner, true);
    if (asset.type) editFormCustomSelects.type.setValue(asset.type, true);
    if (asset.department) editFormCustomSelects.department.setValue(asset.department, true);
}
