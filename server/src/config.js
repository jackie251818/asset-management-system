/**
 * 服务端配置 - 固定资产管理系统 C/S 服务端
 *
 * 环境变量:
 *   ASSET_HOST       监听地址, 默认 0.0.0.0 (局域网可访问)
 *   ASSET_PORT       监听端口, 默认 3456
 *   ASSET_DATA_DIR   数据目录, 默认 server/data
 *   ASSET_DB_PATH    SQLite 数据库文件路径, 默认 <DATA_DIR>/asset.db
 *   ASSET_JWT_SECRET JWT 密钥 (默认首次启动自动生成并持久化到 secret.key)
 *   ASSET_JWT_EXPIRES token 有效期, 默认 12h
 */

const path = require('path');
const fs = require('fs');

// 是否运行于 pkg 打包的单文件 EXE 内(@yao-pkg/pkg 兼容 vercel pkg 的 process.pkg 标记)
const IS_PKG = !!process.pkg;

/**
 * SERVER_ROOT(只读): 静态资源基准目录。
 *   开发模式 = server/ ;  打包模式 = pkg 快照内的 /snapshot/server (静态文件按 ../ 相对路径内置在快照)
 */
const SERVER_ROOT = path.join(__dirname, '..');

/**
 * WRITABLE_ROOT(可写): 数据文件基准目录。
 *   打包模式 = EXE 所在目录(EXE 通常由管理员自选位置部署, data/ 跟随 EXE);
 *   开发模式 = server/ 。环境变量 ASSET_DATA_DIR 始终优先。
 */
const WRITABLE_ROOT = IS_PKG ? path.dirname(process.execPath) : SERVER_ROOT;
const DATA_DIR = process.env.ASSET_DATA_DIR || path.join(WRITABLE_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.ASSET_DB_PATH || path.join(DATA_DIR, 'asset.db');

/** JWT 密钥: 优先环境变量; 否则首次启动生成 64 位随机 hex 并持久化, 保证重启后已签发 token 仍有效 */
function loadOrCreateSecret() {
    if (process.env.ASSET_JWT_SECRET) return process.env.ASSET_JWT_SECRET;
    const secretFile = path.join(DATA_DIR, 'secret.key');
    try {
        const existing = fs.readFileSync(secretFile, 'utf-8').trim();
        if (existing) return existing;
    } catch (_) { /* 首次运行 */ }
    let s = '';
    for (let i = 0; i < 64; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
    fs.writeFileSync(secretFile, s, { encoding: 'utf-8', mode: 0o600 });
    return s;
}

module.exports = {
    SERVER_ROOT,
    DATA_DIR,
    DB_PATH,
    HOST: process.env.ASSET_HOST || '0.0.0.0',
    PORT: parseInt(process.env.ASSET_PORT || '3456', 10),
    JWT_SECRET: loadOrCreateSecret(),
    JWT_EXPIRES: process.env.ASSET_JWT_EXPIRES || '12h',
    /** 请求体上限: 兼容导入(附件 base64 内嵌)场景 */
    BODY_LIMIT: '64mb',
    VERSION: '1.0.0',
    /** 初始管理员账号(仅数据库为空时创建, 提示首次登录后修改密码) */
    DEFAULT_ADMIN: { username: 'admin', password: 'admin123', role: 'admin' },
};
