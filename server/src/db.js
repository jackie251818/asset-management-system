/**
 * SQLite 数据库初始化 - 表结构 + 索引 + 默认管理员
 *
 * 建模说明(与前端资产对象字段一一对应, snake_case ↔ camelCase 由 asset-mapper.js 转换):
 *   assets               资产主表, id 为资产编号(业务主键), version 为乐观锁
 *   maintenance_records  维保记录(原 asset.maintenanceRecords[])
 *   attachments          附件(原 asset.attachments[], data_url 保留 base64 全量数据)
 *   custom_options       自定义下拉选项(kind: owner|type|department, deleted 软删除)
 *   kv_store             userStateData/systemSettings/backupHistory/assetCardTemplate/analyzedExcelFormats
 *   audit_log            操作审计
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const config = require('./config');

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','editor','viewer')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS assets (
    id                 TEXT PRIMARY KEY,
    owner              TEXT,
    type               TEXT,
    brand_model        TEXT,
    configuration      TEXT,
    purchase_date      TEXT,
    status             TEXT DEFAULT 'active',
    user               TEXT,
    department         TEXT,
    location           TEXT,
    manager            TEXT,
    unit               TEXT DEFAULT '台',
    quantity           INTEGER DEFAULT 1,
    value              REAL DEFAULT 0,
    depreciation_years INTEGER DEFAULT 0,
    purchase_no        TEXT,
    payment_no         TEXT,
    damage_reason      TEXT,
    extra_json         TEXT,
    version            INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS maintenance_records (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id   TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    date       TEXT,
    type       TEXT,
    description TEXT,
    manager    TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attachments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id   TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    name       TEXT,
    mime_type  TEXT,
    size       INTEGER DEFAULT 0,
    data_url   TEXT,
    thumbnail  TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS custom_options (
    kind       TEXT NOT NULL CHECK (kind IN ('owner','type','department')),
    value      TEXT NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, value)
);

CREATE TABLE IF NOT EXISTS kv_store (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT,
    action     TEXT NOT NULL,
    target     TEXT,
    detail     TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_assets_status     ON assets(status);
CREATE INDEX IF NOT EXISTS idx_assets_type       ON assets(type);
CREATE INDEX IF NOT EXISTS idx_assets_department ON assets(department);
CREATE INDEX IF NOT EXISTS idx_assets_owner      ON assets(owner);
CREATE INDEX IF NOT EXISTS idx_assets_user       ON assets("user");
CREATE INDEX IF NOT EXISTS idx_mr_asset          ON maintenance_records(asset_id);
CREATE INDEX IF NOT EXISTS idx_att_asset         ON attachments(asset_id);
`);

/** 数据库为空时创建默认管理员 admin/admin123 */
function ensureDefaultAdmin() {
    const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    if (count > 0) return false;
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
        .run(config.DEFAULT_ADMIN.username, bcrypt.hashSync(config.DEFAULT_ADMIN.password, 10), config.DEFAULT_ADMIN.role);
    console.log(`[db] 已创建初始管理员 ${config.DEFAULT_ADMIN.username} (默认密码 ${config.DEFAULT_ADMIN.password}, 请登录后立即修改)`);
    return true;
}

const isFirstInit = ensureDefaultAdmin();

module.exports = { db, isFirstInit };
