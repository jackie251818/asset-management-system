/**
 * 数据迁移工具 - 旧版 JSON/JS 数据文件 → SQLite
 *
 * 用法:
 *   node src/migrate.js --source <旧数据目录> [--db <数据库路径>] [--mode merge|replace] [--dry-run]
 *
 * 默认 --mode merge: 按资产编号 upsert(已存在则整体更新), 选项与 kv 键覆盖写入
 *     --mode replace: 清空资产三表后全量导入
 *
 * 安全机制:
 *   1. 迁移前备份源数据目录 → <source>/_migrate_backup_<时间戳>/
 *   2. 目标库文件若存在 → 复制为 asset.db.bak-<时间戳>
 *   3. 资产逐条校验(必填字段/重复编号), 全量事务导入, 任一失败整体回滚
 *   4. 迁移后逐键计数核对, 输出核对报告
 */

const fs = require('fs');
const path = require('path');

// ============ 参数解析(先于 require db, 以便 --db 覆盖环境变量) ============

function parseArgs(argv) {
    const args = { mode: 'merge', dryRun: false, source: null, db: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--source') args.source = argv[++i];
        else if (a === '--db') args.db = argv[++i];
        else if (a === '--mode') args.mode = argv[++i];
        else if (a === '--dry-run') args.dryRun = true;
        else if (a === '--help' || a === '-h') args.help = true;
    }
    return args;
}

const args = parseArgs(process.argv);
if (args.help || !args.source) {
    console.log('用法: node src/migrate.js --source <旧数据目录> [--db <数据库路径>] [--mode merge|replace] [--dry-run]');
    process.exit(args.help ? 0 : 1);
}
if (!['merge', 'replace'].includes(args.mode)) {
    console.error('[migrate] --mode 必须是 merge 或 replace');
    process.exit(1);
}
if (args.db) process.env.ASSET_DB_PATH = path.resolve(args.db);

const SOURCE_DIR = path.resolve(args.source);
if (!fs.existsSync(SOURCE_DIR) || !fs.statSync(SOURCE_DIR).isDirectory()) {
    console.error(`[migrate] 源目录不存在: ${SOURCE_DIR}`);
    process.exit(1);
}

const ts = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0];

// ============ 1. 备份源数据目录 ============

const backupDir = path.join(SOURCE_DIR, `_migrate_backup_${ts}`);
fs.mkdirSync(backupDir, { recursive: true });
const dataFileNames = ['assetManagementData', 'userStateData', 'systemSettings', 'backupHistory',
    'assetCardTemplate', 'analyzedExcelFormats',
    'custom_options_owner', 'custom_options_type', 'custom_options_department',
    'custom_options_owner_deleted', 'custom_options_type_deleted', 'custom_options_department_deleted'];
let backedUp = 0;
for (const name of dataFileNames) {
    for (const ext of ['.json', '.js']) {
        const p = path.join(SOURCE_DIR, name + ext);
        if (fs.existsSync(p)) { fs.copyFileSync(p, path.join(backupDir, name + ext)); backedUp++; }
    }
}
console.log(`[migrate] 源数据已备份: ${backupDir} (${backedUp} 个文件)`);

// ============ 2. 备份目标数据库文件(打开前) ============

const DB_PATH = process.env.ASSET_DB_PATH || path.join(__dirname, '..', 'data', 'asset.db');
if (fs.existsSync(DB_PATH)) {
    const dbBak = DB_PATH + '.bak-' + ts;
    fs.copyFileSync(DB_PATH, dbBak);
    for (const ext of ['-wal', '-shm']) {
        if (fs.existsSync(DB_PATH + ext)) { try { fs.copyFileSync(DB_PATH + ext, dbBak + ext); } catch (_) {} }
    }
    console.log(`[migrate] 目标数据库已备份: ${dbBak}`);
}

// ============ 3. 读取并解析旧数据 ============

