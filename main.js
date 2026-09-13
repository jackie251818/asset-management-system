/**
 * Electron 主进程入口 - 固定资产管理系统便携式离线版
 *
 * 设计要点:
 * 1. 双运行模式:
 *    a) 单机模式(默认): 内嵌 HTTP 服务器(复用 simple_server.js 逻辑),自动选择可用端口
 *    b) C/S 客户端模式: exe 旁存在 server.config.json 且 serverUrl 有效时,
 *       窗口直接加载远程 C/S 服务端页面(数据/认证全部由服务端提供,本地不落任何数据)
 * 2. 静态资源从应用目录(asar 内)提供
 * 3. 数据目录支持便携式模式:数据保存在 exe 旁边的 data/ 目录,跟 exe 走
 * 4. 首次运行时,从 asar 内的初始 data 目录复制 .js 数据文件到便携式数据目录
 */

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

/** 主进程调试日志 — 写到文件便于 EXE 内嵌时查看 */
const MAIN_LOG = process.env.MAIN_LOG_PATH || require('os').tmpdir() + '/asset-main.log';
try { fs.writeFileSync(MAIN_LOG, '=== main process started ' + new Date().toISOString() + ' ===\n', 'utf8'); } catch(_) {}
function mainLog(msg) {
    try { fs.appendFileSync(MAIN_LOG, '[' + new Date().toISOString().slice(11,23) + '] ' + msg + '\n', 'utf8'); } catch(_) {}
}

// 应用资源目录(打包后位于 asar 内,开发时为 __dirname)
const APP_DIR = __dirname;

// ============ 启动时生成一次性安全 token（仅 127.0.0.1 的 Electron 渲染进程持有）============
const HTTP_API_TOKEN = (function genToken() {
    let s = '';
    const hex = '0123456789abcdef';
    for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
    return s;
})();

/**
 * 原子写入文件（写 .tmp → fs.renameSync 原子替换 → 成功返回 true）。
 * rename 在跨卷 / FAT32 / U 盘场景会失败,兜底为普通 writeFileSync（保留错误日志,返回 false）。
 */
function writeFileAtomic(targetPath, content, encoding) {
    encoding = encoding || 'utf-8';
    const resolved = path.resolve(targetPath);
    const dir = path.dirname(resolved);
    const tmpPath = resolved + '.tmp.' + process.pid + '.' + Date.now();
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmpPath, content, encoding);
        // 强制刷盘后再重命名,降低断电半写
        try { const fd = fs.openSync(tmpPath, 'r+'); fs.fsyncSync(fd); fs.closeSync(fd); } catch (_) {}
        try {
            if (fs.existsSync(resolved)) {
                // 先将目标文件备份为 .bak-<pid>,防止 rename 到中间崩了
                const bak = resolved + '.bak.' + process.pid;
                try { fs.renameSync(resolved, bak); }
                catch (_) { try { fs.unlinkSync(bak); } catch (_e) {} }
            }
            fs.renameSync(tmpPath, resolved);
        } catch (renameErr) {
            // 跨卷 / FAT32: 回退 copy → 删除 tmp
            try {
                fs.copyFileSync(tmpPath, resolved);
                try { fs.unlinkSync(tmpPath); } catch (_) {}
            } catch (copyErr) {
                // 最后兜底:直接 writeFileSync
                fs.writeFileSync(resolved, content, encoding);
                try { fs.unlinkSync(tmpPath); } catch (_) {}
            }
        }
        return true;
    } catch (e) {
        console.error(`[writeFileAtomic] 写入失败: ${resolved} -> ${e.message}`);
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
        return false;
    }
}

/**
 * 启动前对 8 个数据 .js / 配套 .json 做健康检查:
 *  - .js 语法/结构损坏(缺 window.__LOCAL_DATA__ 或文件截断) → 自动从 .json 还原
 *  - .json 损坏 / 解析失败 → 从最近的 data/.backup_*.zip 或上一份 .bak.文件回滚
 * 返回 { repaired: <修复文件数>,  messages: [...] }
 */
function healthCheckAndRepair(dataDir) {
    const result = { repaired: 0, messages: [] };
    if (!dataDir || !fs.existsSync(dataDir)) return result;

    const dataKeys = [
        'assetManagementData',
        'custom_options_department','custom_options_department_deleted',
        'custom_options_owner','custom_options_owner_deleted',
        'custom_options_type','custom_options_type_deleted',
        'userStateData',
    ];
    for (const key of dataKeys) {
        const jsPath = path.join(dataDir, key + '.js');
        const jsonPath = path.join(dataDir, key + '.json');
        const jsExists = fs.existsSync(jsPath);
        const jsonExists = fs.existsSync(jsonPath);
        if (!jsExists && !jsonExists) continue;

        // 1) 先校验 json,缺/坏则用 js 内容 或 文件备份 救回
        if (!jsonExists) {
            if (jsExists) {
                try {
                    const js = fs.readFileSync(jsPath, 'utf-8');
                    const m = js.match(/window\.__LOCAL_DATA__\.[A-Za-z0-9_]+\s*=\s*([\s\S]*?);?\s*$/);
                    if (m) {
                        const parsed = JSON.parse(m[1]);
                        writeFileAtomic(jsonPath, JSON.stringify(parsed, null, 2), 'utf-8');
                        result.repaired++;
                        result.messages.push(`${key}.json 缺失,从 ${key}.js 自动恢复`);
                    }
                } catch (e) {
                    result.messages.push(`${key}.json 缺失,且无法从 .js 解析: ${e.message}`);
                }
            }
        } else {
            let jsonBad = false;
            try { JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); } catch (_) { jsonBad = true; }
            if (jsonBad) {
                const recovered = tryRecoverFileFromBackups(dataDir, key);
                if (recovered.ok) { result.repaired++; result.messages.push(`${key}.json 损坏,已从备份恢复`); }
                else {
                    if (jsExists) {
                        try {
                            const js = fs.readFileSync(jsPath, 'utf-8');
                            const m = js.match(/window\.__LOCAL_DATA__\.[A-Za-z0-9_]+\s*=\s*([\s\S]*?);?\s*$/);
                            if (m) {
                                JSON.parse(m[1]);
                                writeFileAtomic(jsonPath, JSON.stringify(JSON.parse(m[1]), null, 2));
                                result.repaired++;
                                result.messages.push(`${key}.json 损坏,已从 .js 同步恢复`);
                            }
                        } catch (_) { result.messages.push(`${key}.json 损坏且无法自动恢复`); }
                    }
                }
            }
        }
        // 2) 再校验 .js(缺/坏 -> 从 .json 再生成)
        const jsOk = (function checkJsOk(){
            if (!jsExists) return false;
            try {
                const js = fs.readFileSync(jsPath, 'utf-8');
                return /window\.__LOCAL_DATA__\s*=\s*window\.__LOCAL_DATA__\s*\|\|\s*\{\};/.test(js) &&
                    /window\.__LOCAL_DATA__\.[A-Za-z0-9_]+\s*=/.test(js);
            } catch (_) { return false; }
        })();
        if (!jsOk) {
            const jsonRealPath = path.join(dataDir, key + '.json');
            if (fs.existsSync(jsonRealPath)) {
                try {
                    const value = JSON.parse(fs.readFileSync(jsonRealPath, 'utf-8'));
                    const jsContent = `// ${key} 数据文件(本地模式)\n` +
                        `// 此文件由系统自动维护,请勿手动编辑\n` +
                        `// 最后更新: ${new Date().toISOString()}\n` +
                        `window.__LOCAL_DATA__ = window.__LOCAL_DATA__ || {};\n` +
                        `window.__LOCAL_DATA__.${key} = ${JSON.stringify(value, null, 2)};\n`;
                    writeFileAtomic(jsPath, jsContent, 'utf-8');
                    result.repaired++;
                    result.messages.push(`${key}.js 损坏/缺失,已从 .json 同步恢复`);
                } catch (e) {
                    result.messages.push(`${key}.js 无法恢复: ${e.message}`);
                }
            }
        }
    }
    if (result.repaired > 0) {
        console.log(`[健康检查] 修复 ${result.repaired} 个数据文件:`, result.messages.join('; '));
    } else {
        console.log('[健康检查] 8 个数据文件全部健康,无需修复');
    }
    // 清理 30 天前的 .tmp / .bak / pre-import 残留
    try {
        const now = Date.now();
        const DAY30 = 30 * 24 * 3600 * 1000;
        for (const name of fs.readdirSync(dataDir)) {
            const full = path.join(dataDir, name);
            try {
                const st = fs.statSync(full);
                if (!st.isFile()) continue;
                const stale = (now - st.mtimeMs) > DAY30;
                if (!stale) continue;
                if (name.startsWith('pre-import-') && name.endsWith('.bak')) {
                    fs.unlinkSync(full);
                } else if ((name.endsWith('.bak') || name.endsWith('.tmp')) && /\.\d+\./.test(name)) {
                    fs.unlinkSync(full);
                }
            } catch (_) {}
        }
    } catch (_) {}
    return result;
}
/** 从 data/.backup_* 或最近同名的 .bak-* 文件恢复到 <key>.json（仅损坏时调用），返回 {ok} */
function tryRecoverFileFromBackups(dataDir, key) {
    try {
        const prefix = `.backup_${key}_`;
        const candidates = fs.readdirSync(dataDir)
            .filter(n => n.startsWith(prefix))
            .map(n => {
                const st = fs.statSync(path.join(dataDir, n));
                return { n, t: st.mtimeMs };
            })
            .sort((a, b) => b.t - a.t);
        for (const c of candidates) {
            try {
                const full = path.join(dataDir, c.n);
                const buf = fs.readFileSync(full, 'utf-8');
                JSON.parse(buf);
                writeFileAtomic(path.join(dataDir, key + '.json'), buf, 'utf-8');
                return { ok: true };
            } catch (_) {}
        }
    } catch (_) {}
    return { ok: false };
}

/**
 * 导入事务性快照：在导入 Excel/JSON 前先将 data/ 下当前的 .json + .js 整体复制为
 * data/pre-import-<timestamp>.bak/<key>.*，失败时一键回滚。
 * 入口：POST /api/exec {action:'createImportSnapshot'} / {action:'rollbackImport', dir} / {action:'commitImport', dir}
 */
function listDataSnapshotableFiles(dataDir) {
    const keys = [
        'assetManagementData',
        'custom_options_department','custom_options_department_deleted',
        'custom_options_owner','custom_options_owner_deleted',
        'custom_options_type','custom_options_type_deleted',
        'userStateData',
    ];
    const out = [];
    for (const k of keys) {
        for (const ext of ['.json', '.js']) {
            const p = path.join(dataDir, k + ext);
            if (fs.existsSync(p)) out.push(p);
        }
    }
    return out;
}
function createImportSnapshot(dataDir) {
    const id = 'pre-import-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
    const dir = path.join(dataDir, id + '.d');
    try {
        fs.mkdirSync(dir, { recursive: true });
        for (const f of listDataSnapshotableFiles(dataDir)) {
            fs.copyFileSync(f, path.join(dir, path.basename(f)));
        }
        // 完成标记:写 id.txt 防止半打状态被回滚
        fs.writeFileSync(path.join(dir, 'id.txt'), id, 'utf-8');
        console.log('[导入事务] 快照创建: ' + id);
        return { ok: true, snapshotId: id };
    } catch (e) {
        try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        return { ok: false, error: e.message };
    }
}
function rollbackImportSnapshot(dataDir, id) {
    if (!id || !/^pre-import-\d{13}-\d{1,5}$/.test(id)) return { ok: false, error: '非法 snapshotId' };
    const dir = path.join(dataDir, id + '.d');
    if (!fs.existsSync(dir) || !fs.existsSync(path.join(dir, 'id.txt'))) return { ok: false, error: '快照不存在' };
    try {
        for (const f of fs.readdirSync(dir)) {
            if (f === 'id.txt') continue;
            const src = path.join(dir, f);
            const dst = path.join(dataDir, f);
            if (!fs.statSync(src).isFile()) continue;
            // 用原子写入覆盖当前文件
            fs.copyFileSync(src, dst);
        }
        // 删除快照目录
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        console.log('[导入事务] 已回滚到快照: ' + id);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}
function commitImportSnapshot(dataDir, id) {
    if (!id) return { ok: true };
    const dir = path.join(dataDir, id + '.d');
    try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        console.log('[导入事务] 已提交并清理快照: ' + id);
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
}

/**
 * 校验 HTTP token：
 *   - 来源是 GET 读操作：除 /api/exec 外全部放行
 *   - 来源是 POST 且为 /api/*：Header X-Server-Token 或 body.__token 必须与 HTTP_API_TOKEN 全等
 *   - file:// 模式（无 window.__SERVER_URL__）的前端调用不会走到这里，所以此处严格校验即可
 */
function requiresTokenAuth(pathname, method) {
    if (method !== 'POST') return false;
    return pathname.startsWith('/api/');
}
function verifyToken(req, bodyTextMaybe) {
    // 1) header 优先
    const h = (req.headers['x-server-token'] || '').toString();
    if (h && h === HTTP_API_TOKEN) return true;
    // 2) query ?token= 兜底
    const q = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (q && q === HTTP_API_TOKEN) return true;
    // 3) body.__token（对于已解析 body 的场景，调用方传入 bodyTextMaybe）
    if (bodyTextMaybe && typeof bodyTextMaybe === 'string') {
        try {
            const obj = JSON.parse(bodyTextMaybe);
            if (obj && obj.__token && obj.__token === HTTP_API_TOKEN) return true;
        } catch (_) {}
    }
    return false;
}

// MIME 类型映射表
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.otf': 'font/otf',
    '.pdf': 'application/pdf',
    '.csv': 'text/csv; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.map': 'application/json; charset=utf-8'
};

