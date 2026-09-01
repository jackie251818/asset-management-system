/**
 * 资产新增表单（文件上传、缩略图生成、保存）
 * 从 script.js 拆分而来 - 请勿手动修改行号映射
 */
function handleFileUpload(e) {
    // 防抖处理
    if (uploadTimeout) clearTimeout(uploadTimeout);
    
    uploadTimeout = setTimeout(() => {
        const files = e.target.files;
        const previewContainer = getElement('file-previews');
        
        // 创建提示元素（如果不存在）
        let notification = getElement('upload-notification');
        if (!notification) {
            notification = document.createElement('div');
            notification.id = 'upload-notification';
            notification.style.position = 'fixed';
            notification.style.top = '20px';
            notification.style.right = '20px';
            notification.style.padding = '12px 20px';
            notification.style.borderRadius = '4px';
            notification.style.color = 'white';
            notification.style.zIndex = '1000';
            notification.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
            notification.style.transition = 'opacity 0.3s';
            document.body.appendChild(notification);
        }
        
        // 显示通知函数
        const showNotification = (message, isError = false) => {
            notification.textContent = message;
            notification.style.backgroundColor = isError ? '#ff4d4f' : '#52c41a';
            notification.style.opacity = '1';
            
            setTimeout(() => {
                notification.style.opacity = '0';
            }, 3000);
        };
        
        // 重置预览容器
        previewContainer.innerHTML = '';
        
        // 限制最多上传5个文件
        if (files.length > 5) {
            showNotification('最多只能上传5个文件', true);
            e.target.value = ''; // 清空选择
            return;
        }
        
        // 创建一个数组保存验证通过的文件
        const validFiles = [];
        
        // 先验证所有文件
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            
            // 检查文件类型
            if (!file.type.startsWith('image/') && file.type !== 'application/pdf') {
                showNotification(`文件 "${file.name}" 类型不支持，只支持图片和PDF文件`, true);
                e.target.value = '';
                return;
            }
            
            // 检查文件大小，图片限制10MB，PDF限制20MB
            const maxSize = file.type.startsWith('image/') ? 10 * 1024 * 1024 : 20 * 1024 * 1024;
            if (file.size > maxSize) {
                showNotification(`文件 "${file.name}" 太大，${file.type.startsWith('image/') ? '图片' : 'PDF'}最大支持${file.type.startsWith('image/') ? '10MB' : '20MB'}`, true);
                e.target.value = '';
                return;
            }
            
            validFiles.push(file);
        }
        
        // 批量处理有效的文件预览
        const fragment = document.createDocumentFragment();
        
        // 统计处理中的文件数量，用于跟踪完成情况
        let processingCount = 0;
        
        validFiles.forEach((file, index) => {
            processingCount++;
            
            const preview = document.createElement('div');
            preview.className = 'file-preview';
            preview.dataset.index = index;
            
            // 添加初始加载状态
            preview.innerHTML = `
                <div class="file-loading">
                    <i class="fas fa-spinner fa-spin"></i>
                </div>
                <div class="file-name">${file.name}</div>
            `;
            
            fragment.appendChild(preview);
            
            // 如果是PDF，生成首页缩略图
            if (file.type === 'application/pdf') {
                const pdfReader = new FileReader();
                pdfReader.onload = function(event) {
                    createPdfThumbnail(event.target.result, 160, 200, (thumbnailUrl) => {
                        if (thumbnailUrl) {
                            preview.innerHTML = `
                                <img src="${thumbnailUrl}" style="width:50px;height:50px;object-fit:contain;border:1px solid #e0e0e0;border-radius:4px;background:#fff;flex-shrink:0;" alt="${file.name}">
                                <div class="file-name">${file.name}</div>
                                <div class="remove-file" data-index="${index}">&times;</div>
                            `;
                        } else {
                            preview.innerHTML = `
                                <i class="fas fa-file-pdf" style="color: #ff4d4f; font-size: 50px;"></i>
                                <div class="file-name">${file.name}</div>
                                <div class="remove-file" data-index="${index}">&times;</div>
                            `;
                        }
                        processingCount--;
                        if (processingCount === 0) {
                            showNotification('文件上传准备完成');
                        }
                    }, file.name);
                };
                pdfReader.readAsDataURL(file);
            } else if (file.type.startsWith('image/')) {
                // 对于图片，读取并创建缩略图
                const reader = new FileReader();
                reader.onload = function(event) {
                    // 使用Web Worker或requestAnimationFrame处理图片，避免阻塞主线程
                    requestAnimationFrame(() => {
                        createImageThumbnail(event.target.result, 100, 100, (thumbnailDataUrl) => {
                            requestAnimationFrame(() => {
                                preview.innerHTML = `
                                    <img src="${thumbnailDataUrl}" style="max-width: 80px; max-height: 80px; object-fit: cover;" alt="${file.name}">
                                    <div class="file-name">${file.name}</div>
                                    <div class="remove-file" data-index="${index}">&times;</div>
                                `;
                                
                                processingCount--;
                                if (processingCount === 0) {
                                    showNotification('文件上传准备完成');
                                }
                            });
                        });
                    });
                };
                
                reader.readAsDataURL(file);
            }
        });
        
        // 一次性添加所有预览元素到DOM
        previewContainer.appendChild(fragment);
    }, 100); // 100ms防抖延迟
}

