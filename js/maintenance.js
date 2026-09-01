/**
 * 维护记录管理（添加、删除）
 * 从 script.js 拆分而来 - 请勿手动修改行号映射
 */

function showAddMaintenanceDialog() {
    const assetIdEl = getElement('asset-id');
    const assetId = assetIdEl ? assetIdEl.textContent : '';
    if (!assetId || assetId === '未选择资产') return;

    const asset = assetsData.find(a => a.id === assetId);
    if (!asset) return;

    const type = prompt('请输入维护类型:', '常规维护');
    if (!type) return;

    const description = prompt('请输入维护描述:');
    if (!description) return;

    const manager = prompt('请输入负责人:');
    if (!manager) return;

    const newRecord = {
        date: new Date().toISOString().split('T')[0],
        type: type,
        description: description,
        manager: manager
    };

    // ============ C/S 多人模式: 整文档乐观锁更新 ============
    if (typeof ApiClient !== 'undefined' && ApiClient.csMode) {
        if (!asset.maintenanceRecords) asset.maintenanceRecords = [];
        asset.maintenanceRecords.push(newRecord);   // 先本地暂存, 供乐观锁更新携带完整维保数组
        ApiClient.updateAsset(assetId, asset).then(doc => {
            const idx = assetsData.findIndex(a => a.id === assetId);
            if (idx !== -1) assetsData[idx] = doc;
            ApiClient.markLocalChange();
            renderMaintenanceRecords(doc.maintenanceRecords);
            saveToLocalStorage();   // C/S 模式下仅刷新本地缓存
            alert('维护记录已添加');
        }).catch(err => {
            // 服务端失败 → 回滚本地暂存
            asset.maintenanceRecords.pop();
            renderMaintenanceRecords(asset.maintenanceRecords);
            if (err && err.code === 40901) {
                alert('保存冲突：数据已被其他用户修改，请从列表重新打开该资产后再添加。');
            } else if (err && err.code === 40300) {
                alert('保存失败：当前账号没有维护记录写入权限');
            } else {
                alert('维护记录保存失败：' + ((err && err.message) || '未知错误'));
            }
        });
        return;
    }

    // ============ 本地模式 / Electron 旧服务模式: 原有逻辑 ============
    // 添加维护记录
    if (!asset.maintenanceRecords) asset.maintenanceRecords = [];
    asset.maintenanceRecords.push(newRecord);

    // 更新UI
    renderMaintenanceRecords(asset.maintenanceRecords);

    // 保存到本地存储
    saveToLocalStorage();

    alert('维护记录已添加');
}

// 删除维护记录
function deleteMaintenanceRecord(index) {
    const assetIdEl = getElement('asset-id');
    const assetId = assetIdEl ? assetIdEl.textContent : '';
    if (!assetId || assetId === '未选择资产') return;

    const asset = assetsData.find(a => a.id === assetId);
    if (!asset || !asset.maintenanceRecords || !asset.maintenanceRecords[index]) return;

    if (confirm('确定要删除这条维护记录吗？')) {
        // ============ C/S 多人模式: 整文档乐观锁更新 ============
        if (typeof ApiClient !== 'undefined' && ApiClient.csMode) {
            const removed = asset.maintenanceRecords.splice(index, 1);  // 先本地暂存
            ApiClient.updateAsset(assetId, asset).then(doc => {
                const idx = assetsData.findIndex(a => a.id === assetId);
                if (idx !== -1) assetsData[idx] = doc;
                ApiClient.markLocalChange();
                renderMaintenanceRecords(doc.maintenanceRecords);
                saveToLocalStorage();   // C/S 模式下仅刷新本地缓存
            }).catch(err => {
                // 服务端失败 → 回滚本地暂存
                asset.maintenanceRecords.splice(index, 0, removed[0]);
                renderMaintenanceRecords(asset.maintenanceRecords);
                if (err && err.code === 40901) {
                    alert('删除冲突：数据已被其他用户修改，请从列表重新打开该资产后再操作。');
                } else {
                    alert('维护记录删除失败：' + ((err && err.message) || '未知错误'));
                }
            });
            return;
        }

        // ============ 本地模式 / Electron 旧服务模式: 原有逻辑 ============
        asset.maintenanceRecords.splice(index, 1);
        renderMaintenanceRecords(asset.maintenanceRecords);

        // 保存到本地存储
        saveToLocalStorage();
    }
}

// 保存数据到本地存储 - 使用防抖减少存储操作
