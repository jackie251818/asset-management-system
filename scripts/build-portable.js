#!/usr/bin/env node
/**
 * 自动化便携版打包脚本
 * 用法：
 *   node scripts/build-portable.js                # 打便携版 portable
 *   node scripts/build-portable.js --target nsis  # 打安装版 NSIS
 *   node scripts/build-portable.js --dir          # 仅生成未打包目录（--dir，不上游包装便携 EXE）
 *
 * 工作内容：
 *   1. 读取 package.json 版本号
 *   2. 在 APP_DIR 根目录生成 build-info.json（构建时间 / 渠道 / 版本）
 *   3. 选一个带时间戳的新 dist_build_<ts> 输出目录，规避旧 app.asar 锁
 *   4. 调用 electron-builder，把结果放到新目录
 *   5. 打印产物绝对路径 / 文件大小，便于直接交付
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..');
const PKG_PATH = path.join(APP_DIR, 'package.json');
const BUILD_INFO_PATH = path.join(APP_DIR, 'build-info.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(2) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(3) + ' GB';
}
function pad(n) { return n < 10 ? ('0' + n) : '' + n; }
function ts() {
    const d = new Date();
    return d.getFullYear().toString()
        + pad(d.getMonth() + 1) + pad(d.getDate())
        + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function parseArgs(argv) {
    const args = { target: 'portable', dir: false, channel: 'portable' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--target' && i + 1 < argv.length) { args.target = argv[++i]; }
        else if (a === '--nsis') { args.target = 'nsis'; args.channel = 'nsis'; }
        else if (a === '--portable') { args.target = 'portable'; args.channel = 'portable'; }
        else if (a === '--dir') { args.dir = true; }
        else if (a === '--channel' && i + 1 < argv.length) { args.channel = argv[++i]; }
    }
    return args;
}

function writeBuildInfo(version, channel) {
    const info = {
        version: version,
        buildTime: new Date().toISOString(),
        channel: channel || 'portable',
        node: process.version,
        platform: process.platform
    };
    fs.writeFileSync(BUILD_INFO_PATH, JSON.stringify(info, null, 2) + '\n', 'utf8');
    console.log('[build-info] 已写入:', BUILD_INFO_PATH, info);
    return info;
}

function findArtifacts(outDir) {
    const results = [];
    function walk(dir, depth) {
        if (depth > 4) return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full, depth + 1);
                else if (e.isFile() && /\.exe$/i.test(e.name)) results.push(full);
            }
        } catch (_) {}
    }
    walk(outDir, 0);
    return results.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const pkg = readJson(PKG_PATH);
    const version = (pkg && pkg.version) ? String(pkg.version) : '0.0.0';

    if (!fs.existsSync(path.join(APP_DIR, 'node_modules'))) {
        console.error('[依赖] node_modules 不存在，先执行: npm install');
        process.exit(2);
    }

    // 1) 写 build-info.json（主进程会在注入脚本时读它，前端显示「构建时间」）
    const info = writeBuildInfo(version, args.channel);

    // 2) 准备输出目录（带时间戳，避免 app.asar 锁冲突）
    const outDir = path.join(APP_DIR, 'dist_build_' + ts());
    fs.mkdirSync(outDir, { recursive: true });
    console.log('[output] 输出目录:', outDir);

    // 3) 构造 electron-builder 参数
    const ebArgs = [];
    ebArgs.push('--win', args.target);
    if (args.dir) ebArgs.push('--dir');
    ebArgs.push('--config.directories.output=' + outDir);
    // 压缩级别固定 maximum（package.json 里也有，这里命令行再强调一下）
    ebArgs.push('--config.win.compression=maximum');

    // 4) 查找 electron-builder 可执行文件（优先本地，允许全局）
    let builderBin = path.join(APP_DIR, 'node_modules', '.bin', 'electron-builder');
    if (process.platform === 'win32' && !fs.existsSync(builderBin + '.cmd')) {
        // Win 下 .bin 目录是 .cmd，但部分包管理器直接放 js；两种都试试
    }
    let nodeBin = process.execPath;
    let builderJs = path.join(APP_DIR, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');

    console.log('[build] 开始执行 electron-builder:', args.target, args.dir ? '(dir only)' : '');
    let spawnResult;
    if (fs.existsSync(builderJs)) {
        spawnResult = spawnSync(nodeBin, [builderJs].concat(ebArgs), {
            cwd: APP_DIR,
            stdio: 'inherit',
            shell: false,
            env: process.env
        });
    } else {
        // 退回到 .bin/electron-builder
        const bin = path.join(APP_DIR, 'node_modules', '.bin',
            process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
        spawnResult = spawnSync(bin, ebArgs, {
            cwd: APP_DIR,
            stdio: 'inherit',
            shell: process.platform === 'win32',
            env: process.env
        });
    }

    if (spawnResult.status !== 0) {
        console.error('[build] electron-builder 失败，退出码:', spawnResult.status);
        process.exit(spawnResult.status || 1);
    }

    // 5) 报告产物
    const artifacts = findArtifacts(outDir);
    console.log('\n=================== 构建完成 ===================');
    console.log('版本:       ', version);
    console.log('渠道:       ', info.channel);
    console.log('构建时间:   ', info.buildTime);
    console.log('输出目录:   ', outDir);
    if (artifacts.length === 0) {
        console.log('⚠️  未找到 .exe 产物，请检查 electron-builder 日志（--dir 模式无 exe 是正常的）。');
    } else {
        console.log('发现 %d 个 exe 产物（按大小降序）:', artifacts.length);
        for (const f of artifacts) {
            const s = fs.statSync(f);
            console.log('  - %s  (%s)', f, fmtSize(s.size));
        }
        console.log('\n✅ 主交付物（便携 EXE）通常是体积最大的那个。');
    }
    console.log('================================================\n');
}

main();