/**
 * 便携式模式下,exe 所在目录的 data/ 容易被误删(例如 exe 放桌面)。
 * 默认改为将数据写入 %APPDATA%\<产品名>\data(与安装版一致,用户不可见、不易误删)。
 * 若用户希望「数据跟 exe 走」(U盘/硬盘携带场景),可在 exe 旁边手动新建一个空文件:
 *     .portable           (推荐,符合 electron-builder 语义)
 * 或  便携模式.dat
 * 存在任一开关文件即启用"exe 旁 data/"的传统便携模式。
 */
const PORTABLE_MODE_MARKERS = ['.portable', '便携模式.dat'];

/**
 * 检测一个目录路径是否属于"用户高可见、易误删"的位置(桌面/下载/文档等)。
 * 仅用于日志提示,不阻塞选择逻辑(最终选择权仍由 .portable 开关决定)。
 */
function isHighVisibilityDir(dir) {
    if (!dir) return false;
    const home = process.env.USERPROFILE || '';
    if (!home) return false;
    const candidates = [
        path.join(home, 'Desktop'),
        path.join(home, '桌面'),
        path.join(home, 'Downloads'),
        path.join(home, '下载'),
        path.join(home, 'Documents'),
        path.join(home, '文档'),
    ];
    const resolved = path.resolve(dir);
    return candidates.some(c => resolved === path.resolve(c) || resolved.startsWith(path.resolve(c) + path.sep));
}

/**
 * 将旧位置(exe 旁 data/)的数据一次性迁移到新目录,
 * 迁移后保留旧目录改名后缀 `.bak-<time>` 以便回滚,不直接删除用户资产。
 * 返回 true 表示发生过迁移。
 */
function tryMigrateLegacyData(fromDir, toDir) {
    if (!fromDir || !toDir) return false;
    if (!fs.existsSync(fromDir)) return false;
    if (fromDir === toDir) return false;

    let fromHasData = false;
    try {
        fromHasData = fs.readdirSync(fromDir).some(n => n.endsWith('.js') || n.endsWith('.json'));
    } catch (_) { fromHasData = false; }
    if (!fromHasData) return false;

    let toIsEmpty = true;
    try {
        if (fs.existsSync(toDir)) {
            toIsEmpty = fs.readdirSync(toDir).filter(n => !n.startsWith('.')).length === 0;
        }
    } catch (_) { toIsEmpty = true; }
    if (!toIsEmpty) return false;

    try {
        if (!fs.existsSync(toDir)) fs.mkdirSync(toDir, { recursive: true });
        const files = fs.readdirSync(fromDir);
        let copied = 0;
        for (const name of files) {
            const src = path.join(fromDir, name);
            const dst = path.join(toDir, name);
            if (fs.existsSync(dst)) continue;
            try {
                const stat = fs.statSync(src);
                if (stat.isDirectory()) continue; // 暂不处理子目录(数据无嵌套)
                fs.copyFileSync(src, dst);
                copied++;
            } catch (e) {
                console.warn(`[迁移] 复制 ${name} 失败: ${e.message}`);
            }
        }
        // 旧目录改名备份(便于用户回滚),不直接删除
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupDir = `${fromDir}.bak-${stamp}`;
        try { fs.renameSync(fromDir, backupDir); }
        catch (e) { console.warn(`[迁移] 旧目录改备份名失败,保留原目录: ${e.message}`); }

        console.log(`[迁移] 已从 ${fromDir} 迁移 ${copied} 个数据文件 -> ${toDir}`);
        return copied > 0;
    } catch (e) {
        console.error(`[迁移] 迁移过程失败: ${e.message}`);
        return false;
    }
}

/**
 * 获取便携式数据目录
 * - 便携式打包模式:
 *     ① 若 exe 旁存在 .portable / 便携模式.dat 开关 -> 仍使用 exe 旁 data/(传统 U 盘便携模式)
 *     ② 否则 -> 使用 %APPDATA%/<产品名>/data,避免在桌面等处生成 data/ 被误删
 * - NSIS 安装模式: %APPDATA%/<appName>/data(Program Files 不可写)
 * - 开发模式: 项目目录下的 data/ 目录
 */
function getPortableDataDir() {
    // 便携式打包模式:由 electron-builder portable 注入
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
        const exeDir = process.env.PORTABLE_EXECUTABLE_DIR;
        const forcePortable = PORTABLE_MODE_MARKERS.some(m => fs.existsSync(path.join(exeDir, m)));
        if (forcePortable) {
            const portableDataDir = path.join(exeDir, 'data');
            console.log(`[应用] 检测到便携模式开关,使用 exe 旁数据目录: ${portableDataDir}`);
            return portableDataDir;
        }
        // 默认:写入 APPDATA,避免在桌面/根目录暴露 data/
        const appDataDir = path.join(app.getPath('userData'), 'data');
        const legacyDataDir = path.join(exeDir, 'data');
        // 首次启动时自动迁移旧数据(仅一次:当 APPDATA 为空且旧 data 有内容)
        tryMigrateLegacyData(legacyDataDir, appDataDir);
        if (isHighVisibilityDir(exeDir)) {
            console.log(`[应用] 检测到 exe 在桌面/下载/文档等高可见目录,数据已保存在 ${appDataDir},避免误删。如需传统便携模式请在 exe 旁创建文件: ${PORTABLE_MODE_MARKERS.join(' 或 ')}`);
        }
        return appDataDir;
    }
    // NSIS 安装模式:Program Files 不可写,使用 userData 目录
    if (app.isPackaged) {
        return path.join(app.getPath('userData'), 'data');
    }
    // 开发模式
    return path.join(APP_DIR, 'data');
}

/**
 * 初始化便携式数据目录
 * 首次运行时,从 asar 内的初始 data 目录复制 .js 数据文件到便携式数据目录
 * 不覆盖已存在的文件,保护用户数据
 */
function initPortableDataDir(portableDataDir) {
    try {
        if (!fs.existsSync(portableDataDir)) {
            fs.mkdirSync(portableDataDir, { recursive: true });
            console.log(`[初始化] 创建数据目录: ${portableDataDir}`);
        }

        // 检查便携式数据目录是否已有 .js 数据文件(仅基于 .js 判断,避免被无关 .json 干扰)
        const existingJsFiles = fs.readdirSync(portableDataDir)
            .filter(f => f.endsWith('.js'));
        if (existingJsFiles.length >= 8) {
            console.log(`[初始化] 数据目录已有 ${existingJsFiles.length} 个 .js 数据文件,跳过初始化`);
            return;
        }

        // 从 asar 内的 data 目录复制初始 .js 文件
        const sourceDataDir = path.join(APP_DIR, 'data');
        if (!fs.existsSync(sourceDataDir)) {
            console.warn(`[初始化] 源数据目录不存在: ${sourceDataDir}`);
            return;
        }

        const files = fs.readdirSync(sourceDataDir);
        let copiedCount = 0;
        for (const file of files) {
            // 仅复制 .js 数据文件(不复制 .json、.gitkeep 等)
            if (!file.endsWith('.js')) continue;

            const srcPath = path.join(sourceDataDir, file);
            const destPath = path.join(portableDataDir, file);
            // 不覆盖已存在的文件(迁移过来的用户数据优先级更高)
            if (fs.existsSync(destPath)) continue;
            try {
                const content = fs.readFileSync(srcPath, 'utf-8');
                fs.writeFileSync(destPath, content, 'utf-8');
                copiedCount++;
                console.log(`[初始化] 复制初始数据: ${file}`);
            } catch (e) {
                console.error(`[初始化] 复制失败: ${file}`, e.message);
            }
        }
        console.log(`[初始化] 共复制 ${copiedCount} 个初始数据文件`);
    } catch (e) {
        console.error(`[初始化] 数据目录初始化失败:`, e.message);
    }
}

/**
 * 解析请求 URL 为安全的绝对路径,防止路径遍历
 */
function resolveSafePath(requestUrl, publicDir) {
    const parsed = new URL(requestUrl, 'http://localhost');
    let pathname = decodeURIComponent(parsed.pathname);

    if (pathname === '/') {
        pathname = '/index.html';
    }

    const resolved = path.resolve(publicDir, '.' + pathname);
    const normalizedPublic = path.resolve(publicDir);

    if (resolved !== normalizedPublic && !resolved.startsWith(normalizedPublic + path.sep)) {
        return null;
    }
    return resolved;
}

/**
 * 启动内嵌 HTTP 服务器
 * @param {string} publicDir 静态资源目录
 * @param {string} dataDir 数据目录
 * @returns {Promise<number>} 监听端口
 */