// 创建图片缩略图以减小文件大小 - 优化版本
let thumbnailCanvas = null; // 缓存canvas，避免重复创建DOM元素

function createImageThumbnail(dataUrl, maxWidth, maxHeight, callback, progressCallback) {
    // 验证参数
    if (!dataUrl || typeof callback !== 'function') {
        if (callback) callback(null);
        return;
    }
    
    const img = new Image();
    
    // 图片加载错误处理
    img.onerror = function() {
        console.error('Failed to load image for thumbnail creation');
        if (callback) callback(null);
    };
    
    // 图片加载完成处理
    img.onload = function() {
        try {
            // 立即释放内存，因为我们不再需要原始图像对象
            const originalWidth = img.width;
            const originalHeight = img.height;
            
            // 计算缩放比例（优化算法，避免重复计算）
            let width = originalWidth;
            let height = originalHeight;
            
            if (width > maxWidth || height > maxHeight) {
                const widthRatio = maxWidth / width;
                const heightRatio = maxHeight / height;
                const ratio = Math.min(widthRatio, heightRatio);
                
                width = Math.round(width * ratio);
                height = Math.round(height * ratio);
            }
            
            // 使用缓存的canvas或创建新的
            if (!thumbnailCanvas) {
                thumbnailCanvas = document.createElement('canvas');
                thumbnailCanvas.style.display = 'none';
                document.body.appendChild(thumbnailCanvas);
            }
            
            // 设置canvas尺寸
            thumbnailCanvas.width = width;
            thumbnailCanvas.height = height;
            
            const ctx = thumbnailCanvas.getContext('2d');
            
            // 清空画布
            ctx.clearRect(0, 0, width, height);
            
            // 绘制缩略图，使用更优化的参数
            ctx.drawImage(img, 0, 0, originalWidth, originalHeight, 0, 0, width, height);
            
            // 获取缩略图的dataURL，对于小图片可以使用更高质量
            const quality = (width < 300 && height < 300) ? 0.9 : 0.8;
            const thumbnailDataUrl = thumbnailCanvas.toDataURL('image/jpeg', quality);
            
            // 通知进度（如有）
            if (typeof progressCallback === 'function') {
                progressCallback(100);
            }
            
            // 返回结果
            callback(thumbnailDataUrl);
        } catch (error) {
            console.error('Error creating thumbnail:', error);
            callback(null);
        }
    };
    
    // 设置图片源
    img.src = dataUrl;
    
    // 通知初始进度（如有）
    if (typeof progressCallback === 'function') {
        progressCallback(0);
    }
}

// PDF.js 是否已初始化
let pdfJsReady = false;
let pdfJsInitPromise = null;

