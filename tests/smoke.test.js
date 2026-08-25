/**
 * 最小冒烟单测（5 条），零依赖，可直接用 node 执行：
 *   node tests/smoke.test.js
 *
 * 覆盖：
 *   1. Token 鉴权：Header / Query / Body 三种方式均能通过；错误 token 被拒绝
 *   2. 原子写入：writeFileAtomic 写入 / 读取一致，目标文件存在且内容匹配
 *   3. HTML 转义：assets.js 的 __escapeHtml 逻辑（通过 eval 源码提取并执行）
 *   4. 状态徽章缓存：__ASSET_STATUS_BADGE_CACHE 覆盖 5 种标准状态
 *   5. import-export 的版本兼容：storageManager.checkVersionCompatibility 行为（对缺失版本兼容、允许 2.x、拒绝 1.x / 3.x）
 *
 * 说明：为避免启动真实 Node HTTP / Electron，只加载单文件中的纯函数部分进行断言。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
const errors = [];

function assert(cond, msg) {
    if (cond) { passed++; }
    else { failed++; errors.push(new Error('FAIL: ' + msg)); console.error('✗', msg); }
}
function eq(a, b, msg) {
    const ok = JSON.stringify(a) === JSON.stringify(b);
    assert(ok, msg + ' (expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a) + ')');
}

function loadCode(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ================================
// 1) Token 鉴权（从 main.js 中抽取 verifyToken）
// ================================
(function testTokenAuth() {
    const mainCode = loadCode('main.js');
    const m = mainCode.match(/function verifyToken\(req, bodyTextMaybe\) \{[\s\S]{0,800}?\n\}/);
    if (!m) { assert(false, 'main.js 中未找到 verifyToken 函数'); return; }

    const TOKEN = 'unit-test-secret-token';
    // 把 HTTP_API_TOKEN 注入到 verifyToken 所在的作用域
    const wrapped = 'return function(ctx) {\n' +
        '  const HTTP_API_TOKEN = ctx.HTTP_API_TOKEN;\n' +
        '  const URL = (typeof globalThis !== "undefined" ? globalThis.URL : null) || require("url").URL;\n' +
        '  ' + m[0] + '\n' +
        '  return verifyToken;\n' +
        '};\n';
    const makeVerify = new Function(wrapped)();
    const verify = makeVerify({ HTTP_API_TOKEN: TOKEN });

    // 1a) 正确的 X-Server-Token header
    eq(verify({ headers: { 'x-server-token': TOKEN }, url: '/' }, null), true, '1a: X-Server-Token header 允许');

    // 1b) 正确的 query token
    eq(verify({ headers: {}, url: '/api/save?token=' + encodeURIComponent(TOKEN) }, null), true, '1b: query ?token= 允许');

    // 1c) body 中 __token 匹配
    eq(verify({ headers: {}, url: '/api/save' }, JSON.stringify({ __token: TOKEN, x: 1 })), true, '1c: JSON body __token 允许');

    // 1d) 错误 token 拒绝
    eq(verify({ headers: { 'x-server-token': 'WRONG' }, url: '/' }, null), false, '1d: 错误 header token 拒绝');
    eq(verify({ headers: {}, url: '/api/save?token=NOPE' }, null), false, '1e: 错误 query token 拒绝');
})();

// ================================
// 2) 原子写入 writeFileAtomic（从 main.js 提取）
// ================================
(function testAtomicWrite() {
    const mainCode = loadCode('main.js');
    // writeFileAtomic 函数比较长（含 rename 兜底逻辑），放宽匹配窗口
    const m = mainCode.match(/function writeFileAtomic\([^)]*\)\s*\{[\s\S]{1,4000}?\n\}\n/);
    if (!m) { assert(false, 'main.js 中未找到 writeFileAtomic 函数'); return; }

    // 直接把依赖通过形参传进去（new Function 作用域里没有全局 require）
    const factorySrc =
        'return function(fs, path, process, console, Buffer){\n' +
        '  ' + m[0] + '\n' +
        '  return writeFileAtomic;\n' +
        '};\n';
    let writeFileAtomic;
    try {
        const factory = new Function(factorySrc)();
        writeFileAtomic = factory(fs, path, process, console, Buffer);
    }
    catch (e) { assert(false, '2a: writeFileAtomic 装载失败: ' + e.message); return; }

    const tmpDir = fs.mkdtempSync(path.join((os.tmpdir && os.tmpdir()) || __dirname, 'smoke-atomic-'));
    const target = path.join(tmpDir, 'asset.json');
    const payload = JSON.stringify({ data: [{ id: 'A001', owner: '测试' }], ts: Date.now() }, null, 2);

    try {
        const ret = writeFileAtomic(target, payload);
        // 同步函数：应立即写入磁盘
        const eq1 = (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === payload);
        eq(eq1, true, '2a: 原子写入内容可读且一致（返回值=' + (typeof ret) + '）');
        // 任何 *.tmp.* 残留都不应存在
        let tmpLeft = 0;
        try {
            for (const f of fs.readdirSync(tmpDir)) if (/\.tmp(\.|$)/.test(f)) tmpLeft++;
        } catch (_) {}
        eq(tmpLeft, 0, '2b: 临时文件 .tmp 已被清理');
    } catch (e) {
        assert(false, '2c: writeFileAtomic 抛出异常: ' + e.message);
    } finally {
        // 清场（同步删除测试目录）
        try {
            for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
            fs.rmdirSync(tmpDir);
        } catch (_) {}
    }
})();

// ================================
// 3) HTML 转义（assets.js 中 __escapeHtml）
// ================================
(function testEscapeHtml() {
    const code = loadCode('js/assets.js');
    const m = code.match(/function __escapeHtml\(v\) \{[\s\S]{0,600}?\n\}/);
    if (!m) { assert(false, 'js/assets.js 中未找到 __escapeHtml'); return; }
    const fn = new Function(m[0] + '\n; return __escapeHtml;')();

    eq(fn(null), '', '3a: null → 空串');
    eq(fn(undefined), '', '3b: undefined → 空串');
    eq(fn('hello'), 'hello', '3c: 纯文本不变');
    eq(fn('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;', '3d: < > 被转义');
    eq(fn('a&b'), 'a&amp;b', '3e: & 被转义');
    eq(fn('"quoted"'), '&quot;quoted&quot;', '3f: 双引号被转义');
    eq(fn("it's"), 'it&#39;s', '3g: 单引号被转义');
})();

// ================================
// 4) 状态徽章缓存（5 种标准状态齐全）
// ================================
(function testStatusBadgeCache() {
    const code = loadCode('js/assets.js');
    // 从 IIFE 之后的结果，提取 cache：直接 eval 源码片段即可
    const block = code.match(/(?:const|let|var)\s+__ASSET_STATUS_BADGE_CACHE\s*=[\s\S]{0,1200}?\}\)\(\);/);
    if (!block) { assert(false, 'js/assets.js 中未找到 __ASSET_STATUS_BADGE_CACHE 初始化'); return; }
    const sandbox = {};
    try {
        new Function('sandbox', block[0] + '\n; sandbox.cache = __ASSET_STATUS_BADGE_CACHE;')(sandbox);
    } catch (e) { assert(false, '4a: 装载状态徽章失败: ' + e.message); return; }
    const c = sandbox.cache || {};
    const expected = ['active', 'idle', 'damaged', 'maintenance', 'retired'];
    for (const k of expected) {
        assert(typeof c[k] === 'string' && c[k].indexOf('status-badge') >= 0,
            '4: 状态 ' + k + ' 应有缓存好的 badge HTML（含 status-badge 类名）');
    }
    const missing = expected.filter(k => !(typeof c[k] === 'string'));
    eq(missing.length, 0, '4b: 5 种标准状态均已缓存，缺失：' + JSON.stringify(missing));
})();

// ================================
// 5) 版本兼容校验（storage.js 中 FileStorageManager.checkVersionCompatibility）
// ================================
(function testVersionCompatibility() {
    const code = loadCode('js/storage.js');
    // 提取方法体：从方法名到下一个 4 空格缩进的 }（方法结束）
    const m = code.match(/checkVersionCompatibility\s*\(importVersion\)\s*\{[\s\S]{0,2000}?\n\s{4}\}/);
    if (!m) { assert(false, 'js/storage.js 中未找到 checkVersionCompatibility'); return; }
    const implSrc = m[0];

    // 模拟 Logger 和方法返回
    const sandboxSrc =
        'const Logger = { info: function(){}, warn: function(){}, error: function(){} };\n' +
        'return function makeManager(dataVersion){\n' +
        '  const manager = { dataVersion: dataVersion || "2.4.4" };\n' +
        '  manager.checkVersionCompatibility = function ' + implSrc.replace(/^\s*checkVersionCompatibility\s*/m, '') + ';\n' +
        '  return manager;\n' +
        '};\n';
    let makeManager;
    try { makeManager = new Function(sandboxSrc)(); }
    catch (e) { assert(false, '5a: 装载 checkVersionCompatibility 失败: ' + e.message); return; }
    const manager = makeManager('2.4.4');
    const ok = (x) => x === true;

    const r1 = manager.checkVersionCompatibility(undefined);
    eq(ok(r1), true, '5a: undefined 版本 → 兼容旧数据（无 version 字段）');

    const r2 = manager.checkVersionCompatibility('2.4.4');
    eq(ok(r2), true, '5b: 2.4.4 → 2.x 主版本，允许导入');

    const r3 = manager.checkVersionCompatibility('2.999.999-beta');
    eq(ok(r3), true, '5c: 2.999.x → 仍属 2.x 主版本，允许');

    const r4 = manager.checkVersionCompatibility('1.0.0');
    eq(ok(r4), false, '5d: 1.0.0 → 旧主版本，被拒绝');

    const r5 = manager.checkVersionCompatibility('3.0.0');
    eq(ok(r5), false, '5e: 3.0.0 → 未来主版本，被拒绝');

    const r6 = manager.checkVersionCompatibility('not-a-semver');
    // 不合法版本号 → 由实现决定；但至少不能抛异常
    assert(typeof r6 === 'boolean', '5f: 非法版本号也返回 boolean（不抛异常）');
})();

// ================================
// 报告
// ================================
setTimeout(() => {
    console.log('\n========== 冒烟测试结果 ==========');
    console.log('通过: %d', passed);
    console.log('失败: %d', failed);
    if (errors.length > 0) {
        console.log('\n失败详情:');
        for (const e of errors) console.log(' -', e.message);
    }
    console.log('==================================\n');
    process.exit(failed > 0 ? 1 : 0);
}, 60);
