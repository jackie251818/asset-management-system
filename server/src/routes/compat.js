/**
 * 旧版薄 API 兼容层 - 让现有前端(storage.js 服务器模式)零改动接入新服务端
 *
 * 契约与原 Electron 内嵌服务完全一致:
 *   GET    /api/ping          存活检测
 *   GET    /api/info          服务器信息
 *   GET    /api/list          数据键列表(仅做连通性检测)
 *   GET    /api/load?key=     → { success: true, data: <值> }  (GET 自由读)
 *   POST   /api/save?key=     body { key, value }  (写操作需 JWT: Bearer 或 X-Server-Token)
 *   DELETE /api/delete?key=   仅允许删除 kv 键
 *
 * 键路由:
 *   assetManagementData  → assets 三表整体替换(事务)
 *   custom_options_*     → custom_options 表
 *   其余键               → kv_store
 */

const Router = require('@koa/router');
const { db } = require('../db');
const { ERR } = require('../errors');
const { requireWrite } = require('../auth');
const { rowsToDocs, validateAssetDoc } = require('../asset-mapper');

const router = new Router({ prefix: '/api' });

/** 兼容层裸响应: 旧前端契约是顶层 { success, data }, 不能用统一 {code,message,data} 包装 */
function raw(ctx, body, status = 200) {
    ctx.status = status;
    ctx.body = body;
}

const KV_KEYS = ['userStateData', 'systemSettings', 'backupHistory', 'assetCardTemplate', 'analyzedExcelFormats'];
/** 允许的 key 前缀(匹配 userId 后缀的用户独立状态等) */
const KV_PREFIXES = ['asset_userStateData_'];
const OPTION_KINDS = { owner: 'owner', type: 'type', department: 'department' };
const OPTION_KEYS = ['custom_options_owner', 'custom_options_type', 'custom_options_department',
    'custom_options_owner_deleted', 'custom_options_type_deleted', 'custom_options_department_deleted'];

/** 统一判断 key 是否允许写入 kv_store */
function isAllowedKvKey(key) {
    if (KV_KEYS.includes(key)) return true;
    return KV_PREFIXES.some(p => key.startsWith(p));
}

function keyToKind(key) {
    if (key === 'custom_options_owner') return { kind: 'owner', deleted: false };
    if (key === 'custom_options_type') return { kind: 'type', deleted: false };
    if (key === 'custom_options_department') return { kind: 'department', deleted: false };
    if (key === 'custom_options_owner_deleted') return { kind: 'owner', deleted: true };
    if (key === 'custom_options_type_deleted') return { kind: 'type', deleted: true };
    if (key === 'custom_options_department_deleted') return { kind: 'department', deleted: true };
    return null;
}

// ============ 免鉴权: 连通性/元信息 ============

router.get('/ping', async (ctx) => {
    raw(ctx, { success: true, pong: Date.now() });
});

router.get('/info', async (ctx) => {
    const config = require('../config');
    raw(ctx, {
        success: true,
        name: '固定资产管理系统服务端',
        /** C/S 架构标识: 前端据此启用登录守卫与 REST 直连模式 */
        cs: true,
        version: config.VERSION,
        dbPath: config.DB_PATH,
        serverTime: new Date().toISOString(),
    });
});

/**
 * GET /api/data-version → 数据变更指纹(多人更新轮询用)
 * 仅统计资产与自定义选项(kv_store 为各端私有状态, 不参与指纹, 避免翻页等操作误报)
 */