function startServer(publicDir, dataDir) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const parsedUrl = new URL(req.url, 'http://localhost');
            const pathname = parsedUrl.pathname;

            // ============ API 端点处理 ============
            if (pathname.startsWith('/api/')) {
                const key = parsedUrl.searchParams.get('key') || '';
                // 安全校验:key 不允许包含 ../ 或绝对路径
                if (key && (key.includes('..') || key.includes('/') || key.includes('\\') || key.includes(':'))) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: '非法的 key 参数' }));
                    return;
                }

                // GET /api/load?key=xxx - 加载数据文件
                if (req.method === 'GET' && pathname === '/api/load') {
                    if (!key) {
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ success: false, error: '缺少 key 参数' }));
                        return;
                    }
                    const filePath = path.join(dataDir, `${key}.json`);
                    fs.readFile(filePath, 'utf-8', (err, data) => {
                        if (err) {
                            if (err.code === 'ENOENT') {
                                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                                res.end(JSON.stringify({ success: false, error: '文件不存在', data: null }));
                            } else {
                                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                                res.end(JSON.stringify({ success: false, error: err.message }));
                            }
                            return;
                        }
                        try {
                            const parsed = JSON.parse(data);
                            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ success: true, data: parsed }));
                        } catch (e) {
                            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ success: true, data: data }));
                        }
                    });
                    return;
                }

                // GET /api/list - 列出所有数据文件
                if (req.method === 'GET' && pathname === '/api/list') {
                    fs.readdir(dataDir, (err, files) => {
                        if (err) {
                            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ success: false, error: err.message }));
                            return;
                        }
                        const jsonFiles = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
                        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ success: true, data: jsonFiles }));
                    });
                    return;
                }

                // POST /api/save?key=xxx - 保存数据到文件（原子写入 + Token 鉴权）
                if (req.method === 'POST' && pathname === '/api/save') {
                    if (!key) {
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ success: false, error: '缺少 key 参数' }));
                        return;
                    }
                    // 提前收集 body，方便后续做 token body.__token 校验
                    const MAX_BODY = 20 * 1024 * 1024; // 20MB 上限
                    const chunks = [];
                    let totalSize = 0;
                    let aborted = false;

                    req.on('data', chunk => {
                        if (aborted) return;
                        totalSize += chunk.length;
                        if (totalSize > MAX_BODY) {
                            aborted = true;
                            res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ success: false, error: '请求体过大(超过 20MB)' }));
                            req.destroy();
                            return;
                        }
                        chunks.push(chunk);
                    });

                    req.on('end', () => {
                        if (aborted) return;
                        const body = Buffer.concat(chunks).toString('utf-8');

                        // Token 鉴权（header / query / body.__token）
                        if (!verifyToken(req, body)) {
                            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ success: false, error: '未授权:缺少或错误的 X-Server-Token' }));
                            return;
                        }

                        // 解包 {key, value, __token} 包装对象,显式校验 value
                        let dataToSave;
                        try {
                            const parsed = JSON.parse(body);
                            if (parsed && parsed.value !== undefined) {
                                dataToSave = JSON.stringify(parsed.value, null, 2);
                            } else {
                                // 兼容直接传值的场景(无包装),body 本身就是数据
                                dataToSave = body;
                            }
                        } catch (e) {
                            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ success: false, error: '请求体不是有效的 JSON: ' + e.message }));
                            return;
                        }

                        try {
                            const jsonFilePath = path.join(dataDir, `${key}.json`);
                            const jsonOk = writeFileAtomic(jsonFilePath, dataToSave, 'utf-8');
                            if (!jsonOk) throw new Error('写入 .json 原子失败(回退写后仍失败)');

                            // P2-8:同步写入 .js 文件(JSONP 风格),保持 data/ 目录下 .js 与 .json 版本一致
                            const jsFileName = `${key}.js`;
                            const jsFilePath = path.join(dataDir, jsFileName);
                            const jsContent = `// ${key} 数据文件(本地模式)\n` +
                                `// 此文件由系统自动维护,请勿手动编辑\n` +
                                `// 最后更新: ${new Date().toISOString()}\n` +
                                `window.__LOCAL_DATA__ = window.__LOCAL_DATA__ || {};\n` +
                                `window.__LOCAL_DATA__.${key} = ${dataToSave};\n`;
                            try { writeFileAtomic(jsFilePath, jsContent, 'utf-8'); }
                            catch (jsErr) {
                                console.warn(`[API] /api/save 同步写入 .js 失败(不影响主流程): ${key}`, jsErr && jsErr.message);
                            }
                            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ success: true }));
                        } catch (err) {
                            console.error(`[API] /api/save 保存失败: ${key}`, err && err.message);
                            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ success: false, error: (err && err.message) || String(err) }));
                        }
                    });
                    return;
                }

                // DELETE /api/delete?key=xxx - 删除数据文件 (Token 鉴权 + 原子 rename 再删除)
                if (req.method === 'DELETE' && pathname === '/api/delete') {
                    if (!key) {
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ success: false, error: '缺少 key 参数' }));
                        return;
                    }
                    // DELETE 同样属于写操作，校验 token（浏览器 fetch method=DELETE 与 POST 同类）
                    if (!verifyToken(req)) {
                        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ success: false, error: '未授权:缺少或错误的 X-Server-Token' }));
                        return;
                    }
                    const removeAtomic = (p) => {
                        if (!fs.existsSync(p)) return true;
                        try {
                            const tomb = p + '.del.' + process.pid + '.' + Date.now();
                            fs.renameSync(p, tomb);
                            try { fs.unlinkSync(tomb); } catch (_) { /* 下次健康检查会清 */ }
                            return true;
                        } catch (e) {
                            try { fs.unlinkSync(p); return true; } catch (_e) { return false; }
                        }
                    };
                    const jsonPath = path.join(dataDir, `${key}.json`);
                    const jsPath = path.join(dataDir, `${key}.js`);
                    const ok1 = removeAtomic(jsonPath);
                    const ok2 = removeAtomic(jsPath);
                    if (!ok1 && fs.existsSync(jsonPath)) {
                        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ success: false, error: '.json 文件删除失败' }));
                        return;
                    }
                    if (!ok2 && fs.existsSync(jsPath)) {
                        console.warn('[API] /api/delete .js 清理失败(不阻塞主流程): ' + key);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true }));
                    return;
                }

                // GET /api/ping - 服务器存活检测
                if (req.method === 'GET' && pathname === '/api/ping') {
                    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
                    res.end('window.__serverOnline=true;void(0);');
                    return;
                }

                // GET /api/info - 获取服务器信息 + 构建时间
                if (req.method === 'GET' && pathname === '/api/info') {
                    let buildInfo = {};
                    try {
                        const p = path.join(APP_DIR, 'build-info.json');
                        if (fs.existsSync(p)) buildInfo = JSON.parse(fs.readFileSync(p, 'utf-8')) || {};
                    } catch (_) { buildInfo = {}; }
                    let packageVersion = '';
                    try {
                        const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf-8'));
                        packageVersion = pkg.version || '';
                    } catch (_) {}
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        success: true,
                        port: server.address().port,
                        host: 'localhost',
                        url: `http://localhost:${server.address().port}`,
                        dataDir: dataDir,
                        isElectronPackaged: !!app.isPackaged,
                        portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR || '',
                        buildTime: buildInfo.buildTime ? String(buildInfo.buildTime) : '',
                        buildChannel: buildInfo.channel ? String(buildInfo.channel) : 'source',
                        packageVersion,
                        embedded: true          // 标识为 Electron 单机内嵌服务(前端免密单机模式, 与远端 C/S cs:true 区分)
                    }));
                    return;
                }

                // POST /api/exec - 白名单操作（打开目录 + 导入事务快照），全走 Token 鉴权
                if (req.method === 'POST' && pathname === '/api/exec') {
                    let bodyRaw = '';
                    let bodyAborted = false;
                    const MAX_BODY = 8192;
                    req.on('data', (c) => {
                        if (bodyAborted) return;
                        bodyRaw += c.toString('utf8');
                        if (bodyRaw.length > MAX_BODY) { bodyAborted = true; req.destroy(); }
                    });
                    req.on('end', () => {
                        if (bodyAborted) return;
                        let action = '';
                        let payload = {};
                        try {
                            payload = JSON.parse(bodyRaw || '{}');
                            action = (payload.action || '').toString().trim();
                        } catch (_) { payload = {}; action = ''; }

                        // Token 鉴权：所有 /api/exec 操作都是写/副作用类，强制校验
                        if (!verifyToken(req, bodyRaw)) {
                            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ success: false, error: '未授权:缺少或错误的 X-Server-Token' }));
                            return;
                        }

                        // Action 白名单
                        const openActions = new Set(['openDataDir', 'openExeDir']);
                        const snapActions = new Set(['createImportSnapshot', 'rollbackImport', 'commitImport']);
                        if (!openActions.has(action) && !snapActions.has(action)) {
                            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ success: false, error: '不支持的 action' }));
                            return;
                        }

                        if (snapActions.has(action)) {
                            let r = { ok: false, error: '未知 action' };
                            try {
                                const id = (payload.snapshotId || '').toString().trim();
                                if (action === 'createImportSnapshot') r = createImportSnapshot(dataDir);
                                else if (action === 'rollbackImport') r = rollbackImportSnapshot(dataDir, id);
                                else if (action === 'commitImport') r = commitImportSnapshot(dataDir, id);
                            } catch (e) { r = { ok: false, error: e.message || String(e) }; }
                            res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify(r));
                            return;
                        }

                        // openDataDir / openExeDir 分支（仅 Windows）
                        if (process.platform !== 'win32') {
                            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ success: false, error: '仅支持 Windows 平台打开目录' }));
                            return;
                        }
                        const exeDir = (process.env.PORTABLE_EXECUTABLE_DIR && process.env.PORTABLE_EXECUTABLE_DIR.trim())
                            ? process.env.PORTABLE_EXECUTABLE_DIR
                            : (() => {
                                  try {
                                      const exePath = app.getPath('exe');
                                      if (exePath && fs.existsSync(exePath)) return path.dirname(exePath);
                                  } catch (_) {}
                                  return '';
                              })();
                        const targetDir = action === 'openDataDir' ? dataDir : exeDir;
                        if (!targetDir || !fs.existsSync(targetDir)) {
                            res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ success: false, error: '目标目录不存在' }));
                            return;
                        }
                        const allowed = [dataDir];
                        if (exeDir) allowed.push(exeDir);
                        const normTarget = path.resolve(targetDir);
                        const inWhitelist = allowed.some(d => path.resolve(d) === normTarget);
                        if (!inWhitelist) {
                            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ success: false, error: '不在允许的目录白名单中' }));
                            return;
                        }
                        const { exec } = require('child_process');
                        exec(`explorer.exe "" "${targetDir}"`, { windowsHide: true }, (err) => {
                            if (err) {
                                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                                res.end(JSON.stringify({ success: false, error: err.message }));
                                return;
                            }
                            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ success: true }));
                        });
                    });
                    return;
                }

                // 未匹配的 API 端点
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, error: '未知的 API 端点' }));
                return;
            }

            // ============ 静态文件处理 ============
            const filePath = resolveSafePath(req.url, publicDir);
            if (!filePath) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('403 Forbidden: 非法路径访问');
                return;
            }

            const extname = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[extname] || 'application/octet-stream';

            fs.readFile(filePath, (error, content) => {
                if (error) {
                    if (error.code === 'ENOENT') {
                        const fallbackHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>404</title></head><body><h1>404 Not Found</h1><p>请求的文件不存在。</p></body></html>';
                        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(fallbackHtml, 'utf-8');
                    } else {
                        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                        res.end(`服务器错误: ${error.code}`);
                    }
                } else {
                    // P3-17: libs/ 下第三方库不可变,加长缓存减少重复读取
                    const headers = { 'Content-Type': contentType };
                    if (filePath.includes(path.sep + 'libs' + path.sep) && ['.js', '.css', '.woff2', '.woff', '.ttf'].includes(extname)) {
                        headers['Cache-Control'] = 'public, max-age=2592000, immutable';
                    }
                    // Token + 构建时间注入：仅针对 index.html（主入口），在 </body> 前追加 <script>
                    // 注意: asar 内 index.html 只读，这里只在 HTTP 返回体改写，不修改磁盘
                    if (extname === '.html' && filePath === path.resolve(publicDir, 'index.html')) {
                        let html = content.toString('utf8');
                        const safeToken = String(HTTP_API_TOKEN).replace(/[<>&"\\]/g, '');
                        const safePort = String(server.address().port);
                        const buildInfo = (function () {
                            try {
                                const p = path.join(APP_DIR, 'build-info.json');
                                if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')) || {};
                            } catch (_) {}
                            return {};
                        })();
                        let pkgVer = '';
                        try { pkgVer = (JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf-8')) || {}).version || ''; } catch (_) {}
                        const inject = [
                            '<script data-injected-by="main-process" nonce="server-token">',
                            '  (function() {',
                            '    window.__SERVER_TOKEN__ = ' + JSON.stringify(safeToken) + ';',
                            '    window.__SERVER_URL__ = "http://127.0.0.1:' + safePort + '";',
                            '    window.__BUILD_INFO__ = ' + JSON.stringify({
                                buildTime: buildInfo.buildTime ? String(buildInfo.buildTime) : '',
                                channel: buildInfo.channel ? String(buildInfo.channel) : 'source',
                                version: pkgVer
                            }) + ';',
                            '  })();',
                            '</script>'
                        ].join('\n');
                        if (/<\/body>/i.test(html)) {
                            html = html.replace(/<\/body>/i, inject + '\n</body>');
                        } else {
                            html = html + '\n' + inject;
                        }
                        headers['Content-Length'] = Buffer.byteLength(html, 'utf-8');
                        res.writeHead(200, headers);
                        res.end(html, 'utf-8');
                        return;
                    }
                    res.writeHead(200, headers);
                    res.end(content, 'utf-8');
                }
            });
        });

        // 监听端口 0,让系统自动分配可用端口,避免端口冲突
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            console.log(`[服务器] HTTP 服务器运行在 http://127.0.0.1:${port}/`);
            console.log(`[服务器] 静态资源目录: ${publicDir}`);
            console.log(`[服务器] 数据目录: ${dataDir}`);
            httpServer = server; // 保存实例,用于退出时优雅关闭
            resolve(port);
        });

        server.on('error', (err) => {
            console.error(`[服务器] 启动失败:`, err.message);
            reject(err);
        });
    });
}

