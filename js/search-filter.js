/**
 * 资产搜索和筛选功能
 * 从 script.js 拆分而来 - 请勿手动修改行号映射
 */

function searchAssets(keyword) {
    if (!keyword) {
        renderAllAssets();
        return;
    }

    const lowerKeyword = keyword.toLowerCase();
    const filtered = assetsData.filter(asset => {
        const id = (asset.id || '').toLowerCase();
        const owner = (asset.owner || '').toLowerCase();
        const brandModel = (asset.brandModel || '').toLowerCase();
        const user = (asset.user || '').toLowerCase();
        const department = (asset.department || '').toLowerCase();
        const type = (asset.type || '').toLowerCase();
        const description = (asset.description || '').toLowerCase();
        const location = (asset.location || '').toLowerCase();

        return id.includes(lowerKeyword) ||
            owner.includes(lowerKeyword) ||
            brandModel.includes(lowerKeyword) ||
            user.includes(lowerKeyword) ||
            department.includes(lowerKeyword) ||
            type.includes(lowerKeyword) ||
            description.includes(lowerKeyword) ||
            location.includes(lowerKeyword);
    });

    renderAllAssets(filtered);
}

// 应用筛选条件
function applyFilters() {
    try {
        const statusFilterEl = document.getElementById('status-filter');
        if (!statusFilterEl) {
            console.warn('applyFilters: status-filter 元素不存在');
            renderAllAssets();
            return;
        }

        const statusFilter = statusFilterEl.value;
        const ownerFilter = document.getElementById('owner-filter')?.value || 'all';
        const typeFilter = document.getElementById('type-filter')?.value || 'all';
        const departmentFilter = document.getElementById('department-filter')?.value || 'all';

        // 确保始终使用原始的assetsData进行筛选，而不是可能被修改过的数据
        let filtered = [...assetsData];

        // 状态筛选
        if (statusFilter !== 'all') {
            filtered = filtered.filter(asset => asset.status === statusFilter);
        }

        // 主体筛选
        if (ownerFilter !== 'all') {
            filtered = filtered.filter(asset => asset.owner === ownerFilter);
        }

        // 设备类型筛选
        if (typeFilter !== 'all') {
            filtered = filtered.filter(asset => asset.type === typeFilter);
        }

        // 部门筛选
        if (departmentFilter !== 'all') {
            filtered = filtered.filter(asset => asset.department === departmentFilter);
        }

        // 时间筛选
        const dateFromEl = document.getElementById('date-from');
        const dateToEl = document.getElementById('date-to');
        const dateFrom = dateFromEl?.value;
        const dateTo = dateToEl?.value;

        if (dateFrom || dateTo) {
            filtered = filtered.filter(asset => {
                if (!asset.purchaseDate) return false;

                const assetDate = new Date(asset.purchaseDate);

                if (dateFrom && assetDate < new Date(dateFrom)) {
                    return false;
                }

                if (dateTo) {
                    const toDate = new Date(dateTo);
                    toDate.setHours(23, 59, 59, 999); // 设置为当天的最后一刻
                    if (assetDate > toDate) {
                        return false;
                    }
                }

                return true;
            });
        }

        // 自定义字段筛选
        const customField = document.getElementById('custom-field-select')?.value;
        const customValue = document.getElementById('custom-field-value')?.value?.trim();

        if (customField && customValue) {
            filtered = filtered.filter(asset => {
                const fieldValue = asset[customField];
                if (fieldValue === null || fieldValue === undefined) return false;
                // 数值型字段用数值比较，其他用字符串包含匹配
                if (typeof fieldValue === 'number') {
                    return String(fieldValue) === customValue || String(fieldValue).includes(customValue);
                }
                return String(fieldValue).toLowerCase().includes(customValue.toLowerCase());
            });
        }

        // 保存筛选后的数据用于统计
        window.filteredAssetsForStatistics = filtered;

        // 确保传递完整的过滤结果到renderAllAssets
        renderAllAssets(filtered);

        // 更新统计数据，使其基于筛选后的数据
        updateStatistics();
    } catch (e) {
        console.error('applyFilters 执行失败:', e);
        renderAllAssets();
    }
}