function ensurePdfJs() {
    if (pdfJsReady && window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';
        return Promise.resolve(window.pdfjsLib);
    }
    if (pdfJsInitPromise) return pdfJsInitPromise;
    pdfJsInitPromise = new Promise((resolve, reject) => {
        if (window.pdfjsLib) {
            pdfJsReady = true;
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';
            resolve(window.pdfjsLib);
        } else {
            const script = document.createElement('script');
            script.src = 'libs/pdf.min.js';
            script.onload = () => {
                pdfJsReady = true;
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';
                resolve(window.pdfjsLib);
            };
            script.onerror = () => reject(new Error('PDF.js load failed'));
            document.head.appendChild(script);
        }
    });
    return pdfJsInitPromise;
}

// 创建PDF缩略图
async function createPdfThumbnail(dataUrl, maxWidth, maxHeight, callback, fileName) {
    if (!dataUrl || typeof callback !== 'function') {
        if (callback) callback(null);
        return;
    }
    // 兼容老调用方：第5个参数可能是 callback,fileName 顺序错位的情况
    if (typeof fileName !== 'string') fileName = '';
    try {
        const pdfjsLib = await ensurePdfJs();
        const loadingTask = pdfjsLib.getDocument({ data: atob(dataUrl.split(',')[1]) });
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1.0 });

        let scale = maxWidth / viewport.width;
        if (scale > 1) scale = 1;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = viewport.width * scale;
        canvas.height = viewport.height * scale;

        await page.render({
            canvasContext: ctx,
            viewport: page.getViewport({ scale: scale })
        }).promise;

        const thumbnailDataUrl = canvas.toDataURL('image/jpeg', 0.8);
        callback(thumbnailDataUrl);
    } catch (err) {
        const label = fileName ? `（${fileName}）` : '';
        console.error('PDF缩略图生成失败' + label + ':', err);
        // 区分错误类型给出更友好的提示
        const errMsg = (err && err.message) ? err.message : '未知错误';
        let tip;
        if (/password|encrypt/i.test(errMsg)) {
            tip = `PDF${label}为加密文件，无法生成缩略图，已使用文件图标占位。`;
        } else if (/load|fetch|network/i.test(errMsg)) {
            tip = `PDF.js 库加载失败，无法生成缩略图${label}。请检查 libs/pdf.min.js 与 libs/pdf.worker.min.js 是否存在。`;
        } else {
            tip = `PDF缩略图生成失败${label}：${errMsg}。已使用文件图标占位，不影响附件保存。`;
        }
        if (typeof showNotification === 'function') {
            showNotification(tip, 'warning', 5000);
        }
        callback(null);
    }
}

// 处理添加资产表单提交 - 优化版本
let saveAssetTimeout;