// 主窗口引用,避免被垃圾回收
let mainWindow = null;
// HTTP 服务器引用,退出时优雅关闭,避免最后的写入被截断
let httpServer = null;
// 内置完整服务端(asset-server.exe)子进程引用: 单机模式优先拉起, 含飞书同步等全部服务端能力
let embeddedServerProc = null;

/**
 * ============ 打印预览窗口(不走浏览器) ============
 * 调用: openPrintWindow(url)  — 标签打印(loadURL)
 *       openPrintWindow({ html, title }) — 登记卡打印(data URL)
 * 行为: 创建 Electron 子窗口 → 注入顶部悬浮 toolbar
 *        用户点工具栏「🖨 打印」或按 Ctrl+P → 触发 window.print()
 *        Chromium 会弹打印对话框(带预览), 选好打印机才真的打印
 *        避免旧版 window.open 被 setWindowOpenHandler 拦截 → 浏览器弹窗
 */

/** 在 HTML 里注入统一打印工具栏: 放到 </head> 之前; 同时清除原 HTML 里可能存在的自动 window.print() */
function injectPrintToolbar(html, opts) {
    const title = (opts && opts.title) || '';
    // 清除原 HTML 中"自动触发 window.print"的 onload 脚本(登记卡默认模板里有)
    let cleanHtml = html.replace(/<script[^>]*>[\s\S]*?(?:window\.print|onload[\s\S]{0,50}print)[\s\S]*?<\/script>/gi,
        '<!-- auto-print removed: use toolbar instead -->');
    const toolbarScript = `
<style>
    #__asset_print_toolbar {
        position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
        background: rgba(37,99,235,.95); color: #fff;
        padding: 10px 16px; display: flex; align-items: center; justify-content: space-between;
        font-family: -apple-system,Segoe UI,Microsoft YaHei,sans-serif; font-size: 14px;
        box-shadow: 0 2px 8px rgba(0,0,0,.15);
    }
    #__asset_print_toolbar button {
        border: 0; border-radius: 4px; padding: 6px 14px; cursor: pointer;
        font-weight: 600; font-size: 13px; margin-left: 8px;
    }
    #__asset_print_toolbar .btn-print { background: #fff; color: #2563eb; }
    #__asset_print_toolbar .btn-close {
        background: transparent; color: #fff;
        border: 1px solid rgba(255,255,255,.6);
    }
    @media print {
        #__asset_print_toolbar { display: none !important; }
        html { padding-top: 0 !important; }
    }
    html { padding-top: 52px; }
</style>
<div id="__asset_print_toolbar">
    <div>👀 打印预览${title ? ' — ' + title : ''}</div>
    <div>
        <button class="btn-print" onclick="window.print()">🖨 打印</button>
        <button class="btn-close" onclick="window.close()">关闭</button>
    </div>
</div>
<script>
    // Ctrl+P 也走 window.print()
    document.addEventListener('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
            e.preventDefault(); window.print();
        }
        if (e.key === 'Escape') { window.close(); }
    });
</script>`;
    // 插到 </head> 之前; 若无 head, 插到 body 开头
    let out = cleanHtml;
    const headIdx = out.lastIndexOf('</head>');
    if (headIdx >= 0) {
        out = out.slice(0, headIdx) + toolbarScript + out.slice(headIdx);
    } else {
        const bodyMatch = out.match(/<body[^>]*>/i);
        if (bodyMatch) {
            const insertAt = bodyMatch.index + bodyMatch[0].length;
            out = out.slice(0, insertAt) + toolbarScript + out.slice(insertAt);
        } else {
            out = toolbarScript + out;
        }
    }
    return out;
}

function openPrintWindow(target) {
    // 识别: {html,title} 对象 → data URL; 纯字符串 → URL
    let url, html = null, title = '';
    if (target && typeof target === 'object' && target.html) {
        html = target.html;
        title = target.title || '';
    } else if (typeof target === 'string') {
        url = target;
    } else {
        return { ok: false, error: 'invalid target' };
    }

    try {
        const isCard = !!html; // 登记卡(HTML字符串) vs 标签(URL)
        const printWin = new BrowserWindow({
            width: isCard ? 820 : 500,
            height: isCard ? 1100 : 720,
            autoHideMenuBar: true,
            title: isCard ? '资产登记卡打印预览' : '资产标签打印预览',
            backgroundColor: '#ffffff',
            webPreferences: { sandbox: false }
        });
        printWin.setMenuBarVisibility(false);
        printWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        printWin.on('closed', () => {});
        printWin.webContents.on('did-fail-load', (ev, code, desc) => {
            console.error('[print] 预览加载失败:', code, desc);
            if (!printWin.isDestroyed()) printWin.close();
        });

        if (isCard) {
            // 登记卡: 注入 toolbar → data URL
            const withToolbar = injectPrintToolbar(html, { title });
            printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(withToolbar));
        } else {
            // 标签: loadURL 后 executeJavaScript 动态注入 toolbar
            printWin.webContents.once('did-finish-load', () => {
                printWin.webContents.executeJavaScript(`
                    (function(){
                        if (document.getElementById('__asset_print_toolbar')) return;
                        const toolbarHtml = ${JSON.stringify(injectPrintToolbar('<div id="__toolbar_marker"></div>', {}))}
                            .replace('<div id="__toolbar_marker"></div>', '');
                        // 移除原来页面里可能存在的自动 print onload
                        const scripts = document.querySelectorAll('script');
                        scripts.forEach(function(s){ if (s.textContent && s.textContent.includes('window.print')) { s.textContent=''; } });
                        // 注入 toolbar
                        const div = document.createElement('div');
                        div.innerHTML = toolbarHtml;
                        while (div.firstChild) document.body.insertBefore(div.firstChild, document.body.firstChild);
                    })();
                `).catch((e) => console.warn('[print] inject toolbar failed:', e.message));
            });
            printWin.loadURL(url);
        }
        printWin.show();
        return { ok: true };
    } catch (e) {
        console.error('[print] openPrintWindow 异常:', e.message);
        return { ok: false, error: e.message };
    }
}

/** 判断 URL 是否为需要在系统浏览器打开的真正外站 */
function isExternalUrl(url) {
    if (!url || url.startsWith('file://') || url.startsWith('data:')) return false;
    return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * 兜底: 旧版前端 window.open('', '_blank') — 主进程监听 browser-window-created,
 * 等到 Chromium 开的新窗口 DOM 稳定(前端 document.write 完成) → 抓 HTML →
 * 关窗口 → 交给 openPrintWindow 预览. 不依赖服务器前端更新
 *
 * 用法: setWindowOpenHandler 里对空 URL return { action: 'allow' };
 *       然后 call bindPrintPopupCapture() 启动 capture 监听.
 */
function bindPrintPopupCapture() {
    let captured = false;
    app.on('browser-window-created', (event, newWin) => {
        const winTitle = newWin.getTitle();
        const winUrl = newWin.webContents.getURL();
        mainLog('[print] browser-window-created fired, title=' + JSON.stringify(winTitle) + ' url=' + JSON.stringify(winUrl) + ' captured=' + captured + ' isMain=' + (newWin === mainWindow));
        if (captured) return;
        if (newWin === mainWindow) return;
        if (winTitle || (winUrl && !/about:blank/.test(winUrl))) { mainLog('[print] skip non-print window'); return; }
        captured = true;
        mainLog('[print] confirmed print popup - will capture HTML');

        const wc = newWin.webContents;
        const tryCapture = async () => {
            try {
                let last = '', stableCount = 0;
                for (let i = 0; i < 80; i++) {
                    await new Promise(r => setTimeout(r, 50));
                    const h = await wc.executeJavaScript(
                        `(document.body && document.body.innerHTML || '').length > 10 ? document.documentElement.outerHTML : ''`
                    ).catch(() => '');
                    if (h.length < 10) continue;
                    if (h === last) { stableCount++; if (stableCount >= 2) { last = h; break; } }
                    else { stableCount = 0; last = h; }
                }
                mainLog('[print] captured HTML length=' + last.length + ' hasCard=' + last.includes('行政联|财务联|打印预览') + ' snippet=' + JSON.stringify(last.slice(0, 80)));
                if (!last) { mainLog('[print] 没抓到 HTML'); return; }
                if (!newWin.isDestroyed()) { try { newWin.destroy(); } catch(_){} }
                mainLog('[print] calling openPrintWindow...');
                openPrintWindow({ html: last, title: '资产登记卡' });
            } catch (e) {
                mainLog('[print] capture 异常:' + e.message);
            }
        };

        wc.on('did-finish-load', tryCapture);
        setTimeout(() => {
            if (captured && !newWin.isDestroyed()) {
                mainLog('[print] 4s timeout - tryCapture again');
                tryCapture();
                setTimeout(() => { if (!newWin.isDestroyed()) newWin.destroy(); }, 500);
            }
        }, 4000);
    });
}

/** 注册全局 browser-window-created 监听(只注册一次, 在 app.whenReady 后调用) */
function ensurePrintCaptureBound() {
    // 幂等: 用一个标记避免重复注册
    if (global.__printCaptureBound) return;
    global.__printCaptureBound = true;
    bindPrintPopupCapture();
}

/** 客户端模式失败兜底:本次启动强制单机(不改动任何已保存设置) */
let forceStandaloneOnce = false;
let switchingToStandalone = false;   // cs-standalone 切换中: 抑制 window-all-closed 的 app.quit() (否则销毁旧窗口会闪退)

/**
 * ============ C/S 客户端模式配置 ============
 * 两种配置来源(优先级从高到低):
 *   1) 应用内"连接服务器设置"(保存在用户数据目录 connection.json)——界面操作, 零手工文件;
 *   2) exe 旁(或安装目录) server.config.json —— 管理员预配置, 保持向后兼容:
 *          { "serverUrl": "http://192.168.1.100:3456" }
 * 客户端模式:窗口直接加载服务端页面,本地不启动 HTTP 服务器、不读写任何数据目录;
 * 单机模式:内嵌服务器 + 本地数据目录(原有行为)。
 *
 * resolveServerConfig() 返回:
 *   { serverUrl, source }  客户端模式( source: 'app' | 'file' )
 *   { invalid, source }    配置存在但无效
 *   null                   单机模式
 */

function getExeDir() {
    try {
        return process.env.PORTABLE_EXECUTABLE_DIR
            || (app.isPackaged ? path.dirname(app.getPath('exe')) : APP_DIR);
    } catch (_) {
        return APP_DIR;
    }
}

function normalizeServerUrl(raw) {
    const url = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
    return /^https?:\/\/.+/i.test(url) ? url : '';
}

/** 读取 exe 旁 server.config.json(管理员预配置, 旧机制, 向后兼容) */
function loadServerConfig() {
    const configPath = path.join(getExeDir(), 'server.config.json');
    if (!fs.existsSync(configPath)) return null;

    try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const url = normalizeServerUrl(cfg.serverUrl);
        if (url) {
            console.log(`[客户端模式] 检测到 server.config.json,连接服务端: ${url}`);
            return { serverUrl: url, source: 'file' };
        }
        console.error(`[客户端模式] ${configPath} 中的 serverUrl 无效: "${url}"`);
        return { invalid: true, source: 'file' };
    } catch (e) {
        console.error(`[客户端模式] 解析 ${configPath} 失败: ${e.message}`);
        return { invalid: true, source: 'file' };
    }
}

/** 应用内连接设置文件: { mode:'client'|'standalone', serverUrl, savedAt } */
function userConnectionPath() {
    return path.join(app.getPath('userData'), 'connection.json');
}

