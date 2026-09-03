/**
 * 固定资产管理系统 - C/S 架构服务端入口
 *
 * 启动: npm start  (或 node src/index.js)
 * 环境变量见 config.js
 */

const Koa = require('koa');
const bodyparser = require('koa-bodyparser');
const os = require('os');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const { errorMiddleware } = require('./errors');
const { authMiddleware, authRouter, usersRouter, auditRouter } = require('./auth');
const assetsRouter = require('./routes/assets').router;
const optionsRouter = require('./routes/options').router;
const statsRouter = require('./routes/stats').router;
const compatRouter = require('./routes/compat').router;
const { isFirstInit } = require('./db');

const app = new Koa();

app.use(errorMiddleware());

// ============ CORS 中间件: 允许 file:// 协议(浏览器直接打开 index.html)选 C/S 模式时跨域调用 ============
// file:// 下 origin 为 null, 浏览器会向远程服务端发 fetch; 不开 CORS 则被拦截。
// 安全说明: 开放后任意网页可调登录接口(仍需账号密码); 生产建议限制 origin 为内网段或仅放行 null。
app.use(async (ctx, next) => {
    const origin = ctx.get('Origin');
    if (origin !== undefined) {
        ctx.set('Access-Control-Allow-Origin', origin === '' ? 'null' : origin);
        ctx.set('Vary', 'Origin');
        ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Server-Token');
        ctx.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
        ctx.set('Access-Control-Allow-Credentials', 'true');
    }
    if (ctx.method === 'OPTIONS') {
        ctx.status = 204;
        ctx.body = null;
        return;
    }
    await next();
});

app.use(bodyparser({ enableTypes: ['json', 'form'], jsonLimit: config.BODY_LIMIT, formLimit: config.BODY_LIMIT }));

/** 免鉴权白名单(方法 + 前缀精确匹配) */
const PUBLIC_ROUTES = [
    ['POST', '/api/auth/login'],
    ['GET', '/api/ping'],
    ['GET', '/api/list'],
    ['GET', '/api/info'],
];

// ============ 静态文件服务(仅 GET/HEAD, 非 /api 路径) ============

const STATIC_ROOT = path.join(config.SERVER_ROOT, '..');
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
    '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
};

/** 静态资源安全防护: 目录穿越 / 敏感目录 / 隐藏文件 / 数据库文件 */
function isUnsafeStaticPath(rel) {
    if (rel.includes('..')) return true;
    if (/^\/(server|node_modules|tests|\.git)(\/|$)/i.test(rel)) return true;
    if (/\/\./.test(rel)) return true;                 // 任意隐藏文件/目录(如 .portable、.env)
    if (/\.(db|db-wal|db-shm|key|bak)(-?\w*)?$/i.test(rel)) return true; // 数据库/密钥/备份
    return false;
}

async function serveStatic(ctx) {
    const rel = decodeURIComponent(ctx.path);
    if (rel !== '/' && isUnsafeStaticPath(rel)) {
        ctx.status = 404;
        ctx.body = { code: 40400, message: 'Not Found' };
        return;
    }
    let filePath = (rel === '/') ? path.join(STATIC_ROOT, 'index.html') : path.join(STATIC_ROOT, rel);
    // Windows 下 path.join 会把 / 还原为 \, 需确认仍在静态根内
    if (!path.resolve(filePath).startsWith(path.resolve(STATIC_ROOT))) {
        ctx.status = 404; ctx.body = { code: 40400, message: 'Not Found' }; return;
    }
    let stat = null;
    try { stat = await fs.promises.stat(filePath); } catch (_) {}
    if (stat && stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        try { stat = await fs.promises.stat(filePath); } catch (_) { stat = null; }
    }
    if (!stat || !stat.isFile()) {
        ctx.status = 404;
        ctx.type = 'text/html; charset=utf-8';
        ctx.body = '<!DOCTYPE html><html lang="zh-CN"><meta charset="UTF-8"><body style="font-family:sans-serif;text-align:center;padding-top:80px;"><h2>404 - 文件不存在</h2><p><a href="/">返回系统首页</a> | <a href="/login.html">登录页</a></p></body></html>';
        return;
    }
    ctx.type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    ctx.set('Content-Length', stat.size);
    ctx.set('Cache-Control', 'no-cache');
    ctx.body = fs.createReadStream(filePath);
}

app.use(async (ctx, next) => {
    if ((ctx.method === 'GET' || ctx.method === 'HEAD') && !ctx.path.startsWith('/api/')) {
        return serveStatic(ctx);
    }
    return next();
});

app.use(async (ctx, next) => {
    const isPublic = PUBLIC_ROUTES.some(([m, p]) => ctx.method === m && ctx.path === p)
        // GET /api/load 对 systemSettings + custom_options_* 免鉴权(登录页动态系统名称/选项用)
        || (ctx.method === 'GET' && ctx.path === '/api/load' && (() => {
            const key = String(ctx.query.key || '').trim();
            return key === 'systemSettings' || key.startsWith('custom_options_');
        })());
    if (isPublic) return next();
    if (!ctx.path.startsWith('/api/')) {
        ctx.status = 404;
        ctx.body = { code: 40400, message: 'Not Found (本服务仅提供 /api/* 接口)' };
        return;
    }
    return authMiddleware()(ctx, next);
});

app.use(authRouter.routes()).use(authRouter.allowedMethods());
app.use(usersRouter.routes()).use(usersRouter.allowedMethods());
app.use(auditRouter.routes()).use(auditRouter.allowedMethods());
app.use(assetsRouter.routes()).use(assetsRouter.allowedMethods());
app.use(optionsRouter.routes()).use(optionsRouter.allowedMethods());
app.use(statsRouter.routes()).use(statsRouter.allowedMethods());
app.use(compatRouter.routes()).use(compatRouter.allowedMethods());

// 兜底 404(JSON 格式)
app.use(async (ctx) => {
    ctx.status = 404;
    ctx.body = { code: 40400, message: `接口不存在: ${ctx.method} ${ctx.path}` };
});

/** 收集局域网 IPv4 地址, 启动横幅展示客户端可访问地址 */
function getLanAddresses(port) {
    const out = [];
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
        for (const it of ifs[name] || []) {
            if (it.family === 'IPv4' && !it.internal) out.push(`http://${it.address}:${port}`);
        }
    }
    return out;
}

const server = app.listen(config.PORT, config.HOST, () => {
    console.log('==============================================');
    console.log('  固定资产管理系统 - 服务端 v' + config.VERSION);
    console.log('==============================================');
    console.log(`  监听地址 : ${config.HOST}:${config.PORT}`);
    console.log(`  数据库   : ${config.DB_PATH}`);
    console.log(`  本机访问 : http://127.0.0.1:${config.PORT}`);
    for (const lan of getLanAddresses(config.PORT)) {
        console.log(`  局域网   : ${lan}`);
    }
    if (isFirstInit) {
        console.log(`  初始账号 : admin / admin123 (请登录后立即修改密码)`);
    }
    console.log('==============================================');
});

/** 优雅停机: 关闭 HTTP 与 SQLite */
function shutdown(signal) {
    console.log(`\n[server] 收到 ${signal}, 正在关闭...`);
    server.close(() => {
        try { require('./db').db.close(); } catch (_) {}
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server };
