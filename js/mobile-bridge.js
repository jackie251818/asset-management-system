/**
 * 移动端桥接模块 — 仅在 Capacitor 原生环境生效
 * 职责: 环境检测 → 显示移动按钮/隐藏桌面功能 → 扫码查资产 → 拍照登记
 * 依赖: assetsData / ApiClient / viewAssetDetails (由 assets.js / api.js 提供)
 * 零侵入: 不改现有业务 JS，仅条件启用
 */
(function() {
    'use strict';

    var BarcodeScanner = null;
    var Camera = null;

    function isCapacitor() {
        return !!(window.Capacitor && window.Capacitor.isNative);
    }

    function getPlugin(name) {
        try {
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) {
                return window.Capacitor.Plugins[name];
            }
            if (window.Capacitor && window.Capacitor.registerPlugin) {
                return window.Capacitor.registerPlugin(name);
            }
        } catch (e) { console.warn('[MobileBridge] 插件加载失败:', name, e); }
        return null;
    }

    // ============ 扫码查资产 ============

    async function scanAsset() {
        if (!BarcodeScanner) {
            alert('扫码插件未加载');
            return;
        }

        // 检查相机权限
        try {
            var status = await BarcodeScanner.checkPermission({ force: true });
            if (!status.granted) {
                alert('需要相机权限才能扫码');
                return;
            }
        } catch (e) {
            console.warn('[MobileBridge] 权限检查失败:', e);
        }

        // 开始扫码
        var result = null;
        try {
            // 使背景透明，让原生相机预览透出
            document.body.style.opacity = '0';
            result = await BarcodeScanner.startScan();
            document.body.style.opacity = '1';
        } catch (e) {
            document.body.style.opacity = '1';
            console.error('[MobileBridge] 扫码失败:', e);
            return;
        }

        if (!result || !result.content) {
            document.body.style.opacity = '1';
            return; // 用户取消
        }

        var content = result.content;
        console.log('[MobileBridge] 扫码结果:', content);

        // 解析"编码："行提取资产 ID
        var match = content.match(/编码[：:]\s*(.+)/);
        var assetId = match ? match[1].trim() : null;

        if (!assetId) {
            // 二维码没有标准格式，显示原始内容
            if (typeof showNotification === 'function') {
                showNotification('二维码内容: ' + content.substring(0, 50), 'info');
            } else {
                alert('扫码结果:\n' + content);
            }
            return;
        }

        await jumpToAsset(assetId);
    }

    // 跳转到资产详情（内存命中 → 服务端兜底）
    async function jumpToAsset(id) {
        // 1. 内存命中
        if (typeof assetsData !== 'undefined' && assetsData) {
            var found = assetsData.find(function(a) { return a.id === id; });
            if (found) {
                if (typeof viewAssetDetails === 'function') {
                    viewAssetDetails(id);
                    return;
                }
            }
        }

        // 2. 服务端兜底
        if (typeof ApiClient !== 'undefined' && ApiClient.csMode) {
            try {
                if (typeof showNotification === 'function') {
                    showNotification('正在查询资产 ' + id + ' ...', 'info');
                }
                var asset = await ApiClient.getAsset(id);
                if (asset) {
                    // 补入内存集合
                    if (typeof assetsData !== 'undefined' && Array.isArray(assetsData)) {
                        assetsData.unshift(asset);
                    }
                    if (typeof viewAssetDetails === 'function') {
                        viewAssetDetails(id);
                        return;
                    }
                }
            } catch (e) {
                console.error('[MobileBridge] 服务端查询失败:', e);
            }
        }

        // 3. 未找到
        if (typeof showNotification === 'function') {
            showNotification('未找到资产: ' + id, 'error');
        } else {
            alert('未找到资产: ' + id);
        }
    }

    // ============ 拍照登记 ============

    async function capturePhoto() {
        if (!Camera) {
            alert('相机插件未加载');
            return;
        }

        var photo = null;
        try {
            photo = await Camera.getPhoto({
                quality: 80,
                allowEditing: false,
                resultType: 'Base64', // Capacitor v6: string 'Base64'
                source: 'CAMERA',
                correctOrientation: true,
                saveToGallery: false
            });
        } catch (e) {
            console.warn('[MobileBridge] 拍照取消或失败:', e);
            return;
        }

        if (!photo || !photo.base64String) return;

        // 构造 base64 data URL
        var mime = 'image/jpeg';
        if (photo.format) {
            mime = photo.format === 'png' ? 'image/png' : 'image/jpeg';
        }
        var dataUrl = 'data:' + mime + ';base64,' + photo.base64String;

        // 转 Blob → File → 喂现有 #file-upload input
        try {
            var blob = await (await fetch(dataUrl)).blob();
            var filename = 'IMG_' + Date.now() + '.' + (photo.format || 'jpg');
            var file = new File([blob], filename, { type: mime });

            var input = document.getElementById('file-upload');
            if (!input) {
                alert('未找到文件上传区域');
                return;
            }

            // 用 DataTransfer 写入 input.files
            var dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
            console.error('[MobileBridge] 拍照数据处理失败:', e);
            alert('照片处理失败: ' + e.message);
        }
    }

    // ============ 循环扫码盘点(不跳详情，扫到回调，自动继续下一轮) ============

    async function scanForInventory(onScanCallback) {
        if (!BarcodeScanner) {
            alert('扫码插件未加载');
            return;
        }
        try {
            var status = await BarcodeScanner.checkPermission({ force: true });
            if (!status.granted) {
                alert('需要相机权限');
                return;
            }
        } catch (e) { /* 忽略权限检查失败 */ }

        window._invScanActive = true;
        while (window._invScanActive) {
            var result = null;
            try {
                document.body.style.opacity = '0';
                result = await BarcodeScanner.startScan();
                document.body.style.opacity = '1';
            } catch (e) {
                document.body.style.opacity = '1';
                break;
            }
            if (!result || !result.content) continue;

            var match = result.content.match(/编码[：:]\s*(.+)/);
            var assetId = match ? match[1].trim() : null;
            if (assetId && typeof onScanCallback === 'function') {
                onScanCallback(assetId, result.content);
            }
        }
    }

    function stopInventoryScan() {
        window._invScanActive = false;
    }

    // ============ 初始化 ============

    function init() {
        if (!isCapacitor()) {
            return; // 非原生环境，全不干预
        }

        console.log('[MobileBridge] Capacitor 原生环境检测到，启用移动功能');

        // 加载插件
        BarcodeScanner = getPlugin('BarcodeScanner');
        Camera = getPlugin('Camera');

        // 标记 body
        document.body.classList.add('capacitor');

        // 绑定扫码按钮
        var scanBtn = document.getElementById('mobile-scan-btn');
        if (scanBtn) {
            scanBtn.style.display = '';
            scanBtn.addEventListener('click', function(e) {
                e.preventDefault();
                scanAsset();
            });
        }

        // 绑定拍照按钮
        var cameraBtn = document.getElementById('mobile-camera-btn');
        if (cameraBtn) {
            cameraBtn.style.display = '';
            cameraBtn.addEventListener('click', function(e) {
                e.preventDefault();
                capturePhoto();
            });
        }

        // 隐藏桌面专属功能
        var desktopOnly = document.querySelectorAll('.desktop-only');
        desktopOnly.forEach(function(el) {
            el.style.display = 'none';
        });
    }

    // 暴露到全局供调试
    window.MobileBridge = {
        isCapacitor: isCapacitor,
        scanAsset: scanAsset,
        capturePhoto: capturePhoto,
        jumpToAsset: jumpToAsset,
        scanForInventory: scanForInventory,
        stopInventoryScan: stopInventoryScan
    };

    // DOM ready 后初始化（defer 脚本在 DOMContentLoaded 后执行，此时 DOM 已就绪）
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