function readUserConnection() {
    const p = userConnectionPath();
    if (!fs.existsSync(p)) return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) {
        console.error(`[连接设置] 解析 ${p} 失败: ${e.message}`);
        return { mode: 'invalid' };
    }
}

function writeUserConnection(cfg) {
    writeFileAtomic(userConnectionPath(), JSON.stringify(cfg, null, '    '), 'utf-8');
}

/** 汇总两种来源, 得出本次启动的运行模式(应用内设置优先于 exe 旁文件) */
function resolveServerConfig() {
    const userCfg = readUserConnection();
    if (userCfg) {
        if (userCfg.mode === 'client') {
            const url = normalizeServerUrl(userCfg.serverUrl);
            if (url) return { serverUrl: url, source: 'app' };
            return { invalid: true, source: 'app' };
        }
        if (userCfg.mode === 'standalone') return null;
        return { invalid: true, source: 'app' };
    }
    return loadServerConfig();
}

/** 主进程侧探测服务端可用性(GET /api/ping, 3.5s 超时; 兼容自签证书场景) */
function probeServer(url, timeoutMs = 3500) {
    return new Promise((resolve) => {
        let target;
        try {
            target = new URL(url + '/api/ping');
        } catch (_) {
            resolve({ ok: false, message: '地址格式无效' });
            return;
        }
        const mod = target.protocol === 'https:' ? https : http;
        const req = mod.get(target, { timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    resolve({ ok: false, message: `服务端响应异常: HTTP ${res.statusCode}` });
                    return;
                }
                try {
                    const data = JSON.parse(body);
                    if (data && data.success === false) {
                        resolve({ ok: false, message: '服务端返回失败: ' + (data.message || '未知原因') });
                        return;
                    }
                } catch (_) { /* 非 JSON 响应但 HTTP 200, 亦视为可达 */ }
                resolve({ ok: true, message: '连接成功' });
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, message: '连接超时(3.5 秒无响应)' }); });
        req.on('error', (e) => resolve({ ok: false, message: '无法连接: ' + e.message }));
    });
}

/**
 * ============ 客户端在线更新模块(仅 C/S 客户端模式) ============
 * 版本源: 所连 C/S 服务器的 /downloads/client-update.json (静态文件, 服务端零改动)
 *   { "version": "3.7.1", "url": "...", "notes": "...", "sha256": "...", "publishedAt": "..." }
 * 流程: 启动 6 秒后静默检查(失败忽略) / 菜单手动检查 → 有新版弹窗询问 →
 *       下载到临时目录(setProgressBar 进度) → SHA256 校验 → 自替换原 exe → 拉起新版并退出。
 * 便携版运行时 process.execPath 指向 %TEMP% 解压目录, 原 exe 路径必须用
 * PORTABLE_EXECUTABLE_FILE(stub 注入的完整路径) 还原(无此环境变量时回退 getPath('exe'))。
 */
const UPDATE_CFG = {
    jsonPath: '/downloads/client-update.json',   // 版本描述文件(相对服务器 origin)
    exeName: 'asset-mgmt-client.exe',            // 服务器上的固定文件名
    checkDelayMs: 6000,                          // 客户端窗口加载成功后延迟静默检查
    checkTimeoutMs: 5000,                        // 版本检查超时
    downloadTimeoutMs: 120000,                   // 下载空闲超时
    tmpName: 'asset-mgmt-client.update.exe'      // 临时下载文件名(%TEMP% 下, 启动时清理)
};
let updateServerOrigin = null;   // 当前 C/S 服务器 origin; 单机模式为 null → 菜单提示不支持
let updateRunning = false;       // 更新流程进行中(防重复触发)

/** 原始 exe 完整路径(分发到用户手里的那个 exe) */
function getOriginalExePath() {
    // 便携版: stub(portable.nsi) 注入 PORTABLE_EXECUTABLE_FILE = 分发 exe 的完整路径。
    // 注意不能取 app.getPath('exe') —— 那是 %TEMP% 解压目录里的内部 exe, 替换它会在
    // 下次启动时被 stub 重新解压覆盖(更新丢失), 且解压目录名确定会引发无限重生循环。
    if (process.env.PORTABLE_EXECUTABLE_FILE) {
        return process.env.PORTABLE_EXECUTABLE_FILE;
    }
    try { return app.getPath('exe'); } catch (_) { return process.execPath; }
}

/** 更新调试日志(独立文件, 便于排查用户端更新问题) */
function updateLog(msg) {
    console.log('[更新] ' + msg);
    try { fs.appendFileSync(path.join(os.tmpdir(), 'asset-update.log'), '[' + new Date().toISOString() + '] ' + msg + '\n', 'utf8'); } catch (_) {}
}

/** 启动清理: 上次自替换残留的 <exe>.old 备份与 %TEMP% 下载临时文件 */
function cleanupUpdateResidue() {
    try {
        const oldPath = getOriginalExePath() + '.old';
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    } catch (_) { /* 上个实例可能仍占用, 下次启动再清 */ }
    try {
        const tmp = path.join(os.tmpdir(), UPDATE_CFG.tmpName);
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) {}
}

/** 版本比较: 按 "." 分段数字比较, a>b→1, a<b→-1, 相等→0; 非法输入返回 -2 */
function compareVersions(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return -2;
    const pa = a.trim().split('.'), pb = b.trim().split('.');
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        const na = parseInt(pa[i], 10) || 0;
        const nb = parseInt(pb[i], 10) || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
    }
    return 0;
}

/** GET 一个 JSON(限时), 任何失败返回 null */
function fetchUpdateJson(origin) {
    return new Promise((resolve) => {
        let target;
        try { target = new URL(origin + UPDATE_CFG.jsonPath); } catch (_) { return resolve(null); }
        const mod = target.protocol === 'https:' ? https : http;
        const req = mod.request({
            method: 'GET',
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + target.search,
            headers: { 'User-Agent': 'AssetManager-Desktop/1.0', 'Cache-Control': 'no-cache' },
            timeout: UPDATE_CFG.checkTimeoutMs,
            rejectUnauthorized: false
        }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return resolve(null); }
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.end();
    });
}

/** 下载文件到 destPath(跟随一次重定向), onProgress(0~1), 成功 resolve 实际 URL */
function downloadUpdateFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        let target;
        try { target = new URL(url); } catch (_) { return reject(new Error('下载地址无效: ' + url)); }
        const mod = target.protocol === 'https:' ? https : http;
        const req = mod.request({
            method: 'GET',
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + target.search,
            headers: { 'User-Agent': 'AssetManager-Desktop/1.0' },
            timeout: UPDATE_CFG.downloadTimeoutMs,
            rejectUnauthorized: false
        }, (res) => {
            // 跟随一次重定向(nginx 直链一般 200, 这里兜底)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                const next = new URL(res.headers.location, url).toString();
                return downloadUpdateFile(next, destPath, onProgress).then(resolve, reject);
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('下载失败: HTTP ' + res.statusCode)); }
            const total = parseInt(res.headers['content-length'], 10) || 0;
            let received = 0;
            const out = fs.createWriteStream(destPath);
            out.on('error', reject);
            res.on('data', (c) => {
                received += c.length;
                if (onProgress && total > 0) { try { onProgress(received / total); } catch (_) {} }
            });
            res.pipe(out);
            out.on('finish', () => out.close(() => resolve(url)));
        });
        req.on('timeout', () => req.destroy(new Error('下载超时(连接无数据)')));
        req.on('error', reject);
        req.end();
    });
}

/** 计算文件 SHA256(流式) */
function sha256File(p) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const s = fs.createReadStream(p);
        s.on('data', (d) => hash.update(d));
        s.on('end', () => resolve(hash.digest('hex')));
        s.on('error', reject);
    });
}

/**
 * 自替换原 exe 并重启。
 * 便携版 stub 存活期间持有自身 exe 句柄(EBUSY), 无法运行中改名/覆盖;
 * 且 stub 退出时的进程树清理会杀掉本应用 spawn 的任何辅助进程(实测 detached 也被杀)。
 * 因此: 写一个 UTF-16LE 的 .vbs 辅助脚本(规避中文路径编码坑), 通过 explorer.exe
 * 代为启动(wscript 由外部进程 explorer 创建, 彻底脱离应用进程树)。
 * 辅助逻辑: 轮询等待原 exe 可写(stub 退出) → 覆盖 → 拉起新版 → 写结果日志。
 * 失败时原 exe 原样保留(仅丢弃下载临时文件), 旧版可继续使用。
 */
function selfReplaceAndRestart(newExePath) {
    const original = getOriginalExePath();
    const vbs = [
        'Dim sh, fso, deadline, ok, orig, tmp, old',
        'Set sh = CreateObject("WScript.Shell")',
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        `orig = "${original}"`,
        `tmp = "${newExePath}"`,
        'old = orig & ".old"',
        'deadline = Now + 30/86400',
        'ok = False',
        'On Error Resume Next',
        'Do While Now < deadline And Not ok',
        '    Err.Clear',
        '    If fso.FileExists(old) Then fso.DeleteFile old, True',
        '    Err.Clear',
        '    fso.MoveFile orig, old',
        '    If Err.Number = 0 Then',
        '        Err.Clear',
        '        fso.MoveFile tmp, orig',
        '        If Err.Number = 0 Then',
        '            ok = True',
        '        Else',
        '            fso.MoveFile old, orig',
        '        End If',
        '    End If',
        '    If Not ok Then WScript.Sleep 500',
        'Loop',
        'Dim logPath, logStream',
        'logPath = sh.ExpandEnvironmentStrings("%TEMP%") & "\\asset-update.log"',
        'Set logStream = fso.OpenTextFile(logPath, 8, True)',
        'If ok Then',
        `    sh.Run Chr(34) & "${original}" & Chr(34), 1, False`,
        '    logStream.WriteLine "[" & Now & "] 替换完成, 已重启新版本"',
        'Else',
        '    logStream.WriteLine "[" & Now & "] 替换失败: 30秒内原文件仍被占用, 保留旧版本"',
        'End If',
        'logStream.Close'
    ].join('\r\n');
    const vbsPath = path.join(os.tmpdir(), 'asset-update-helper.vbs');
    try {
        // UTF-16LE + BOM: wscript 依 BOM 识别 Unicode, 中文路径/日志不乱码
        fs.writeFileSync(vbsPath, '\ufeff' + vbs, 'utf16le');
    } catch (e) {
        updateLog('写辅助脚本失败: ' + e.message);
        throw new Error('无法写更新辅助脚本: ' + e.message);
    }
    updateLog('经 explorer 启动替换辅助脚本: ' + vbsPath);
    try {
        // explorer 是外部常驻进程, 由它代启 wscript → 新进程不属于本应用进程树, 不会被带走
        const child = spawn('explorer.exe', [vbsPath], { detached: true, stdio: 'ignore' });
        child.unref();
    } catch (e) {
        updateLog('辅助脚本启动失败: ' + e.message);
        throw new Error('无法启动替换辅助脚本: ' + e.message);
    }
    // 给 explorer 分发一点时间后退出, 让 stub 释放原 exe 文件
    setTimeout(() => app.exit(0), 1500);
}

function setUpdateOrigin(origin) { updateServerOrigin = origin || null; }

