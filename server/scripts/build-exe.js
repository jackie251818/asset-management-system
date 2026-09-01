/**
 * 服务端可执行文件打包脚本 (@yao-pkg/pkg)
 *
 * 处理 generator-function 的 ESM 兼容问题:
 *   该包 exports 含 "module-sync": "./require.mjs", Node 22.20+ 的 require 会走该 ESM 入口,
 *   而 pkg 快照内无法解析 ESM 相对导入(已知限制)。
 *   打包前临时删除 exports(require 退化回 main: ./legacy.js, 纯 CJS), 打包后还原。
 *
 * 用法:
 *   npm run build:exe    → dist/asset-server.exe    (Windows x64, node22)
 *   npm run build:linux  → dist/asset-server-linux  (Linux x64,  node22, 在 Windows 上交叉打包)
 *
 * 产物为单文件, 内含前端静态资源与 better-sqlite3 原生模块(按目标平台自动取预编译二进制)。
 * Linux 产物运行要求: glibc ≥ 2.28 (Ubuntu 20.04+ / Debian 11+ / RHEL 9+); 首次运行需 chmod +x。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SERVER_ROOT = path.join(__dirname, '..');
const GF_PKG = path.join(SERVER_ROOT, 'node_modules', 'generator-function', 'package.json');

function main() {
    // 目标平台: --linux → Linux x64; 缺省 → Windows x64
    const isLinux = process.argv.includes('--linux');
    const pkgTargets = isLinux ? 'node22-linux-x64' : 'node22-win-x64';
    const outName = isLinux ? 'asset-server-linux' : 'asset-server.exe';

    let patched = false;
    let original = null;
    const backup = GF_PKG + '.buildbak';

    // 1) Patch: 删除 generator-function 的 exports(打包期间)
    if (fs.existsSync(GF_PKG)) {
        original = fs.readFileSync(GF_PKG, 'utf-8');
        const cfg = JSON.parse(original);
        if (cfg.exports) {
            delete cfg.exports;
            fs.writeFileSync(GF_PKG, JSON.stringify(cfg, null, '\t'));
            fs.writeFileSync(backup, original, 'utf-8');
            patched = true;
            console.log('[build-exe] 已临时移除 generator-function 的 exports (打包后自动还原)');
        }
    }

    try {
        // 2) 打包(CLI --targets 优先于 package.json 的 pkg.targets)
        execSync(`npx pkg . --targets ${pkgTargets} --output dist/${outName}`, {
            cwd: SERVER_ROOT,
            stdio: 'inherit',
        });
        console.log(`[build-exe] 打包完成: dist/${outName} (${pkgTargets})`);
    } finally {
        // 3) 还原
        if (patched && fs.existsSync(backup)) {
            fs.writeFileSync(GF_PKG, original, 'utf-8');
            fs.unlinkSync(backup);
            console.log('[build-exe] generator-function package.json 已还原');
        }
    }
}

main();