function handleAddAsset(e) {
    e.preventDefault();
    
    // 防抖处理
    if (saveAssetTimeout) clearTimeout(saveAssetTimeout);
    
    saveAssetTimeout = setTimeout(() => {
        // 显示加载状态（限定到活动页面，避免误选其他页面的提交按钮）
        const activePage = getActivePage();
        const saveButton = (e.target && e.target.querySelector('button[type="submit"]')) ||
            (activePage ? activePage.querySelector('button[type="submit"]') : document.querySelector('#add-asset-page button[type="submit"]'));
        const originalText = saveButton.textContent;
        saveButton.disabled = true;
        saveButton.textContent = '保存中...';
        
        // 获取上传的文件
        const fileInput = document.getElementById('file-upload');
        const files = fileInput.files;
        const attachments = [];
        const processingQueue = [];
        let filesProcessed = 0;
        
        // 检查文件数量
        if (files.length > 5) {
            showNotification('最多只能上传5个文件', true);
            saveButton.disabled = false;
            saveButton.textContent = originalText;
            return;
        }
        
        // 创建文件处理Promise
        const processFile = (file) => {
            return new Promise((resolve) => {
                const reader = new FileReader();
                
                reader.onerror = function() {
                    console.error('文件读取失败:', file.name);
                    resolve(null); // 即使失败也继续处理其他文件
                };
                
                reader.onload = function(event) {
                    const fileData = {
                        name: file.name,
                        type: file.type,
                        size: file.size,
                        url: event.target.result
                    };
                    
                    // 如果是图片，创建缩略图
                    if (file.type.startsWith('image/')) {
                        createImageThumbnail(event.target.result, 100, 100, (thumbnailDataUrl) => {
                            if (thumbnailDataUrl) {
                                fileData.thumbnail = thumbnailDataUrl;
                            }
                            resolve(fileData);
                        });
                    } else if (file.type === 'application/pdf') {
                        createPdfThumbnail(event.target.result, 160, 200, (thumbnailDataUrl) => {
                            if (thumbnailDataUrl) {
                                fileData.thumbnail = thumbnailDataUrl;
                            }
                            resolve(fileData);
                        }, file.name);
                    } else {
                        resolve(fileData);
                    }
                };
                
                // 异步读取文件
                setTimeout(() => {
                    reader.readAsDataURL(file);
                }, 0);
            });
        };
        
        // 添加所有文件到处理队列
        for (let i = 0; i < files.length; i++) {
            processingQueue.push(processFile(files[i]));
        }
        
        // 批量处理文件并在完成后保存资产
        if (processingQueue.length > 0) {
            Promise.all(processingQueue).then((results) => {
                // 过滤掉处理失败的文件
                const validAttachments = results.filter(item => item !== null);
                
                requestAnimationFrame(() => {
                    saveAsset(validAttachments);
                    
                    // 恢复按钮状态
                    saveButton.disabled = false;
                    saveButton.textContent = originalText;
                });
            }).catch((error) => {
                console.error('文件处理错误:', error);
                showNotification('文件处理失败，请重试', true);
                
                // 恢复按钮状态
                saveButton.disabled = false;
                saveButton.textContent = originalText;
            });
        } else {
            // 如果没有文件需要处理，直接保存资产
            requestAnimationFrame(() => {
                saveAsset(attachments);
                
                // 恢复按钮状态
                saveButton.disabled = false;
                saveButton.textContent = originalText;
            });
        }
    }, 100); // 100ms防抖延迟
}