function getUpdateProgressWindow() {
    return (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
}

/** 下载 + 校验 + 替换 + 重启(调用前已确认) */
async function downloadAndApplyUpdate(info) {
    const url = /^https?:\/\//i.test(String(info.url || ''))
        ? String(info.url)
        : updateServerOrigin + '/downloads/' + UPDATE_CFG.exeName;
    const tmp = path.join(os.tmpdir(), UPDATE_CFG.tmpName);
    const win = getUpdateProgressWindow();
    updateRunning = true;
    try {
        updateLog('开始下载: ' + url);
        if (win) win.setProgressBar(0);
        await downloadUpdateFile(url, tmp, (frac) => {
            const w = getUpdateProgressWindow();
            if (w) w.setProgressBar(Math.min(1, Math.max(0, frac)));
        });
        const w2 = getUpdateProgressWindow();
        if (w2) w2.setProgressBar(-1);
        updateLog('下载完成: ' + fs.statSync(tmp).size + ' bytes');
        if (info.sha256) {
            const actual = await sha256File(tmp);
            if (actual.toLowerCase() !== String(info.sha256).toLowerCase().trim()) {
                try { fs.unlinkSync(tmp); } catch (_) {}
                throw new Error('新版本文件校验失败(SHA256 不匹配), 已取消更新。');
            }
            updateLog('SHA256 校验通过');
        }
        selfReplaceAndRestart(tmp);
    } catch (e) {
        updateRunning = false;
        const w3 = getUpdateProgressWindow();
        if (w3) w3.setProgressBar(-1);
        try { fs.unlinkSync(tmp); } catch (_) {}
        updateLog('更新失败: ' + e.message);
        dialog.showMessageBox({
            type: 'error',
            title: '更新失败',
            message: '更新失败',
            detail: e.message,
            buttons: ['确定'],
            noLink: true
        });
    }
}

/** 拿到新版信息后统一走这里: 弹窗询问 → 下载应用 */
async function promptAndApplyUpdate(info) {
    if (updateRunning) return;
    const cur = app.getVersion();
    const r = await dialog.showMessageBox({
        type: 'info',
        title: '发现新版本',
        message: `发现新版本 v${info.version}(当前 v${cur})`,
        detail: (info.notes ? String(info.notes) + '\n\n' : '')
            + '将下载新版本并自动重启应用完成升级。',
        buttons: ['立即更新', '暂不更新'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
    });
    if (r.response !== 0) return;
    await downloadAndApplyUpdate(info);
}

/** 静默检查(启动后自动触发): 任何失败都不打扰用户 */
async function silentCheckForUpdate() {
    if (!app.isPackaged) return;               // dev 环境严禁自替换 electron.exe
    if (!updateServerOrigin || updateRunning) return;
    try {
        const info = await fetchUpdateJson(updateServerOrigin);
        if (!info || !info.version) return;
        if (compareVersions(String(info.version), app.getVersion()) > 0) {
            updateLog(`静默检查发现新版本 ${info.version}(当前 ${app.getVersion()}), 弹窗询问`);
            await promptAndApplyUpdate(info);
        } else {
            updateLog(`静默检查: 已是最新(${app.getVersion()})`);
        }
    } catch (_) { /* 静默失败 */ }
}

/** 手动检查(菜单入口): 有明确结果提示 */
async function manualCheckForUpdate() {
    if (!app.isPackaged) {
        dialog.showMessageBox({ type: 'info', title: '检查更新', message: '开发环境不支持在线更新', buttons: ['确定'], noLink: true });
        return;
    }
    if (!updateServerOrigin) {
        dialog.showMessageBox({
            type: 'info',
            title: '检查更新',
            message: '当前为单机模式, 不支持在线更新',
            detail: '在线更新仅在"客户端模式"(连接服务器)下可用。\n可通过菜单"设置 → 连接服务器设置…"切换到客户端模式。',
            buttons: ['确定'],
            noLink: true
        });
        return;
    }
    if (updateRunning) {
        dialog.showMessageBox({ type: 'info', title: '检查更新', message: '更新正在进行中, 请稍候', buttons: ['确定'], noLink: true });
        return;
    }
    const info = await fetchUpdateJson(updateServerOrigin);
    if (!info || !info.version) {
        dialog.showMessageBox({
            type: 'warning',
            title: '检查更新',
            message: '无法获取更新信息',
            detail: `无法连接更新源: ${updateServerOrigin}${UPDATE_CFG.jsonPath}\n请检查网络连接或稍后重试。`,
            buttons: ['确定'],
            noLink: true
        });
        return;
    }
    if (compareVersions(String(info.version), app.getVersion()) > 0) {
        await promptAndApplyUpdate(info);
    } else {
        dialog.showMessageBox({
            type: 'info',
            title: '检查更新',
            message: `当前已是最新版本 v${app.getVersion()}`,
            buttons: ['确定'],
            noLink: true
        });
    }
}

/**
 * 应用菜单:仅一个"连接设置"入口。
 * 菜单栏默认隐藏(Alt 键临时显示), 保证窗口整洁的同时保留应用内切换模式的入口。
 */
function buildAppMenu() {
    return Menu.buildFromTemplate([
        {
            label: '设置',
            submenu: [
                {
                    label: '连接服务器设置…',
                    accelerator: 'CmdOrCtrl+Alt+S',
                    click: () => { createConnectionWindow(); }
                },
                { type: 'separator' },
                {
                    label: '检查更新',
                    click: () => { manualCheckForUpdate(); }
                }
            ]
        }
    ]);
}

let connectionWindow = null;

/** 连接设置窗口(加载本地 connection.html, 不依赖服务端) */
function createConnectionWindow() {
    if (connectionWindow && !connectionWindow.isDestroyed()) {
        connectionWindow.focus();
        return;
    }
    const hasMain = mainWindow && !mainWindow.isDestroyed();
    connectionWindow = new BrowserWindow({
        width: 540,
        height: 680,
        resizable: true,
        minimizable: false,
        maximizable: true,
        title: '连接服务器设置',
        parent: hasMain ? mainWindow : null,
        modal: hasMain,
        webPreferences: {
            preload: path.join(APP_DIR, 'connection-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });
    connectionWindow.setMenuBarVisibility(false);
    connectionWindow.on('closed', () => { connectionWindow = null; });
    connectionWindow.loadFile(path.join(APP_DIR, 'connection.html'));
}

/** 连接设置 IPC:读取/测试/保存/清除/应用重启 */
function registerConnectionIpc() {
    ipcMain.handle('conn:get', () => {
        const userCfg = readUserConnection();
        return {
            mode: userCfg ? (userCfg.mode === 'client' ? 'client' : (userCfg.mode === 'standalone' ? 'standalone' : 'invalid')) : null,
            serverUrl: userCfg && userCfg.serverUrl ? String(userCfg.serverUrl) : '',
            appSettingExists: !!userCfg,
            fileConfigExists: fs.existsSync(path.join(getExeDir(), 'server.config.json'))
        };
    });

    ipcMain.handle('conn:test', (_e, rawUrl) => {
        const url = normalizeServerUrl(rawUrl);
        if (!url) return { ok: false, message: '地址格式无效, 应为 http://服务器IP:端口' };
        return probeServer(url);
    });

    ipcMain.handle('conn:save', (_e, cfg) => {
        const mode = cfg && cfg.mode === 'client' ? 'client' : 'standalone';
        if (mode === 'client') {
            const url = normalizeServerUrl(cfg && cfg.serverUrl);
            if (!url) return { ok: false, message: '地址格式无效, 应为 http://服务器IP:端口' };
            writeUserConnection({ mode, serverUrl: url, savedAt: new Date().toISOString() });
            console.log(`[连接设置] 已保存: 客户端模式 ${url}`);
        } else {
            writeUserConnection({ mode, savedAt: new Date().toISOString() });
            console.log('[连接设置] 已保存: 单机模式');
        }
        return { ok: true, file: userConnectionPath() };
    });

    ipcMain.handle('conn:clear', () => {
        try { fs.unlinkSync(userConnectionPath()); } catch (_) { /* 文件不存在 */ }
        console.log('[连接设置] 已清除应用内设置(恢复按 exe 旁 server.config.json / 默认单机)');
        return { ok: true };
    });

    ipcMain.handle('conn:apply', () => {
        // 保存后重启应用使新模式生效; quit 会触发 before-quit 优雅关闭内嵌服务器
        app.relaunch();
        app.quit();
        return { ok: true };
    });

    // ============ 资产登记卡原生打印(不走浏览器) ============
    ipcMain.handle('printCard', (_e, html) => {
        try {
            mainLog('[print] printCard IPC called, html len=' + (html ? html.length : 0));
            if (typeof html !== 'string' || !html.trim()) return { ok: false, error: 'empty html' };
            const result = openPrintWindow({ html: html, title: '资产登记卡' });
            mainLog('[print] openPrintWindow result = ' + JSON.stringify(result));
            if (!result || !result.ok) return { ok: false, error: result && result.error || 'open fail' };
            return { ok: true };
        } catch (err) {
            mainLog('[print] printCard 异常:' + err.message);
            return { ok: false, error: err.message };
        }
    });

    // ============ 服务端信息 + 数据同步 ============

    /** HTTP 请求工具(返回 { status, data, text, error }) */
    async function httpJson(method, url, opts) {
        opts = opts || {};
        let target;
        try { target = new URL(url); } catch (e) { return { error: '地址格式无效: ' + e.message }; }
        const mod = target.protocol === 'https:' ? https : http;
        const headers = { 'User-Agent': 'AssetManager-Desktop/1.0' };
        if (opts.auth) headers['Authorization'] = 'Bearer ' + opts.auth;
        if (opts.body) { headers['Content-Type'] = 'application/json; charset=utf-8'; }
        return new Promise((resolve) => {
            const req = mod.request({
                method,
                hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
                path: target.pathname + target.search, headers,
                timeout: opts.timeoutMs || 8000, rejectUnauthorized: false
            }, (res) => {
                let body = '';
                res.setEncoding('utf-8');
                res.on('data', (c) => { body += c; if (body.length > 5 * 1024 * 1024) req.destroy(); });
                res.on('end', () => {
                    let data = null;
                    try { data = JSON.parse(body); } catch (_) { /* 不是 JSON */ }
                    resolve({ status: res.statusCode, data, text: body });
                });
            });
            req.on('error', (e) => resolve({ error: e.message || String(e) }));
            req.on('timeout', () => { req.destroy(); resolve({ error: '请求超时' }); });
            if (opts.body) req.write(opts.body);
            req.end();
        });
    }

    /** 同步的 7 个数据键(资产全量 + 6 个自定义选项, 排除 userStateData 等个人状态) */
    const SYNC_KEYS = [
        'assetManagementData',
        'custom_options_owner', 'custom_options_owner_deleted',
        'custom_options_type', 'custom_options_type_deleted',
        'custom_options_department', 'custom_options_department_deleted',
    ];

    /** 服务端信息(免鉴权 /api/info) */
    ipcMain.handle('conn:serverInfo', async (_e, rawUrl) => {
        const url = normalizeServerUrl(rawUrl);
        if (!url) return { ok: false, message: '服务器地址无效' };
        const res = await httpJson('GET', url + '/api/info');
        if (res.error) return { ok: false, message: '连接失败: ' + res.error };
        if (res.status !== 200 || !res.data || !res.data.success) {
            return { ok: false, message: (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status) };
        }
        const info = res.data;
        return { ok: true, info: {
            name: info.name || '-', version: info.version || '-',
            dbPath: info.dbPath || '-', serverTime: info.serverTime || '-',
            cs: !!info.cs
        } };
    });

    /** 辅助: 登录服务端拿 JWT */
    async function loginServer(baseUrl, username, password) {
        if (!baseUrl || !username || !password) return { error: '请填写服务器地址、用户名和密码' };
        const body = JSON.stringify({ username: String(username).trim(), password: String(password) });
        const res = await httpJson('POST', baseUrl + '/api/auth/login', { body });
        if (res.error) return { error: '连接失败: ' + res.error };
        if (res.status !== 200 || !res.data || res.data.code !== 0 || !res.data.data || !res.data.data.token) {
            const msg = (res.data && (res.data.message || res.data.error)) || ('登录失败 (HTTP ' + res.status + ')');
            return { error: msg };
        }
        return { token: res.data.data.token };
    }

    /** 写入本地 .json + .js 双文件(与内嵌服务器 /api/save 逻辑一致) */
    function writeLocalDataKey(dataDir, key, value) {
        const jsonPath = path.join(dataDir, key + '.json');
        const jsPath = path.join(dataDir, key + '.js');
        const jsonStr = JSON.stringify(value, null, 2);
        const jsContent = `// ${key} 数据文件(本地模式)\n` +
            `// 此文件由系统自动维护,请勿手动编辑\n` +
            `// 最后更新: ${new Date().toISOString()}\n` +
            `window.__LOCAL_DATA__ = window.__LOCAL_DATA__ || {};\n` +
            `window.__LOCAL_DATA__.${key} = ${jsonStr};\n`;
        fs.writeFileSync(jsonPath, jsonStr, 'utf-8');
        fs.writeFileSync(jsPath, jsContent, 'utf-8');
    }

    /** 读取本地 .json 文件(.js 只是 JSONP 包装, 直接读 .json) */
    function readLocalDataKey(dataDir, key) {
        const jsonPath = path.join(dataDir, key + '.json');
        if (fs.existsSync(jsonPath)) {
            try { return JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); }
            catch (e) { console.warn('[sync] 读取本地 ' + key + '.json 失败:', e.message); }
        }
        // 退回到 .js 文件解析
        const jsPath = path.join(dataDir, key + '.js');
        if (fs.existsSync(jsPath)) {
            try {
                const js = fs.readFileSync(jsPath, 'utf-8');
                const m = js.match(/window\.__LOCAL_DATA__\.[A-Za-z0-9_]+\s*=\s*([\s\S]*?);?\s*$/);
                if (m) return JSON.parse(m[1]);
            } catch (e) { console.warn('[sync] 读取本地 ' + key + '.js 失败:', e.message); }
        }
        return null;
    }

    /** 服务端 → 本地同步 */
    ipcMain.handle('conn:syncPull', async (_e, payload) => {
        const url = normalizeServerUrl(payload && payload.url);
        if (!url) return { ok: false, message: '服务器地址无效' };
        const login = await loginServer(url, payload && payload.username, payload && payload.password);
        if (login.error) return { ok: false, message: login.error };
        const token = login.token;
        const dataDir = getPortableDataDir();
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

        const pulled = {};
        const errors = [];
        let totalAssets = 0;
        for (const key of SYNC_KEYS) {
            const res = await httpJson('GET', url + '/api/load?key=' + encodeURIComponent(key), { auth: token });
            if (res.error) { errors.push(key + ': ' + res.error); continue; }
            if (res.status !== 200 || !res.data || !res.data.success) {
                errors.push(key + ': ' + ((res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status)));
                continue;
            }
            const value = res.data.data;
            pulled[key] = Array.isArray(value) ? value.length : 1;
            if (key === 'assetManagementData' && Array.isArray(value)) totalAssets = value.length;
            writeLocalDataKey(dataDir, key, value);
            console.log('[sync] pull ' + key + ': ' + pulled[key] + ' 条');
        }

        // 顺带拿服务端信息显示
        const infoRes = await httpJson('GET', url + '/api/info');
        const serverInfo = (infoRes.data && infoRes.data.success) ? infoRes.data : {};

        const ok = errors.length === 0;
        return { ok, pulled, errors, totalAssets, serverInfo: { name: serverInfo.name, version: serverInfo.version } };
    });

    /** 本地 → 服务端同步(全量替换) */
    ipcMain.handle('conn:syncPush', async (_e, payload) => {
        const url = normalizeServerUrl(payload && payload.url);
        if (!url) return { ok: false, message: '服务器地址无效' };
        const login = await loginServer(url, payload && payload.username, payload && payload.password);
        if (login.error) return { ok: false, message: login.error };
        const token = login.token;
        const dataDir = getPortableDataDir();

        const pushed = {};
        const errors = [];
        let totalAssets = 0;
        for (const key of SYNC_KEYS) {
            const value = readLocalDataKey(dataDir, key);
            if (value === null || value === undefined) {
                console.log('[sync] push 跳过 ' + key + ': 本地无数据');
                continue;
            }
            const body = JSON.stringify({ key, value });
            const res = await httpJson('POST', url + '/api/save?key=' + encodeURIComponent(key), { auth: token, body });
            if (res.error) { errors.push(key + ': ' + res.error); continue; }
            if (res.status !== 200 || !res.data || !res.data.success) {
                errors.push(key + ': ' + ((res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status)));
                continue;
            }
            pushed[key] = res.data.count || (Array.isArray(value) ? value.length : 1);
            if (key === 'assetManagementData' && Array.isArray(value)) totalAssets = value.length;
            console.log('[sync] push ' + key + ': ' + pushed[key] + ' 条');
        }

        const infoRes = await httpJson('GET', url + '/api/info');
        const serverInfo = (infoRes.data && infoRes.data.success) ? infoRes.data : {};

        const ok = errors.length === 0;
        return { ok, pushed, errors, totalAssets, serverInfo: { name: serverInfo.name, version: serverInfo.version } };
    });
}

/**
 * 客户端模式连接失败页(内联,主进程 data: URL 渲染): 重新连接 / 修改设置 / 改用单机
 * 额外场景: 远程 API 正常但前端静态文件缺失(源码部署漏传前端)
 */
function clientErrorPageHtml(serverUrl, reason, hint) {
    const msg = JSON.stringify(String(reason || '无法连接服务器'));
    const hintHtml = hint ? '<p style="margin-top:8px;font-size:12px;color:#b45309;background:#fef3c7;padding:8px 12px;border-radius:6px;text-align:left">' + String(hint).replace(/[<>&"]/g, '') + '</p>' : '';
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>连接失败 - 固定资产管理系统</title>'
        + '<style>body{font-family:"Microsoft YaHei",sans-serif;background:#f5f7fa;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}'
        + '.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:40px 48px;max-width:560px;box-shadow:0 8px 24px rgba(0,0,0,.06);text-align:center}'
        + 'h1{font-size:20px;color:#1f2937;margin:0 0 12px}p{color:#6b7280;font-size:14px;line-height:1.8;margin:6px 0}'
        + 'code{background:#f3f4f6;padding:2px 8px;border-radius:4px;font-size:13px;word-break:break-all}'
        + '.row{margin-top:20px;display:flex;gap:12px;justify-content:center}'
        + 'button{padding:10px 20px;border-radius:8px;font-size:14px;cursor:pointer;border:1px solid #d1d5db;background:#fff;color:#374151}'
        + 'button.primary{background:#3081eb;border-color:#3081eb;color:#fff}'
        + '</style></head><body><div class="card"><h1>无法连接服务器</h1>'
        + '<p>' + msg + '</p>'
        + '<p>服务端地址: <code>' + String(serverUrl).replace(/[<>&"]/g, '') + '</code></p>'
        + hintHtml
        + '<div class="row">'
        + '<button class="primary" id="retry">重新连接</button>'
        + '<button id="settings">修改连接设置</button>'
        + '<button id="standalone">改用单机模式</button>'
        + '</div>'
        + '<p style="margin-top:16px;font-size:12px;color:#9ca3af">也可以在应用内按 Alt 键显示菜单,选择"连接服务器设置"</p>'
        + '</div>'
        + '<script>'
        + 'document.getElementById("retry").addEventListener("click",function(){location.href="cs-retry://go";});'
        + 'document.getElementById("settings").addEventListener("click",function(){location.href="cs-settings://go";});'
        + 'document.getElementById("standalone").addEventListener("click",function(){location.href="cs-standalone://go";});'
        + '</script></body></html>';
}

/** 客户端模式预检: 检测远程 API 是否在线 + 前端静态文件是否部署完整 */
function probeClientServer(serverUrl) {
    return new Promise((resolve) => {
        let target;
        try { target = new URL(serverUrl); } catch (_) { resolve({ ok: false, apiOk: false, staticOk: false, error: '服务器地址格式无效' }); return; }
        const mod = target.protocol === 'https:' ? https : http;
        const probe = (path) => new Promise((r) => {
            const req = mod.request({ hostname: target.hostname, port: target.port || 80, path, method: 'GET', timeout: 5000 }, (res) => {
                // 消耗响应体以免触发 socket hang up
                res.resume();
                res.on('end', () => r(res.statusCode || 0));
            });
            req.on('error', () => r(0));
            req.on('timeout', () => { req.destroy(); r(0); });
            req.end();
        });
        Promise.all([probe('/api/info'), probe('/login.html')]).then(([apiCode, staticCode]) => {
            const apiOk = apiCode === 200;
            // 静态文件 200/302 算 OK, 4xx 算缺失
            const staticOk = staticCode >= 200 && staticCode < 400;
            let ok = apiOk && staticOk;
            let error = '';
            let hint = '';
            if (!apiOk && !staticOk) {
                error = '网络连接失败 (DNS/防火墙/服务端未启动)';
            } else if (!apiOk) {
                error = '服务端 API 无响应 (HTTP ' + apiCode + ')';
            } else if (!staticOk) {
                // API 正常但静态文件 404 —— 前端未部署
                error = '远程 API 正常，但前端页面返回 HTTP ' + staticCode;
                hint = '常见原因: 服务端源码部署时只上传了 server/ 目录, 前端文件(index.html、login.html、js/、libs/、styles.css)未部署到 ' + target + ' 的上一级目录。\n临时修复: 将项目根目录的 index.html / login.html / styles.css / js/ / libs/ / asset_label_print.html 上传到服务器的项目根目录(与 server/ 平级)。\n长期方案: 用 pkg 打包成 asset-server.exe, 前端文件会自动内嵌。';
            }
            resolve({ ok, apiOk, staticOk, error, hint });
        });
    });
}

/**
 * C/S 客户端模式:直接加载远程服务端页面。
 * 前端与 API 同源(登录守卫/JWT 均由服务端页面处理),本地零数据落盘。
 */
async function createClientWindow(serverConfig) {
    const serverUrl = serverConfig.serverUrl;

    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1024,
        minHeight: 680,
        title: '固定资产管理系统 - 正在连接服务端...',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            preload: path.join(APP_DIR, 'connection-preload.js')
        }
    });

    Menu.setApplicationMenu(buildAppMenu());
    mainWindow.setMenuBarVisibility(false);
    mainWindow.on('page-title-updated', (event, title) => {
        event.preventDefault();
        if (mainWindow && title) {
            mainWindow.setTitle(title);
        }
    });

    // 外部链接在系统默认浏览器中打开(本地打印页走 Electron 预览窗口)
    ensurePrintCaptureBound();
    mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
        if (/asset_label_print\.html/i.test(targetUrl)) { openPrintWindow(targetUrl); return { action: 'deny' }; }
        if (!targetUrl || targetUrl === 'about:blank') { return { action: 'allow' }; } // 给 capture 逻辑处理
        if (isExternalUrl(targetUrl)) shell.openExternal(targetUrl);
        return { action: 'deny' };
    });

    // 连接失败(非主动打断)→ 渲染内联错误页;错误页按钮 → will-navigate 拦截分发
    let currentUrl = serverUrl + '/login.html';
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDesc, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return; // -3 = ERR_ABORTED(导航被打断,非故障)
        console.error(`[客户端模式] 加载失败: ${validatedURL} (${errorCode} ${errorDesc})`);
        currentUrl = serverUrl + '/login.html';
        mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(clientErrorPageHtml(serverUrl, `错误码 ${errorCode}: ${errorDesc}`)));
    });
    // HTTP 4xx/5xx 不算 did-fail-load,用 session.webRequest 拦截(Electron ≥23 已废弃 webContents.webRequest)
    try {
        const ses = mainWindow.webContents.session;
        ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
            if (details.resourceType === 'mainFrame' && details.statusCode >= 400 && details.statusCode < 600) {
                const code = details.statusCode;
                console.warn(`[客户端模式] 主框架收到 HTTP ${code}, 拦截并显示友好错误页`);
                const reason = (code === 404)
                    ? '远程页面返回 404 - 文件不存在'
                    : `远程服务器返回 HTTP ${code}`;
                setImmediate(() => {
                    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(clientErrorPageHtml(serverUrl, reason))).catch(() => {});
                });
                callback({ cancel: true });
                return;
            }
            callback({});
        });
    } catch (e) {
        console.warn('[客户端模式] session.webRequest 拦截注册失败:', e.message);
    }
    // 每次导航完成后恢复键盘焦点(兜底: 渲染进程 alert/confirm 同步对话框会破坏输入焦点状态)
    mainWindow.webContents.on('did-finish-load', () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.focus();
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url.startsWith('cs-retry://')) {
            event.preventDefault();
            console.log('[客户端模式] 用户请求重新连接...');
            mainWindow.loadURL(currentUrl).catch(() => {});
        } else if (url.startsWith('cs-settings://')) {
            event.preventDefault();
            console.log('[客户端模式] 打开连接设置...');
            createConnectionWindow();
        } else if (url.startsWith('cs-standalone://')) {
            event.preventDefault();
            console.log('[客户端模式] 用户选择改用单机模式(本次启动生效, 不改动已保存设置)...');
            forceStandaloneOnce = true;
            switchingToStandalone = true;   // 防止旧窗口销毁触发 window-all-closed → app.quit() 闪退
            const win = mainWindow;
            mainWindow = null;
            if (win && !win.isDestroyed()) win.destroy();
            Promise.resolve(startStandaloneMode())
                .catch((e) => console.error('[客户端模式] 切换单机模式失败:', e))
                .finally(() => { switchingToStandalone = false; });
        }
    });

    // 预检远程服务端状态: 先探测再 loadURL, 避免裸显示远程 404 页面
    const probe = await probeClientServer(serverUrl);
    if (!probe.ok) {
        console.warn(`[客户端模式] 预检失败: apiOk=${probe.apiOk} staticOk=${probe.staticOk} error=${probe.error}`);
        const errorPage = clientErrorPageHtml(serverUrl, probe.error, probe.hint);
        await mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorPage));
        return;
    }

    try {
        await mainWindow.loadURL(currentUrl);
    } catch (_) { /* 失败由 did-fail-load / session.webRequest 统一处理 */ }

    // 客户端模式就绪: 记录更新源(服务器 origin), 6 秒后静默检查更新(失败静默忽略)
    setUpdateOrigin(serverUrl);
    setTimeout(() => { silentCheckForUpdate(); }, UPDATE_CFG.checkDelayMs);
    return;
}