router.get('/data-version', async (ctx) => {
    const a = db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(version),0) AS sv,
        COALESCE(MAX(updated_at),'') AS mu FROM assets`).get();
    const o = db.prepare(`SELECT COALESCE(MAX(rowid),0) AS r, COUNT(*) AS c FROM custom_options`).get();
    raw(ctx, { success: true, stamp: `a:${a.c}:${a.sv}:${a.mu}|o:${o.c}:${o.r}` });
});

router.get('/list', async (ctx) => {
    const kvKeys = db.prepare('SELECT key, updated_at FROM kv_store ORDER BY key').all();
    const files = [
        { key: 'assetManagementData', lastModified: null },
        ...OPTION_KEYS.map(k => ({ key: k, lastModified: null })),
        ...kvKeys.map(r => ({ key: r.key, lastModified: r.updated_at })),
    ];
    raw(ctx, { success: true, files });
});

// ============ 读接口(需登录: 多人 C/S 模式下资产数据不匿名开放) ============

/** 读 custom_options_* → 数组 */
function loadOptions(key) {
    const km = keyToKind(key);
    const rows = db.prepare('SELECT value, deleted FROM custom_options WHERE kind = ? ORDER BY sort_order, value').all(km.kind);
    return rows.filter(r => (km.deleted ? r.deleted === 1 : r.deleted === 0)).map(r => r.value);
}

router.get('/load', async (ctx) => {
    const key = String(ctx.query.key || '').trim();
    if (!key) throw ERR.BAD_REQUEST('缺少 key 参数');

    if (key === 'assetManagementData') {
        const rows = db.prepare('SELECT * FROM assets ORDER BY id ASC').all();
        return raw(ctx, { success: true, key, data: rowsToDocs(rows) });
    }
    if (OPTION_KEYS.includes(key)) {
        return raw(ctx, { success: true, key, data: loadOptions(key) });
    }
    const row = db.prepare('SELECT value_json FROM kv_store WHERE key = ?').get(key);
    if (!row) throw ERR.NOT_FOUND(`数据键不存在: ${key}`);
    raw(ctx, { success: true, key, data: JSON.parse(row.value_json) });
});

// ============ 写操作: JWT(Bearer 或 X-Server-Token) ============

/** assetManagementData 整体替换(事务, 全量校验) */
const replaceAllAssets = (docs) => db.transaction(() => {
    db.prepare('DELETE FROM maintenance_records').run();
    db.prepare('DELETE FROM attachments').run();
    db.prepare('DELETE FROM assets').run();
    const count = { inserted: 0 };
    for (const doc of docs) {
        db.prepare(`INSERT INTO assets (id, owner, type, brand_model, configuration, purchase_date, status,
            "user", department, location, manager, unit, quantity, value, depreciation_years,
            purchase_no, payment_no, damage_reason, version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now','localtime'), datetime('now','localtime'))`)
            .run(doc.id, doc.owner, doc.type, doc.brandModel, doc.configuration, doc.purchaseDate,
                doc.status, doc.user, doc.department, doc.location, doc.manager, doc.unit,
                doc.quantity, doc.value, doc.depreciationYears, doc.purchaseNo, doc.paymentNo, doc.damageReason);
        const insMr = db.prepare('INSERT INTO maintenance_records (asset_id, date, type, description, manager, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
        doc.maintenanceRecords.forEach((r, i) => insMr.run(doc.id, r.date, r.type, r.description, r.manager, i));
        const insAtt = db.prepare('INSERT INTO attachments (asset_id, name, mime_type, size, data_url, thumbnail, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
        doc.attachments.forEach((a, i) => insAtt.run(doc.id, a.name, a.type, a.size, a.url, a.thumbnail, i));
        count.inserted++;
    }
    return count;
})();

/** custom_options_* 整体替换 */
const replaceOptions = (kind, active, deleted) => db.transaction(() => {
    db.prepare('DELETE FROM custom_options WHERE kind = ?').run(kind);
    const ins = db.prepare('INSERT INTO custom_options (kind, value, deleted, sort_order) VALUES (?, ?, ?, ?)');
    (active || []).forEach((v, i) => ins.run(kind, String(v), 0, i));
    (deleted || []).forEach((v, i) => ins.run(kind, String(v), 1, i + (active || []).length));
})();

router.post('/save', async (ctx) => {
    requireWrite(ctx);
    const key = String(ctx.query.key || (ctx.request.body && ctx.request.body.key) || '').trim();
    if (!key) throw ERR.BAD_REQUEST('缺少 key 参数');
    const value = ctx.request.body && ctx.request.body.value;

    if (key === 'assetManagementData') {
        if (!Array.isArray(value)) throw ERR.BAD_REQUEST('assetManagementData 必须是资产数组');
        const valid = [];
        for (let i = 0; i < value.length; i++) {
            const { doc, errors } = validateAssetDoc(value[i]);
            if (errors.length) throw ERR.BAD_REQUEST(`第 ${i + 1} 条资产无效: ${errors.join('; ')}`);
            valid.push(doc);
        }
        const ids = valid.map(d => d.id);
        if (new Set(ids).size !== ids.length) throw ERR.BAD_REQUEST('存在重复资产编号');
        const count = replaceAllAssets(valid);
        db.prepare('INSERT INTO audit_log (username, action, target, detail) VALUES (?, ?, ?, ?)')
            .run(ctx.state.user.username, 'compat.save', key, `inserted=${count.inserted}`);
        return raw(ctx, { success: true, saved: true, count: count.inserted });
    }

    const km = keyToKind(key);
    if (km) {
        if (!Array.isArray(value)) throw ERR.BAD_REQUEST(`${key} 必须是字符串数组`);
        const clean = value.map(v => String(v).trim()).filter(Boolean);
        if (km.deleted) {
            // *_deleted: 合并进主表软删除标记
            const activeNow = new Set(loadOptions('custom_options_' + km.kind));
            const ins = db.prepare('INSERT INTO custom_options (kind, value, deleted, sort_order) VALUES (?, ?, 1, 999) ON CONFLICT(kind, value) DO UPDATE SET deleted = 1');
            db.transaction(() => clean.forEach(v => { if (!activeNow.has(v)) ins.run(km.kind, v); }))();
        } else {
            const deletedList = loadOptions('custom_options_' + km.kind + '_deleted');
            replaceOptions(km.kind, clean, deletedList);
        }
        return raw(ctx, { success: true, saved: true });
    }

    if (!isAllowedKvKey(key)) throw ERR.BAD_REQUEST(`不支持的保存键: ${key}`);
    db.prepare(`INSERT INTO kv_store (key, value_json, updated_at) VALUES (?, ?, datetime('now','localtime'))
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
        .run(key, JSON.stringify(value === undefined ? null : value));
    raw(ctx, { success: true, saved: true });
});

router.delete('/delete', async (ctx) => {
    requireWrite(ctx);
    const key = String(ctx.query.key || '').trim();
    if (!key) throw ERR.BAD_REQUEST('缺少 key 参数');
    if (key === 'assetManagementData') throw ERR.BAD_REQUEST('不允许通过兼容接口删除资产全量数据');
    if (OPTION_KEYS.includes(key)) throw ERR.BAD_REQUEST('请使用 /api/options 接口维护选项');
    if (!isAllowedKvKey(key)) throw ERR.NOT_FOUND(`数据键不存在: ${key}`);
    db.prepare('DELETE FROM kv_store WHERE key = ?').run(key);
    raw(ctx, { success: true, deleted: true });
});

module.exports = { router };