// 保存资产信息
async function saveAsset(attachments) {
    // 获取表单数据
    const newAsset = {
        id: document.getElementById('asset-code').value.trim(),
        owner: document.getElementById('asset-owner').value,
        type: document.getElementById('asset-type').value,
        brandModel: document.getElementById('brand-model').value.trim(),
        configuration: document.getElementById('configuration').value.trim(),
        purchaseDate: document.getElementById('purchase-date').value,
        status: document.getElementById('status').value,
        user: document.getElementById('user').value.trim(),
        department: document.getElementById('department').value,
        location: document.getElementById('location').value.trim(),
        manager: document.getElementById('manager').value.trim(),
        unit: document.getElementById('asset-unit')?.value.trim() || '台',
        quantity: parseInt(document.getElementById('asset-quantity')?.value) || 1,
        value: parseFloat(document.getElementById('asset-value')?.value) || 0,
        depreciationYears: parseInt(document.getElementById('depreciation-years')?.value) || 0,
        purchaseNo: document.getElementById('purchase-no')?.value.trim() || '',
        paymentNo: document.getElementById('payment-no')?.value.trim() || '',
        damageReason: document.getElementById('status').value === 'damaged'
            ? document.getElementById('damage-reason').value.trim()
            : null,
        maintenanceRecords: [],
        attachments: attachments
    };


    if (!newAsset.id || !newAsset.owner || !newAsset.type || !newAsset.brandModel || !newAsset.purchaseDate || !newAsset.department) {
        const missing = [];
        if (!newAsset.id) missing.push('资产编号');
        if (!newAsset.owner) missing.push('主体');
        if (!newAsset.type) missing.push('设备类型');
        if (!newAsset.brandModel) missing.push('品牌型号');
        if (!newAsset.purchaseDate) missing.push('购入日期');
        if (!newAsset.department) missing.push('部门');
        alert('请填写必填字段：' + missing.join('、'));
        Logger.warn('AssetAdd', '表单验证失败：必填字段缺失', missing);
        return;
    }


    // ============ C/S 多人模式: REST 直连(服务端校验编号唯一, 返回带 version 的权威文档) ============
    if (typeof ApiClient !== 'undefined' && ApiClient.csMode) {
        if (assetsData.some(asset => asset.id === newAsset.id)) {
            Logger.warn('AssetAdd', '资产编号已存在(本地缓存比对):', newAsset.id);
            alert('资产编号已存在: ' + newAsset.id);
            return;
        }
        try {
            const doc = await ApiClient.createAsset(newAsset);
            assetsData.unshift(doc);
            ApiClient.markLocalChange();
            Logger.info('AssetAdd', '资产已通过服务端创建，当前总数:', assetsData.length);
            updateStatistics();
            renderRecentAssets();
            renderDamagedAssets();
            renderAllAssets();
            saveToLocalStorage();   // C/S 模式下仅刷新本地缓存

            document.getElementById('add-asset-form').reset();
            resetFormCustomSelects();
            document.getElementById('file-previews').innerHTML = '';
            document.getElementById('file-upload').value = '';
            document.getElementById('damage-reason-group').style.display = 'none';
            alert('资产添加成功！');
            switchPage('assets');
        } catch (err) {
            Logger.error('AssetAdd', '服务端创建资产失败:', err);
            const msg = (err && err.message) || '未知错误';
            if (err && err.code === 40900) {
                alert('添加失败：资产编号已存在(' + newAsset.id + ')，或与其他数据冲突');
            } else if (err && err.code === 40300) {
                alert('添加失败：当前账号没有新增资产的权限');
            } else {
                alert('资产添加失败：' + msg);
            }
        }
        return;
    }

    // ============ 本地模式 / Electron 旧服务模式: 原有全量保存逻辑 ============
    if (assetsData.some(asset => asset.id === newAsset.id)) {
        Logger.warn('AssetAdd', '资产编号已存在:', newAsset.id);
        return;
    }


    assetsData.unshift(newAsset);
    Logger.info('AssetAdd', '资产已添加，当前总数:', assetsData.length);

    updateStatistics();
    renderRecentAssets();
    renderDamagedAssets();
    renderAllAssets();

    hasUnsavedChanges = true;
    saveToLocalStorage();


    document.getElementById('add-asset-form').reset();
    resetFormCustomSelects();
    document.getElementById('file-previews').innerHTML = '';
    document.getElementById('file-upload').value = '';
    document.getElementById('damage-reason-group').style.display = 'none';
    alert('资产添加成功！');

    // 切换到资产列表页
    switchPage('assets');
}

// 资产表单的 CustomSelect 实例
let formCustomSelects = {};

function initFormCustomSelects() {
    const ownerContainer = document.getElementById('asset-owner-container');
    const typeContainer = document.getElementById('asset-type-container');
    const departmentContainer = document.getElementById('department-container');

    if (!ownerContainer || !typeContainer || !departmentContainer) {
        console.warn('资产表单容器不存在，跳过 CustomSelect 初始化');
        return;
    }

    // 主体（表单用，无"全部"选项，有占位提示，隐藏内部label避免重复）
    formCustomSelects.owner = new CustomSelect(ownerContainer, {
        id: 'asset-owner',
        label: '主体',
        storageKey: 'custom_options_owner',
        presetOptions: CUSTOM_SELECT_PRESETS.owner,
        includeAll: false,
        allValue: '',
        allLabel: '请选择主体',
        hideLabel: true
    });

    // 设备类型（表单用）
    formCustomSelects.type = new CustomSelect(typeContainer, {
        id: 'asset-type',
        label: '设备类型',
        storageKey: 'custom_options_type',
        presetOptions: CUSTOM_SELECT_PRESETS.type,
        includeAll: false,
        allValue: '',
        allLabel: '请选择设备类型',
        hideLabel: true
    });

    // 部门（表单用）
    formCustomSelects.department = new CustomSelect(departmentContainer, {
        id: 'department',
        label: '部门',
        storageKey: 'custom_options_department',
        presetOptions: CUSTOM_SELECT_PRESETS.department,
        includeAll: false,
        allValue: '',
        allLabel: '请选择部门',
        hideLabel: true
    });
}

// 重置资产表单的 CustomSelect
function resetFormCustomSelects() {
    Object.values(formCustomSelects).forEach(instance => {
        instance.setValue('', true);
    });
}

// 搜索资产