/**
 * 应用主窗口入口:解析连接配置, 决定客户端模式 / 单机模式
 */
async function createWindow() {
    // 客户端模式检测(应用内设置优先, 其次 exe 旁 server.config.json)
    const serverConfig = forceStandaloneOnce ? null : resolveServerConfig();
    forceStandaloneOnce = false;

    if (serverConfig && serverConfig.serverUrl) {
        await createClientWindow(serverConfig);
        return;
    }

    // 配置存在但无效 → 弹窗三选, 不再静默回落单机
    if (serverConfig && serverConfig.invalid) {
        const detail = serverConfig.source === 'app'
            ? '应用内保存的连接设置损坏。可重新保存设置, 或清除设置后按 exe 旁 server.config.json / 默认单机启动。'
            : 'exe 旁 server.config.json 格式无效。请修正该文件, 或在连接设置界面改用应用内设置。';
        const r = await dialog.showMessageBox({
            type: 'warning',
            title: '连接配置无效',
            message: '连接配置无效',
            detail,
            buttons: ['修改连接设置', '改用单机模式', '退出'],
            defaultId: 0,
            cancelId: 2,
            noLink: true
        });
        if (r.response === 0) {
            createConnectionWindow();
            return;
        }
        if (r.response === 2) {
            app.quit();
            return;
        }
        // r.response === 1 → 改用单机(本次启动生效)
    }

    await startStandaloneMode();
}