// 处理Excel导入 - 优化版本

/**
 * 自定义下拉选择组件
 * 支持添加/删除选项，持久化到存储系统
 */
class CustomSelect {
    constructor(container, config) {
        this.container = container;
        this.config = config;
        this.selectedValue = config.allValue || 'all';
        this.options = [];
        this.customOptions = [];
        this.isOpen = false;
        this.inputTimer = null;
        this._initialized = false;

        // 先渲染骨架，绑定事件
        this.render();
        this.bindEvents();
        
        // 异步加载选项
        this.loadOptionsAsync();
    }

    async loadOptionsAsync() {
        try {
            // 加载已删除的预设选项
            const deletedKey = this.config.storageKey + '_deleted';
            const deletedRaw = await storageManager.getItem(deletedKey);
            const deleted = Array.isArray(deletedRaw) ? deletedRaw : [];
            this._deletedPresets = deleted; // 保存到内存供同步方法使用

            // 加载预设选项（排除已删除的）
            const preset = (this.config.presetOptions || []).filter(o => !deleted.includes(o));
            
            // 加载自定义选项（从存储）
            const saved = await storageManager.getItem(this.config.storageKey);
            this.customOptions = Array.isArray(saved) ? saved : [];

            // 合并：预设 + 自定义，去重
            const seen = new Set();
            this.options = [];
            if (this.config.includeAll) {
                this.options.push({ value: this.config.allValue || 'all', label: this.config.allLabel || '全部', isPreset: true });
                seen.add(this.config.allValue || 'all');
            }
            for (const opt of preset) {
                if (!seen.has(opt)) {
                    this.options.push({ value: opt, label: opt, isPreset: true });
                    seen.add(opt);
                }
            }
            for (const opt of this.customOptions) {
                if (!seen.has(opt)) {
                    this.options.push({ value: opt, label: opt, isPreset: false });
                    seen.add(opt);
                }
            }
            
            // 重新渲染选项
            this.rebuildOptions();
            this._initialized = true;
        } catch(e) {
            console.error('加载选项失败:', e);
        }
    }

    // 同步版本，用于在内存中更新选项后立即重建UI
    loadOptionsSync() {
        // 使用当前内存中的 customOptions 和预设选项
        const deletedKey = this.config.storageKey + '_deleted';
        // 从已加载的选项中获取已删除的预设（如果有的话）
        const currentDeleted = this._deletedPresets || [];
        
        const preset = (this.config.presetOptions || []).filter(o => !currentDeleted.includes(o));
        
        const seen = new Set();
        this.options = [];
        if (this.config.includeAll) {
            this.options.push({ value: this.config.allValue || 'all', label: this.config.allLabel || '全部', isPreset: true });
            seen.add(this.config.allValue || 'all');
        }
        for (const opt of preset) {
            if (!seen.has(opt)) {
                this.options.push({ value: opt, label: opt, isPreset: true });
                seen.add(opt);
            }
        }
        for (const opt of this.customOptions) {
            if (!seen.has(opt)) {
                this.options.push({ value: opt, label: opt, isPreset: false });
                seen.add(opt);
            }
        }
    }

    saveCustomOptions() {
        storageManager.setItem(this.config.storageKey, this.customOptions).catch(e => {
            console.error('保存自定义选项失败:', e);
        });
    }

    render() {
        const showLabel = !this.config.hideLabel;
        this.container.innerHTML = `
            ${showLabel ? `<label class="filter-label">${this.config.label}</label>` : ''}
            <div class="custom-select" data-id="${this.config.id}">
                <div class="custom-select-display">
                    <span class="custom-select-value">${this.getSelectedLabel()}</span>
                    <i class="fas fa-chevron-down custom-select-arrow"></i>
                </div>
                <div class="custom-select-dropdown" style="display:none;">
                    <div class="custom-select-add">
                        <input type="text" class="custom-select-input" placeholder="输入新选项...">
                        <button class="custom-select-add-btn" title="添加">
                            <i class="fas fa-plus"></i>
                        </button>
                    </div>
                    <div class="custom-select-options"></div>
                </div>
            </div>
            <input type="hidden" id="${this.config.id}" value="${this.selectedValue}">
        `;
        this.rebuildOptions();
    }

