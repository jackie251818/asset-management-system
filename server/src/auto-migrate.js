/**
 * 首次启动自动迁移 - 旧版便携版 JSON/JS 数据文件 → SQLite
 *
 * 触发条件(全部满足才执行, 幂等安全):
 *   1. assets 表为空(全新数据库)
 *   2. 旧数据目录中存在 assetManagementData.json/.js
 * 旧数据目录: 环境变量 ASSET_LEGACY_DATA_DIR, 缺省用 config.DATA_DIR
 *   (Electron 桌面版单机: 数据文件与 asset.db 同在 exe 旁 data/ 目录)
 *
 * 与 src/migrate.js 的区别: 不做备份/不退出进程/失败不阻塞启动,
 * 仅在全新库时静默导入, 让旧便携版用户升级后数据无缝延续。
 */

const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const config = require('./config');

/** 解析旧数据键: 优先 .json; 回退 .js(window.__LOCAL_DATA__.<key> = ...) */
function readDataKey(dir, name) {
    const jsonPath = path.join(dir, name + '.json');
    if (fs.existsSync(jsonPath)) {
        try {
            return JSON.parse(fs.readFileSync(jsonPath, 'utf-8').replace(/^﻿/, ''));
        } catch (_) { /* 落到 .js */ }
    }
    const jsPath = path.join(dir, name + '.js');
    if (fs.existsSync(jsPath)) {
        const js = fs.readFileSync(jsPath, 'utf-8');
        const m = js.match(new RegExp(`window\\.__LOCAL_DATA__\\.${name}\\s*=\\s*([\\s\\S]*?);?\\s*$`));
        if (m) {
            try { return JSON.parse(m[1]); } catch (_) { /* 忽略 */ }
        }
    }
    return undefined;
}

function runAutoMigrate() {
    try {
        const assetCount = db.prepare('SELECT COUNT(*) AS n FROM assets').get().n;
        if (assetCount > 0) return;  // 库里已有资产, 不迁移

        const legacyDir = process.env.ASSET_LEGACY_DATA_DIR
            ? path.resolve(process.env.ASSET_LEGACY_DATA_DIR)
            : config.DATA_DIR;
        if (!fs.existsSync(legacyDir)) return;

        const list = readDataKey(legacyDir, 'assetManagementData');
        if (!Array.isArray(list) || list.length === 0) return;

        const { validateAssetDoc } = require('./asset-mapper');
        const upsertAsset = db.prepare(`INSERT INTO assets (id, owner, type, brand_model, configuration, purchase_date, status,
            "user", department, location, manager, unit, quantity, value, depreciation_years,
            purchase_no, payment_no, damage_reason, version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                1, COALESCE(?, datetime('now','localtime')), datetime('now','localtime'))
            ON CONFLICT(id) DO UPDATE SET
                owner = excluded.owner, type = excluded.type, brand_model = excluded.brand_model,
                configuration = excluded.configuration, purchase_date = excluded.purchase_date,
                status = excluded.status, "user" = excluded."user", department = excluded.department,
                location = excluded.location, manager = excluded.manager, unit = excluded.unit,
                quantity = excluded.quantity, value = excluded.value,
                depreciation_years = excluded.depreciation_years, purchase_no = excluded.purchase_no,
                payment_no = excluded.payment_no, damage_reason = excluded.damage_reason,
                updated_at = excluded.updated_at`);

        const insMr = db.prepare('INSERT INTO maintenance_records (asset_id, date, type, description, manager, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
        const insAtt = db.prepare('INSERT INTO attachments (asset_id, name, mime_type, size, data_url, thumbnail, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');

        let imported = 0, invalid = 0;
        const seen = new Set();
        const importTx = db.transaction(() => {
            for (const raw of list) {
                const { doc, errors } = validateAssetDoc(raw || {});
                if (errors.length || seen.has(doc.id)) { invalid++; continue; }
                seen.add(doc.id);
                upsertAsset.run(
                    doc.id, doc.owner, doc.type, doc.brandModel, doc.configuration, doc.purchaseDate,
                    doc.status, doc.user, doc.department, doc.location, doc.manager, doc.unit,
                    doc.quantity, doc.value, doc.depreciationYears, doc.purchaseNo, doc.paymentNo,
                    doc.damageReason, null
                );
                (doc.maintenanceRecords || []).forEach((r, i) =>
                    insMr.run(doc.id, r.date || null, r.type || null, r.description || null, r.manager || null, i));
                (doc.attachments || []).forEach((a, i) =>
                    insAtt.run(doc.id, a.name || null, a.type || null, a.size || 0, a.url || null, a.thumbnail || null, i));
                imported++;
            }

            // 自定义下拉选项
            const insOpt = db.prepare('INSERT OR IGNORE INTO custom_options (kind, value, deleted, sort_order) VALUES (?, ?, ?, ?)');
            for (const kind of ['owner', 'type', 'department']) {
                for (const suffix of ['', '_deleted']) {
                    const v = readDataKey(legacyDir, `custom_options_${kind}${suffix}`);
                    if (Array.isArray(v)) {
                        v.map(x => String(x).trim()).filter(Boolean).forEach((val, i) => {
                            insOpt.run(kind, val, suffix ? 1 : 0, i);
                        });
                    }
                }
            }

            // kv 键(系统设置等)
            const insKv = db.prepare(`INSERT INTO kv_store (key, value_json, updated_at)
                VALUES (?, ?, datetime('now','localtime'))
                ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`);
            for (const key of ['userStateData', 'systemSettings', 'backupHistory', 'assetCardTemplate', 'analyzedExcelFormats']) {
                const v = readDataKey(legacyDir, key);
                if (v !== undefined) insKv.run(key, JSON.stringify(v));
            }
        });
        importTx();

        console.log(`[auto-migrate] 检测到旧版数据(${legacyDir}): 导入资产 ${imported} 条` + (invalid ? `, 跳过无效 ${invalid} 条` : ''));
    } catch (e) {
        console.error('[auto-migrate] 自动迁移失败(不影响启动):', e.message);
    }
}

module.exports = { runAutoMigrate };