/** 解析单个数据键: 优先 .json; 回退 .js(提取 window.__LOCAL_DATA__.<key> = {...}) */
function readDataKey(name) {
    const jsonPath = path.join(SOURCE_DIR, name + '.json');
    if (fs.existsSync(jsonPath)) {
        try {
            const raw = fs.readFileSync(jsonPath, 'utf-8').replace(/^\uFEFF/, '');
            return { data: JSON.parse(raw), from: path.basename(jsonPath) };
        } catch (e) {
            console.warn(`[migrate] ${name}.json 解析失败(${e.message}), 尝试从 .js 恢复`);
        }
    }
    const jsPath = path.join(SOURCE_DIR, name + '.js');
    if (fs.existsSync(jsPath)) {
        const js = fs.readFileSync(jsPath, 'utf-8');
        const m = js.match(new RegExp(`window\\.__LOCAL_DATA__\\.${name}\\s*=\\s*([\\s\\S]*?);?\\s*$`));
        if (m) {
            try { return { data: JSON.parse(m[1]), from: path.basename(jsPath) }; }
            catch (e) { console.warn(`[migrate] ${name}.js 解析失败: ${e.message}`); }
        }
    }
    return { data: undefined, from: null };
}

const kvKeys = ['userStateData', 'systemSettings', 'backupHistory', 'assetCardTemplate', 'analyzedExcelFormats'];

const source = { kv: {}, options: {} };
let assetsSource = null;

{
    const r = readDataKey('assetManagementData');
    if (r.data !== undefined) {
        if (!Array.isArray(r.data)) {
            console.error('[migrate] assetManagementData 不是数组, 无法迁移');
            process.exit(1);
        }
        assetsSource = { list: r.data, from: r.from };
    }
}

for (const key of kvKeys) {
    const r = readDataKey(key);
    if (r.data !== undefined) source.kv[key] = r.data;
}

for (const kind of ['owner', 'type', 'department']) {
    for (const suffix of ['', '_deleted']) {
        const r = readDataKey(`custom_options_${kind}${suffix}`);
        if (r.data !== undefined) {
            if (!Array.isArray(r.data)) { console.warn(`[migrate] custom_options_${kind}${suffix} 不是数组, 忽略`); continue; }
            source.options[kind + suffix] = r.data.map(v => String(v).trim()).filter(Boolean);
        }
    }
}

// ============ 4. 校验资产 ============

const { validateAssetDoc } = require('./asset-mapper');

const validAssets = [];
const invalidAssets = [];
const seenIds = new Map();
for (let i = 0; i < (assetsSource ? assetsSource.list.length : 0); i++) {
    const raw = assetsSource.list[i];
    const { doc, errors } = validateAssetDoc(raw);
    if (errors.length) { invalidAssets.push({ index: i, id: raw && raw.id, errors }); continue; }
    if (seenIds.has(doc.id)) {
        console.warn(`[migrate] 重复资产编号 ${doc.id} (第 ${seenIds.get(doc.id) + 1} 条与第 ${i + 1} 条), 保留先出现的`);
        continue;
    }
    seenIds.set(doc.id, i);
    validAssets.push(doc);
}

console.log(`[migrate] 源资产 ${assetsSource ? assetsSource.list.length : 0} 条 → 有效 ${validAssets.length} 条, 无效 ${invalidAssets.length} 条`);
for (const v of invalidAssets.slice(0, 10)) {
    console.warn(`  - 第 ${v.index + 1} 条(${v.id || '无编号'}): ${v.errors.join('; ')}`);
}
if (invalidAssets.length > 10) console.warn(`  ... 其余 ${invalidAssets.length - 10} 条略`);
if (invalidAssets.length > 0 && !args.dryRun) {
    console.error('[migrate] 存在无效数据, 为避免数据丢失请先处理源文件(可用 --dry-run 查看详情)');
    process.exit(1);
}

if (args.dryRun) {
    console.log('[migrate] --dry-run 校验完成, 未写入数据库');
    console.log(`[migrate] 将导入: 资产 ${validAssets.length} 条(${args.mode}), 选项键 ${Object.keys(source.options).length} 个, kv 键 ${Object.keys(source.kv).length} 个`);
    process.exit(0);
}

// ============ 5. 事务导入 ============

const { db } = require('./db'); // 打开库(建表/默认管理员)