    rebuildOptions() {
        const optionsEl = this.container.querySelector('.custom-select-options');
        optionsEl.innerHTML = '';
        for (const opt of this.options) {
            const item = document.createElement('div');
            item.className = 'custom-select-option' + (opt.value === this.selectedValue ? ' selected' : '');
            item.dataset.value = opt.value;
            item.innerHTML = `
                <span class="custom-select-option-label"></span>
                <button class="custom-select-delete" title="删除此选项">
                    <i class="fas fa-times"></i>
                </button>
            `;
            item.querySelector('.custom-select-option-label').textContent = opt.label;
            optionsEl.appendChild(item);
        }
    }

    getSelectedLabel() {
        const selected = this.options.find(o => o.value === this.selectedValue);
        return selected ? selected.label : (this.config.allLabel || '全部');
    }

    setValue(value, silent) {
        this.selectedValue = value;
        this.container.querySelector('.custom-select-value').textContent = this.getSelectedLabel();
        const hiddenInput = this.container.querySelector(`input[type="hidden"]`);
        hiddenInput.value = value;
        this.rebuildOptions();

        if (!silent) {
            // 触发 change 事件以兼容外部监听
            hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    bindEvents() {
        const select = this.container.querySelector('.custom-select');
        const display = select.querySelector('.custom-select-display');
        const dropdown = select.querySelector('.custom-select-dropdown');
        const optionsEl = select.querySelector('.custom-select-options');
        const input = select.querySelector('.custom-select-input');
        const addBtn = select.querySelector('.custom-select-add-btn');

        // 点击展开/收起
        display.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });

        // 点击外部关闭
        document.addEventListener('click', (e) => {
            if (!this.container.contains(e.target)) {
                this.close();
            }
        });

        // 选项点击（事件委托）
        optionsEl.addEventListener('click', (e) => {
            const deleteBtn = e.target.closest('.custom-select-delete');
            if (deleteBtn) {
                e.stopPropagation();
                this.handleDelete(deleteBtn.closest('.custom-select-option'));
                return;
            }
            const optionEl = e.target.closest('.custom-select-option');
            if (optionEl) {
                this.setValue(optionEl.dataset.value);
                this.close();
                this.onChange && this.onChange(this.selectedValue);
            }
        });

        // 添加新选项
        const addNewOption = () => {
            const val = input.value.trim();
            if (!val) return;
            // 检查是否已存在
            if (this.options.some(o => o.value === val)) {
                input.value = '';
                this.flashInput(input, '选项已存在');
                return;
            }
            this.customOptions.push(val);
            try {
                this.saveCustomOptions();
            } catch(e) {
                console.error('saveCustomOptions failed:', e);
            }
            this.loadOptionsSync();
            this.rebuildOptions();
            input.value = '';
        };

        // 添加按钮事件绑定
        const handleAddClick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            addNewOption();
        };
        addBtn.addEventListener('click', handleAddClick, true);
        // 在捕获阶段阻止mousedown冒泡，防止触发外部关闭
        addBtn.addEventListener('mousedown', (e) => { 
            e.preventDefault(); 
            e.stopPropagation();
        }, true);

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addNewOption();
            }
        });
    }

    handleDelete(optionEl) {
        const value = optionEl.dataset.value;
        const opt = this.options.find(o => o.value === value);
        if (!opt) return;

        // 不允许删除"全部"选项
        if (value === (this.config.allValue || 'all')) {
            this.flashInput(this.container.querySelector('.custom-select-input'), '默认选项不可删除');
            return;
        }

        // 确认删除
        if (!confirm(`确定删除选项"${opt.label}"吗？`)) return;

        // 从 customOptions 中移除
        this.customOptions = this.customOptions.filter(o => o !== value);
        // 如果是预设选项，标记为已删除
        if (opt.isPreset) {
            if (!this._deletedPresets) {
                this._deletedPresets = [];
            }
            if (!this._deletedPresets.includes(value)) {
                this._deletedPresets.push(value);
                // 异步保存到存储
                const deletedKey = this.config.storageKey + '_deleted';
                storageManager.setItem(deletedKey, this._deletedPresets).catch(e => {
                    console.error('保存已删除预设失败:', e);
                });
            }
        }
        this.saveCustomOptions();

        // 如果删除的是当前选中值，重置为"全部"
        if (this.selectedValue === value) {
            this.setValue(this.config.allValue || 'all', true);
            this.onChange && this.onChange(this.selectedValue);
        }

        this.loadOptionsSync();
        this.rebuildOptions();
    }

    toggle() {
        if (this.isOpen) this.close();
        else this.open();
    }

    open() {
        // 先重新加载（可能其他实例修改了）
        this.loadOptionsAsync();
        this.rebuildOptions();
        this.container.querySelector('.custom-select-dropdown').style.display = 'block';
        this.container.querySelector('.custom-select').classList.add('open');
        this.isOpen = true;
    }

    close() {
        this.container.querySelector('.custom-select-dropdown').style.display = 'none';
        this.container.querySelector('.custom-select').classList.remove('open');
        this.isOpen = false;
    }

    flashInput(inputEl, msg) {
        const original = inputEl.placeholder;
        inputEl.placeholder = msg;
        inputEl.style.borderColor = '#e74c3c';
        setTimeout(() => {
            inputEl.placeholder = original;
            inputEl.style.borderColor = '';
        }, 1500);
    }
}

