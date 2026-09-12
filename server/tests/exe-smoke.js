/**
 * 完整冒烟测试: 外部前端优先 + 内嵌快照回退 + 飞书接口
 * 启动: node server/tests/exe-smoke.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const EXE = path.join(__dirname, '..', 'dist', 'asset-server.exe');
const PASS = [];
const FAIL = [];

function logPass(msg) { PASS.push(msg); console.log('  ✓ ' + msg); }
function logFail(msg, detail) { FAIL.push(msg); console.log('  ✗ ' + msg + (detail ? ' — ' + detail : '')); }

function httpGet(port, p, headers) {
    return new Promise((resolve) => {
        http.get({ hostname: '127.0.0.1', port, path: p, headers: headers || {}, timeout: 4000 }, (s) => {
            let b = '';
            s.on('data', (c) => (b += c));
            s.on('end', () => resolve({ status: s.statusCode, body: b }));
        }).on('error', (e) => resolve({ status: 0, body: e.message }));
    });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitReady(port, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const r = await httpGet(port, '/api/ping');
        if (r.status === 200) return true;
        await sleep(500);
    }
    return false;
}

async function runTest(name, dataDir, setupFn, checkFn, options = {}) {
    console.log(`\n🧪 测试: ${name}`);
    const port = 39000 + PASS.length + FAIL.length + 1;
    if (setupFn) setupFn();
    const spawnOpts = {
        env: { ...process.env, ASSET_PORT: String(port), ASSET_HOST: '127.0.0.1', ASSET_DATA_DIR: dataDir },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    };
    if (options.cwd) spawnOpts.cwd = options.cwd;
    const proc = spawn(EXE, [], spawnOpts);
    const outLogs = [];
    proc.stdout.on('data', (c) => outLogs.push(c.toString().trim()));
    proc.stderr.on('data', (c) => outLogs.push(c.toString().trim()));
    const ready = await waitReady(port);
    if (!ready) {
        logFail('服务端启动超时', outLogs.slice(-3).join(' | '));
        proc.kill('SIGTERM');
        await sleep(1000);
        return;
    }
    try {
        await checkFn(port);
    } catch (e) {
        logFail('检查异常', e.message);
    }
    proc.kill('SIGTERM');
    await sleep(1000);
    if (proc.exitCode === null) proc.kill('SIGKILL');
}

async function main() {
    console.log('========== asset-server.exe 静态资源 + 飞书接口 完整冒烟 ==========');

    // ===== 测试 1: EXE 同级有外部 index.html → 优先用外部 =====
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-test-ext-'));
    const EXE_DIR = path.dirname(EXE);
    const testMarker = '<!-- EXTERNAL-FRONTEND-MARKER-20260904 -->';
    const externalIndexPath = path.join(EXE_DIR, 'index.html');
    await runTest('EXE 同级有外部 index.html → 优先用外部', dir1, () => {
        fs.writeFileSync(externalIndexPath,
            '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' + testMarker + '</html>');
    }, async (port) => {
        const idx = await httpGet(port, '/index.html');
        if (idx.status === 200 && idx.body.includes(testMarker)) logPass('外部前端优先: 返回自定义标记');
        else logFail('外部前端未生效, 返回内嵌快照');
        // 其他静态资源自动回退内嵌(EXE 同级没 js/api.js)
        const api = await httpGet(port, '/js/api.js');
        if (api.status === 200) logPass('外部 index.html 但 js/api.js 回退内嵌快照');
        else logFail('js/api.js 回退失败', 'status=' + api.status);
    }, { cwd: EXE_DIR });
    try { fs.unlinkSync(externalIndexPath); } catch (e) { /* 忽略 */ }

    // ===== 测试 3: 无外部前端 → 回退内嵌快照 + 飞书接口 =====
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-test-fs-'));
    await runTest('内嵌快照回退 + 飞书接口检查', dir3, null, async (port) => {
        // 内嵌快照 feishu-sync-card
        const idx = await httpGet(port, '/index.html');
        if (idx.status === 200 && idx.body.includes('feishu-sync-card')) logPass('内嵌快照 feishu-sync-card 正常');
        else logFail('内嵌快照 feishu-sync-card 缺失');

        // 登录页 + 内嵌模式注入(不带 ASSET_EMBEDDED_TOKEN 就不注入)
        const login = await httpGet(port, '/login.html');
        if (login.status === 200) logPass('/login.html 可访问');
        else logFail('/login.html HTTP ' + login.status);

        // 飞书接口
        const cfg = await httpGet(port, '/api/feishu/config');
        if (cfg.status === 401) logPass('/api/feishu/config 需鉴权(正常, 未登录)');
        else if (cfg.status === 200) logPass('/api/feishu/config 200(已默认内置配置)');
        else logFail('/api/feishu/config 异常', cfg.status);
    });

    // ===== 汇总 =====
    console.log('\n========== 测试汇总 ==========');
    console.log('通过: ' + PASS.length + '  失败: ' + FAIL.length);
    if (FAIL.length > 0) {
        console.log('\n❌ 失败项:');
        FAIL.forEach((f) => console.log('  - ' + f));
        process.exit(1);
    } else {
        console.log('\n✅ 全部通过');
        process.exit(0);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