const importAll = db.transaction(() => {
    const ret = { assetsInserted: 0, assetsUpdated: 0, options: 0, kv: 0 };

    if (args.mode === 'replace') {
        db.prepare('DELETE FROM maintenance_records').run();
        db.prepare('DELETE FROM attachments').run();
        db.prepare('DELETE FROM assets').run();
    }
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
    const clearMr = db.prepare('DELETE FROM maintenance_records WHERE asset_id = ?');
    const insMr = db.prepare('INSERT INTO maintenance_records (asset_id, date, type, description, manager, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    const clearAtt = db.prepare('DELETE FROM attachments WHERE asset_id = ?');
    const insAtt = db.prepare('INSERT INTO attachments (asset_id, name, mime_type, size, data_url, thumbnail, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');

    for (const doc of validAssets) {
        const existed = db.prepare('SELECT id FROM assets WHERE id = ?').get(doc.id);
        upsertAsset.run(doc.id, doc.owner, doc.type, doc.brandModel, doc.configuration, doc.purchaseDate,
            doc.status, doc.user, doc.department, doc.location, doc.manager, doc.unit,
            doc.quantity, doc.value, doc.depreciationYears, doc.purchaseNo, doc.paymentNo,
            doc.damageReason, null);
        clearMr.run(doc.id);
        doc.maintenanceRecords.forEach((r, i) => insMr.run(doc.id, r.date, r.type, r.description, r.manager, i));
        clearAtt.run(doc.id);
        doc.attachments.forEach((a, i) => insAtt.run(doc.id, a.name, a.type, a.size, a.url, a.thumbnail, i));
        existed ? ret.assetsUpdated++ : ret.assetsInserted++;
    }

    // 选项: 合并激活数组与删除数组, 覆盖该 kind
    const kinds = new Set(Object.keys(source.options).map(k => k.replace('_deleted', '')));
    const insOpt = db.prepare(`INSERT INTO custom_options (kind, value, deleted, sort_order) VALUES (?, ?, ?, ?)
        ON CONFLICT(kind, value) DO UPDATE SET deleted = excluded.deleted`);
    for (const kind of kinds) {
        const active = source.options[kind] || [];
        const deleted = source.options[kind + '_deleted'] || [];
        db.prepare('DELETE FROM custom_options WHERE kind = ?').run(kind);
        active.forEach((v, i) => insOpt.run(kind, v, 0, i));
        deleted.forEach((v, i) => insOpt.run(kind, v, 1, active.length + i));
        ret.options += active.length + deleted.length;
    }

    // kv 键
    const upsertKv = db.prepare(`INSERT INTO kv_store (key, value_json, updated_at) VALUES (?, ?, datetime('now','localtime'))
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`);
    for (const [key, value] of Object.entries(source.kv)) {
        upsertKv.run(key, JSON.stringify(value));
        ret.kv++;
    }
    return ret;
});

const result = importAll();
console.log(`[migrate] 资产: 新增 ${result.assetsInserted}, 更新 ${result.assetsUpdated}`);
console.log(`[migrate] 选项: ${result.options} 项; kv 键: ${result.kv} 个`);

// ============ 6. 迁移后核对 ============

const dbAssetCount = db.prepare('SELECT COUNT(*) AS n FROM assets').get().n;
const checks = [
    { name: 'assetManagementData', expect: validAssets.length, actual: dbAssetCount },
];
for (const kind of ['owner', 'type', 'department']) {
    const active = source.options[kind] || [];
    const deleted = source.options[kind + '_deleted'] || [];
    if (active.length || deleted.length) {
        const n = db.prepare('SELECT COUNT(*) AS n FROM custom_options WHERE kind = ?').get(kind).n;
        checks.push({ name: `custom_options_${kind}`, expect: active.length + deleted.length, actual: n });
    }
}
for (const key of Object.keys(source.kv)) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM kv_store WHERE key = ?').get(key).n;
    checks.push({ name: key, expect: 1, actual: n });
}

let allOk = true;
console.log('[migrate] ===== 核对报告 =====');
for (const c of checks) {
    const pass = c.expect === c.actual;
    if (!pass) allOk = false;
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${c.name}: 期望 ${c.expect}, 实际 ${c.actual}`);
}
console.log(allOk ? '[migrate] 迁移完成, 全部核对通过' : '[migrate] 迁移完成, 但存在核对不一致, 请检查日志');
process.exit(allOk ? 0 : 1);