// 预设选项数据
// owner/department 为部署环境特定数据, 不预置(由用户在界面添加, 持久化到服务端 custom_options 表);
// type 为通用设备类型, 保留预设
const CUSTOM_SELECT_PRESETS = {
    owner: [],
    type: [
        "整套台式电脑",
        "单个电脑主机",
        "单个电脑显示屏",
        "笔记本电脑",
        "打印机"
    ],
    department: []
};

// 初始化筛选区域的三个 CustomSelect 实例
let customSelectInstances = {};

function initFilterCustomSelects() {
    const ownerContainer = document.getElementById('owner-filter-container');
    const typeContainer = document.getElementById('type-filter-container');
    const departmentContainer = document.getElementById('department-filter-container');

    if (!ownerContainer || !typeContainer || !departmentContainer) {
        console.warn('筛选容器不存在，跳过 CustomSelect 初始化');
        return;
    }

    // 主体筛选
    customSelectInstances.owner = new CustomSelect(ownerContainer, {
        id: 'owner-filter',
        label: '主体',
        storageKey: 'custom_options_owner',
        presetOptions: CUSTOM_SELECT_PRESETS.owner,
        includeAll: true,
        allValue: 'all',
        allLabel: '全部主体'
    });

    // 设备类型筛选
    customSelectInstances.type = new CustomSelect(typeContainer, {
        id: 'type-filter',
        label: '设备类型',
        storageKey: 'custom_options_type',
        presetOptions: CUSTOM_SELECT_PRESETS.type,
        includeAll: true,
        allValue: 'all',
        allLabel: '全部类型'
    });

    // 部门筛选
    customSelectInstances.department = new CustomSelect(departmentContainer, {
        id: 'department-filter',
        label: '部门',
        storageKey: 'custom_options_department',
        presetOptions: CUSTOM_SELECT_PRESETS.department,
        includeAll: true,
        allValue: 'all',
        allLabel: '全部部门'
    });

    // 绑定 change 事件触发筛选
    Object.values(customSelectInstances).forEach(instance => {
        instance.onChange = function() {
            if (typeof applyFilters === 'function') {
                applyFilters();
            }
        };
    });
}

// 重置筛选区域的 CustomSelect
function resetFilterCustomSelects() {
    Object.values(customSelectInstances).forEach(instance => {
        instance.setValue(instance.config.allValue || 'all', true);
    });
}

// 恢复筛选值到 CustomSelect
function restoreFilterCustomSelects(filters) {
    if (!filters) return;

    if (filters.ownerFilter && customSelectInstances.owner) {
        customSelectInstances.owner.setValue(filters.ownerFilter, true);
    }
    if (filters.departmentFilter && customSelectInstances.department) {
        customSelectInstances.department.setValue(filters.departmentFilter, true);
    }
    if (filters.typeFilter && customSelectInstances.type) {
        customSelectInstances.type.setValue(filters.typeFilter, true);
    }
}