/**
 * ============ 内置完整服务端(asset-server.exe) ============
 * 单机模式优先拉起打包在 resources/ 内的完整服务端(含飞书双向同步/多表/用户体系等),
 * 以 127.0.0.1 + 随机端口 + 一次性 token 的"内嵌免密模式"运行;
 * 找不到 EXE 或启动失败时回退到旧的内嵌精简服务器(JSON 数据, 无飞书)。
 */

/** 定位内置 asset-server.exe: 打包后在 resources/, 开发时在 server/dist/ */
function locateBundledServer() {
    const candidates = [];
    if (app.isPackaged && process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'asset-server.exe'));
    }
    candidates.push(path.join(APP_DIR, 'server', 'dist', 'asset-server.exe'));
    return candidates.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}

/** 申请一个空闲端口 */
function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

/** 探测服务端就绪(/api/ping) */
function waitForServerReady(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tick = () => {
            const req = http.get({
                hostname: '127.0.0.1', port, path: '/api/ping', timeout: 1500
            }, (res) => {
                res.resume();
                if (res.statusCode === 200) return resolve(true);
                if (Date.now() > deadline) return reject(new Error('服务端就绪超时'));
                setTimeout(tick, 300);
            });
            req.on('error', () => {
                if (Date.now() > deadline) return reject(new Error('服务端就绪超时'));
                setTimeout(tick, 300);
            });
            req.on('timeout', () => { req.destroy(); });
        };
        tick();
    });
}

/** 内置服务端诊断日志(写入临时文件, 打包后控制台不可见时排障用) */
function bundledLog(msg) {
    try {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        fs.appendFileSync(path.join(require('os').tmpdir(), 'asset-desktop.log'), line, 'utf8');
    } catch (_) {}
}

/** 拉起内置完整服务端; 成功返回 port, 失败返回 null(调用方回退旧内嵌服务器) */
async function startBundledServer(dataDir) {
    const exePath = locateBundledServer();
    bundledLog('locateBundledServer => ' + (exePath || 'null') + ' (isPackaged=' + app.isPackaged + ', resourcesPath=' + (process.resourcesPath || '-') + ')');
    if (!exePath) {
        console.log('[内置服务端] 未找到 asset-server.exe, 使用精简内嵌服务器(无飞书同步)');
        return null;
    }
    try {
        const port = await getFreePort();
        const env = {
            ...process.env,
            ASSET_HOST: '127.0.0.1',
            ASSET_PORT: String(port),
            ASSET_DATA_DIR: dataDir,          // SQLite 数据目录
            ASSET_LEGACY_DATA_DIR: dataDir,  // 旧版 JSON 数据同目录, 首次启动自动迁移
            ASSET_EMBEDDED_TOKEN: HTTP_API_TOKEN,  // 内嵌免密 token
        };
        bundledLog('spawn: ' + exePath + ' port=' + port + ' dataDir=' + dataDir);
        const child = spawn(exePath, [], {
            cwd: path.dirname(exePath),
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        embeddedServerProc = child;
        child.stdout.on('data', (d) => { try { process.stdout.write('[asset-server] ' + d); } catch (_) {} });
        child.stderr.on('data', (d) => { try { process.stderr.write('[asset-server] ' + d); } catch (_) {} });
        child.on('error', (err) => {
            bundledLog('spawn error: ' + (err && err.message));
        });
        child.on('exit', (code) => {
            console.warn(`[内置服务端] 子进程退出 code=${code}`);
            bundledLog('子进程退出 code=' + code);
            if (embeddedServerProc === child) embeddedServerProc = null;
        });

        await waitForServerReady(port, 25000);
        console.log(`[内置服务端] asset-server.exe 已启动: 127.0.0.1:${port}`);
        bundledLog('服务端就绪: 127.0.0.1:' + port);
        return port;
    } catch (e) {
        console.warn('[内置服务端] 启动失败, 回退精简内嵌服务器: ' + (e && e.message));
        bundledLog('启动失败, 回退精简内嵌服务器: ' + (e && e.message));
        try { if (embeddedServerProc) { embeddedServerProc.kill(); embeddedServerProc = null; } } catch (_) {}
        return null;
    }
}

/** 关闭内置服务端子进程(Windows 连进程树一起结束) */
function killBundledServer() {
    const proc = embeddedServerProc;
    embeddedServerProc = null;
    if (!proc) return;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
            proc.kill('SIGTERM');
        }
    } catch (_) { try { proc.kill(); } catch (_e) {} }
}

/**
 * 单机模式:内置完整服务端(优先) 或 精简内嵌 HTTP 服务器(回退) + 本地数据目录
 */
async function startStandaloneMode() {
    // 单机模式没有远程更新源, 菜单"检查更新"将提示不支持
    setUpdateOrigin(null);
    // 确定数据目录并初始化
    const dataDir = getPortableDataDir();
    console.log(`[应用] 数据目录: ${dataDir}`);

    initPortableDataDir(dataDir);
    try {
        const hr = healthCheckAndRepair(dataDir);
        if (hr && hr.repaired && hr.repaired > 0) {
            console.log('[应用] 健康检查自动修复 ' + hr.repaired + ' 个文件', hr.messages.join(' | '));
        }
    } catch (hrErr) {
        console.warn('[应用] 健康检查执行失败(不阻塞启动): ' + (hrErr && hrErr.message || String(hrErr)));
    }

    // 优先启动内置完整服务端(含飞书同步); 失败回退精简内嵌服务器
    let port = null;
    try {
        port = await startBundledServer(dataDir);
    } catch (e) {
        console.warn('[应用] 内置服务端异常, 尝试回退: ' + (e && e.message));
        bundledLog('startBundledServer 抛错: ' + (e && e.message));
    }
    if (port) {
        bundledLog('使用内置完整服务端 port=' + port);
    } else {
        bundledLog('回退精简内嵌服务器');
    }
    if (!port) {
        try {
            port = await startServer(APP_DIR, dataDir);
        } catch (e) {
            console.error(`[应用] HTTP 服务器启动失败,应用将退出:`, e);
            app.quit();
            return;
        }
    }

    // 创建浏览器窗口
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1024,
        minHeight: 680,
        title: '固定资产管理系统',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            preload: path.join(APP_DIR, 'connection-preload.js')
        }
    });

    // 加载登录页(统一入口): login.html 探测到 embedded=true 后免密跳转 index.html
    await mainWindow.loadURL(`http://127.0.0.1:${port}/login.html`);

    // 菜单栏默认隐藏(Windows 下按 Alt 仍可显示):提供"连接服务器设置"入口
    Menu.setApplicationMenu(buildAppMenu());
    mainWindow.setMenuBarVisibility(false);

    // 内嵌单机模式同样拦截 URL 协议:
    // cs-settings:// → 打开连接设置窗口(用户填服务器地址后重启为 C/S 客户端模式)
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url.startsWith('cs-settings://')) {
            event.preventDefault();
            console.log('[内嵌单机] 用户请求打开连接设置...');
            createConnectionWindow();
        }
    });

    // 页面标题更新时，显式同步到 Electron 窗口标题（确保窗口标题栏跟随系统名称变化）
    mainWindow.on('page-title-updated', (event, title) => {
        event.preventDefault();
        if (mainWindow && title) {
            mainWindow.setTitle(title);
        }
    });

    // 外部链接在系统默认浏览器中打开(本地打印页走 Electron 预览窗口)
    ensurePrintCaptureBound();
    mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
        if (/asset_label_print\.html/i.test(targetUrl)) { openPrintWindow(targetUrl); return { action: 'deny' }; }
        if (!targetUrl || targetUrl === 'about:blank') { return { action: 'allow' }; }
        if (isExternalUrl(targetUrl)) shell.openExternal(targetUrl);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // 开发模式下打开开发者工具
    if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }
}

// Electron 准备就绪后创建窗口
app.whenReady().then(() => {
    cleanupUpdateResidue();   // 清理上次自替换/下载中断的残留文件
    registerConnectionIpc();
    createWindow();

    app.on('activate', () => {
        // macOS 下点击 dock 图标时重新创建窗口
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// 所有窗口关闭时退出应用(除 macOS 外); 单机模式切换中除外(旧窗口已销毁, 新窗口初始化中)
app.on('window-all-closed', () => {
    if (switchingToStandalone) return;
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// P1-5: 应用退出前优雅关闭 HTTP 服务器,避免最后的写入被截断导致 JSON 文件损坏
app.on('before-quit', (event) => {
    // 内置完整服务端子进程: 直接结束(独立进程, 自带 SQLite 优雅关闭)
    if (embeddedServerProc) {
        console.log('[退出] 正在关闭内置服务端...');
        killBundledServer();
    }
    if (httpServer && httpServer.listening) {
        event.preventDefault();
        console.log('[退出] 正在优雅关闭 HTTP 服务器...');
        httpServer.close(() => {
            console.log('[退出] HTTP 服务器已关闭,退出应用');
            app.exit(0);
        });
        // 3秒兜底:即使有挂起的连接也强制退出
        setTimeout(() => {
            console.warn('[退出] 服务器关闭超时,强制退出');
            app.exit(0);
        }, 3000);
    }
});

// 安全性:阻止创建额外的渲染进程
app.on('web-contents-created', (event, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
});
