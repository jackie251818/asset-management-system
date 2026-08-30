/**
 * 主题系统:浅色(light) / 深色(dark) / 纯黑(black) / 科技(tech) 四皮肤循环
 * - localStorage 持久化(key: asset_system_theme),刷新不丢
 * - index.html <head> 中的早期脚本负责首屏恢复(防闪烁),本模块负责切换与按钮状态
 * 依赖:页面中存在 #theme-toggle(侧边栏)与 #mobile-theme-btn(移动端顶栏)按钮(可选)
 */
(function () {
    'use strict';

    var THEME_ORDER = ['light', 'dark', 'black', 'tech'];
    // 按钮上显示的是「点击后将切换到」的目标皮肤
    var THEME_META = {
        light: { label: '浅色', icon: 'icon-sun' },
        dark: { label: '深色', icon: 'icon-moon' },
        black: { label: '纯黑', icon: 'icon-contrast' },
        tech: { label: '科技', icon: 'icon-cpu' }
    };
    var STORAGE_KEY = 'asset_system_theme';

    function getStoredTheme() {
        try {
            var t = localStorage.getItem(STORAGE_KEY);
            return THEME_ORDER.indexOf(t) !== -1 ? t : 'light';
        } catch (e) { return 'light'; }
    }

    function currentTheme() {
        var t = document.documentElement.getAttribute('data-theme');
        return THEME_ORDER.indexOf(t) !== -1 ? t : 'light';
    }

    // 渲染按钮:图标 = 下一个主题的图标,文案 = 下一个主题名
    function renderButtons(theme) {
        var next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
        var meta = THEME_META[next];
        if (!meta) return;
        var btn = document.getElementById('theme-toggle');
        if (btn) {
            var slot = btn.querySelector('.theme-icon-slot');
            if (slot) {
                slot.innerHTML = '<svg aria-hidden="true"><use xlink:href="#' + meta.icon + '"></use></svg>';
            }
            var label = btn.querySelector('.theme-label');
            if (label) label.textContent = meta.label;
            btn.title = '当前:' + (THEME_META[theme] || {}).label + ',点击切换到' + meta.label;
        }
        var mobileBtn = document.getElementById('mobile-theme-btn');
        if (mobileBtn) {
            mobileBtn.innerHTML = '<svg aria-hidden="true"><use xlink:href="#' + meta.icon + '"></use></svg>';
            mobileBtn.title = '切换到' + meta.label;
        }
    }

    function applyTheme(theme) {
        if (THEME_ORDER.indexOf(theme) === -1) theme = 'light';
        if (theme === 'light') {
            document.documentElement.removeAttribute('data-theme');
        } else {
            document.documentElement.setAttribute('data-theme', theme);
        }
        try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) { /* 隐私模式下静默失败 */ }
        renderButtons(theme);
    }

    function toggleTheme() {
        var idx = THEME_ORDER.indexOf(currentTheme());
        applyTheme(THEME_ORDER[(idx + 1) % THEME_ORDER.length]);
    }

    // 初始化:恢复持久化主题 + 绑定按钮
    function init() {
        applyTheme(getStoredTheme());
        var btn = document.getElementById('theme-toggle');
        if (btn) btn.addEventListener('click', toggleTheme);
        var mobileBtn = document.getElementById('mobile-theme-btn');
        if (mobileBtn) mobileBtn.addEventListener('click', toggleTheme);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // 暴露到全局,供设置页或其他模块调用
    window.ThemeManager = {
        apply: applyTheme,
        toggle: toggleTheme,
        current: currentTheme,
        order: THEME_ORDER
    };
})();