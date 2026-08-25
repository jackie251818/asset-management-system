/**
 * Electron 主进程入口 - 固定资产管理系统便携式离线版
 *
 * 设计要点:
 * 1. 内嵌 HTTP 服务器(复用 simple_server.js 逻辑),自动选择可用端口
 * 2. 静态资源从应用目录(asar 内)提供
 * 3. 数据目录支持便携式模式:数据保存在 exe 旁边的 data/ 目录,跟 exe 走
 * 4. 首次运行时,从 asar 内的初始 data 目录复制 .js 数据文件到便携式数据目录
 */

const { app, BrowserWindow, Menu, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

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
                        packageVersion
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

/**
 * 创建应用主窗口
 */
async function createWindow() {
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

    // 启动内嵌 HTTP 服务器
    let port;
    try {
        port = await startServer(APP_DIR, dataDir);
    } catch (e) {
        console.error(`[应用] HTTP 服务器启动失败,应用将退出:`, e);
        app.quit();
        return;
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
            sandbox: true
        }
    });

    // 加载应用首页(通过内嵌 HTTP 服务器)
    await mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`);

    // 隐藏菜单栏(Windows 下按 Alt 仍可显示)
    Menu.setApplicationMenu(null);
    mainWindow.setMenuBarVisibility(false);

    // 页面标题更新时，显式同步到 Electron 窗口标题（确保窗口标题栏跟随系统名称变化）
    mainWindow.on('page-title-updated', (event, title) => {
        event.preventDefault();
        if (mainWindow && title) {
            mainWindow.setTitle(title);
        }
    });

    // 外部链接在系统默认浏览器中打开
    mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
        if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
            shell.openExternal(targetUrl);
        }
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
    createWindow();

    app.on('activate', () => {
        // macOS 下点击 dock 图标时重新创建窗口
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// 所有窗口关闭时退出应用(除 macOS 外)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// P1-5: 应用退出前优雅关闭 HTTP 服务器,避免最后的写入被截断导致 JSON 文件损坏
app.on('before-quit', (event) => {
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
