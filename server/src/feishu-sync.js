/**
 * 飞书多维表格双向同步引擎
 *
 * 依赖: Node 22 原生 fetch (不引入额外 npm 包)
 * 复用: validateAssetDoc/rowsToDocs (asset-mapper.js), writeAssetTx (routes/assets.js)
 *
 * 设计参考: .trae/documents/feishu-bidirectional-sync.md
 * 零侵入: 不使用飞书时系统行为完全不变; 新表由本模块自管 CREATE TABLE IF NOT EXISTS
 */

const { db } = require('./db');
const { validateAssetDoc, rowsToDocs, ASSET_FIELDS } = require('./asset-mapper');
const { writeAssetTx } = require('./routes/assets');
const { ERR } = require('./errors');
const crypto = require('crypto');

const FEISHU_BASE = 'https://open.feishu.cn';
const KV_CONFIG_KEY = 'feishu_sync_config';
const KV_OWNER_MAP_KEY = 'feishu_owner_table_map';

// ============ 模块加载时自管建表(幂等, 不改 db.js) ============
db.exec(`
CREATE TABLE IF NOT EXISTS feishu_sync_state (
    asset_id            TEXT PRIMARY KEY,
    record_id           TEXT,
    last_synced_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    last_synced_hash    TEXT,
    last_synced_version INTEGER,
    last_remote_modified_at TEXT,
    sync_direction      TEXT,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_feishu_record_id ON feishu_sync_state(record_id)`);

// v2: 多表同步 — 增加 table_id 列记录每条资产对应的飞书表(幂等迁移)
try { db.exec(`ALTER TABLE feishu_sync_state ADD COLUMN table_id TEXT`); } catch (e) { /* 列已存在 */ }

// ============ 模块级状态 ============
let _tokenCache = { token: null, expiresAt: 0 };
let _syncInProgress = false;

// ============ 配置读写(直接读写 kv_store, 绕过 compat 白名单) ============
function getConfig() {
    const row = db.prepare('SELECT value_json FROM kv_store WHERE key = ?').get(KV_CONFIG_KEY);
    if (!row) return null;
    try { return JSON.parse(row.value_json); } catch { return null; }
}

function saveConfig(cfg) {
    db.prepare(`
        INSERT INTO kv_store (key, value_json, updated_at)
        VALUES (?, ?, datetime('now','localtime'))
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(KV_CONFIG_KEY, JSON.stringify(cfg));
}

// ============ 主体→表 路由映射(pull 时积累, push 时使用) ============
function loadOwnerTableMap() {
    const row = db.prepare('SELECT value_json FROM kv_store WHERE key = ?').get(KV_OWNER_MAP_KEY);
    if (!row) return {};
    try { return JSON.parse(row.value_json); } catch { return {}; }
}

function saveOwnerTableMap(map) {
    db.prepare(`
        INSERT INTO kv_store (key, value_json, updated_at)
        VALUES (?, ?, datetime('now','localtime'))
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(KV_OWNER_MAP_KEY, JSON.stringify(map));
}

// ============ 多表支持: 列出该多维表格下全部数据表 ============
async function listTables(cfg) {
    const data = await feishuRequest('GET',
        `/open-apis/bitable/v1/apps/${cfg.appToken}/tables?page_size=100`, undefined, cfg);
    return data.items || [];
}

// ============ Token 管理 ============
async function getTenantAccessToken(cfg) {
    const now = Date.now();
    if (_tokenCache.token && now < _tokenCache.expiresAt) return _tokenCache.token;

    const resp = await fetch(FEISHU_BASE + '/open-apis/auth/v3/tenant_access_token/internal/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret })
    });
    const data = await resp.json();
    if (data.code !== 0) throw ERR.BAD_REQUEST('飞书鉴权失败: ' + data.msg);
    _tokenCache = {
        token: data.tenant_access_token,
        expiresAt: now + (data.expire - 300) * 1000  // 提前 5 分钟刷新
    };
    return _tokenCache.token;
}

function invalidateToken() { _tokenCache = { token: null, expiresAt: 0 }; }

// ============ 飞书 API 请求封装(带重试) ============
async function feishuRequest(method, path, body, cfg, retry = 0) {
    const token = await getTenantAccessToken(cfg);
    const resp = await fetch(FEISHU_BASE + path, {
        method,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Authorization': 'Bearer ' + token
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const data = await resp.json().catch(() => null);

    // 401: token 过期 — 刷新一次重试
    if (resp.status === 401 && retry === 0) {
        invalidateToken();
        return feishuRequest(method, path, body, cfg, 1);
    }
    // 429 / 写并发限制 — 指数退避
    if (resp.status === 429 && retry < 3) {
        await sleep(Math.pow(2, retry) * 1000);
        return feishuRequest(method, path, body, cfg, retry + 1);
    }
    // 5xx: 服务端瞬时故障
    if (resp.status >= 500 && retry < 2) {
        await sleep((retry + 1) * 2000);
        return feishuRequest(method, path, body, cfg, retry + 1);
    }
    if (!data || data.code !== 0) {
        throw ERR.BAD_REQUEST('飞书 API ' + method + ' ' + path + ' 失败: ' +
            (data ? data.code + ' ' + data.msg : 'HTTP ' + resp.status));
    }
    return data.data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ Bitable 客户端(支持多表: 可选 tableId 参数, 缺省用配置表) ============
class FeishuBitableClient {
    constructor(cfg) { this.cfg = cfg; }

    async listAllRecords(tableId) {
        const tid = tableId || this.cfg.tableId;
        const records = [];
        let pageToken = undefined;
        do {
            const params = new URLSearchParams({ page_size: '500' });
            if (pageToken) params.set('page_token', pageToken);
            const data = await feishuRequest('GET',
                `/open-apis/bitable/v1/apps/${this.cfg.appToken}/tables/${tid}/records?${params}`,
                undefined, this.cfg);
            records.push(...(data.items || []));
            pageToken = data.has_more ? data.page_token : undefined;
        } while (pageToken);
        return records;
    }

    async batchCreate(records, tableId) {
        const tid = tableId || this.cfg.tableId;
        const results = [];
        for (let i = 0; i < records.length; i += 500) {
            const batch = records.slice(i, i + 500);
            const data = await feishuRequest('POST',
                `/open-apis/bitable/v1/apps/${this.cfg.appToken}/tables/${tid}/records/batch_create`,
                { records: batch }, this.cfg);
            results.push(...(data.records || []));
        }
        return results;
    }

    async batchUpdate(records, tableId) {
        const tid = tableId || this.cfg.tableId;
        const results = [];
        for (let i = 0; i < records.length; i += 500) {
            const batch = records.slice(i, i + 500);
            const data = await feishuRequest('POST',
                `/open-apis/bitable/v1/apps/${this.cfg.appToken}/tables/${tid}/records/batch_update`,
                { records: batch }, this.cfg);
            results.push(...(data.records || []));
        }
        return results;
    }

    async listFields() {
        const data = await feishuRequest('GET',
            `/open-apis/bitable/v1/apps/${this.cfg.appToken}/tables/${this.cfg.tableId}/fields?page_size=100`,
            undefined, this.cfg);
        return data.items || [];
    }
}

// ============ 字段映射 ============
function docToFields(doc, mappings) {
    const fields = {};
    for (const m of mappings) {
        const val = doc[m.localField];
        if (val === undefined || val === null || val === '') { continue; }
        switch (m.type) {
            case 'number':
                fields[m.feishuField] = Number(val); break;
            case 'date':
                fields[m.feishuField] = parseDateToMs(val); break;
            case 'single_select':
                fields[m.feishuField] = String(val); break;
            default:
                fields[m.feishuField] = String(val);
        }
    }
    return fields;
}

function recordToDoc(record, mappings, idField) {
    const f = record.fields || {};
    const doc = {};
    for (const m of mappings) {
        const v = f[m.feishuField];
        doc[m.localField] = normalizeFeishuValue(v, m.type);
    }
    doc.id = normalizeFeishuValue(f[idField], 'text');
    // 为飞书表中不存在但本地必填的字段填默认值
    // 允许"字段不匹配的忽略"场景下 pull 回来也能过校验
    if (!doc.owner) doc.owner = '未知';
    if (!doc.type) doc.type = '未分类';
    if (!doc.brandModel) doc.brandModel = '';
    if (!doc.department) doc.department = '未分配';
    if (!doc.purchaseDate) doc.purchaseDate = new Date().toISOString().split('T')[0];
    return doc;
}

function normalizeFeishuValue(v, type) {
    if (v === undefined || v === null) return null;
    if (type === 'text' && Array.isArray(v)) {
        // 飞书文本字段返回 [{text: "..."}] 数组
        return v.map(seg => (seg && seg.text) || '').join('');
    }
    if (type === 'date' && typeof v === 'number') {
        // 飞书日期字段返回毫秒时间戳, 转 YYYY-MM-DD
        return new Date(v).toISOString().split('T')[0];
    }
    return v;
}

function parseDateToMs(val) {
    // 支持 YYYY-MM-DD, YYYY/MM/DD, ISO 字符串
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.getTime();
}

function hashFields(doc, mappings) {
    const fields = docToFields(doc, mappings);
    return crypto.createHash('md5').update(JSON.stringify(fields)).digest('hex');
}

// ============ 推送: 系统 → 飞书(按主体路由到对应表) ============
async function pushToFeishu(options = {}) {
    const cfg = getConfig();
    if (!cfg || !cfg.appId || !cfg.appSecret) throw ERR.BAD_REQUEST('请先配置飞书凭证');

    if (_syncInProgress) throw ERR.CONFLICT('同步进行中, 请稍后再试');
    _syncInProgress = true;

    try {
        const client = new FeishuBitableClient(cfg);
        const mappings = cfg.fieldMappings || [];

        // 0. 主体→表 路由: 优先用 pull 积累的真实映射, 再用"表名是主体子串"匹配兜底
        const tables = await listTables(cfg);
        const ownerMap = loadOwnerTableMap();
        const routeByOwner = (owner) => {
            if (!owner) return null;
            if (ownerMap[owner]) return ownerMap[owner];
            const hit = tables.find(t => owner.includes(t.name));
            return hit ? hit.table_id : null;
        };

        // 1. 读取全部资产(含维保/附件, 但只推送映射的字段)
        const rows = db.prepare('SELECT * FROM assets ORDER BY id').all();
        const docs = rowsToDocs(rows);

        // 2. 读取同步状态
        const stateRows = db.prepare('SELECT * FROM feishu_sync_state').all();
        const stateMap = new Map(stateRows.map(r => [r.asset_id, r]));

        // 3. 分桶: 按目标表分组 toCreate / toUpdate / skipped
        const creates = new Map();  // tableId -> [doc]
        const updates = new Map();  // tableId -> [{doc, record_id, currentHash}]
        let skipped = 0;
        const failed = [];

        for (const doc of docs) {
            try {
                const currentHash = hashFields(doc, mappings);
                const state = stateMap.get(doc.id);
                if (!state || !state.record_id) {
                    // 新记录: 按"主体"路由到对应表; 无法路由的不乱推
                    const tableId = routeByOwner(doc.owner);
                    if (!tableId) {
                        failed.push({ id: doc.id, error: '无法确定所属飞书表(主体: ' + (doc.owner || '空') + '), 已跳过' });
                        continue;
                    }
                    if (!creates.has(tableId)) creates.set(tableId, []);
                    creates.get(tableId).push(doc);
                } else if (state.last_synced_hash !== currentHash) {
                    // 已有记录: 留在原表更新
                    const tableId = state.table_id || cfg.tableId;
                    if (!updates.has(tableId)) updates.set(tableId, []);
                    updates.get(tableId).push({ doc, record_id: state.record_id, currentHash });
                } else {
                    skipped++;
                }
            } catch (e) {
                failed.push({ id: doc.id, error: e.message });
            }
        }

        // 4. 按表批量创建
        let created = 0;
        for (const [tableId, tableDocs] of creates) {
            const createRecords = tableDocs.map(doc => ({ fields: docToFields(doc, mappings) }));
            const createdRecords = await client.batchCreate(createRecords, tableId);
            for (let i = 0; i < tableDocs.length && i < createdRecords.length; i++) {
                const doc = tableDocs[i];
                const recordId = createdRecords[i].record_id;
                const currentHash = hashFields(doc, mappings);
                db.prepare(`
                    INSERT INTO feishu_sync_state (asset_id, record_id, table_id, last_synced_at, last_synced_hash, last_synced_version, sync_direction)
                    VALUES (?, ?, ?, datetime('now','localtime'), ?, ?, 'push')
                    ON CONFLICT(asset_id) DO UPDATE SET record_id=excluded.record_id, table_id=excluded.table_id,
                        last_synced_at=excluded.last_synced_at, last_synced_hash=excluded.last_synced_hash,
                        last_synced_version=excluded.last_synced_version, sync_direction='push'
                `).run(doc.id, recordId, tableId, currentHash, doc.version || 1);
                created++;
            }
        }

        // 5. 按表批量更新
        let updated = 0;
        for (const [tableId, items] of updates) {
            const updateRecords = items.map(item => ({
                record_id: item.record_id,
                fields: docToFields(item.doc, mappings)
            }));
            await client.batchUpdate(updateRecords, tableId);
            for (const item of items) {
                db.prepare(`
                    UPDATE feishu_sync_state
                    SET last_synced_at = datetime('now','localtime'), table_id = ?,
                        last_synced_hash = ?, last_synced_version = ?, sync_direction = 'push'
                    WHERE asset_id = ?
                `).run(tableId, item.currentHash, item.doc.version || 1, item.doc.id);
                updated++;
            }
        }

        // 6. 审计 + 更新配置状态
        const stats = { created, updated, skipped, failed, total: docs.length };
        cfg.lastSyncAt = new Date().toISOString();
        cfg.lastSyncDirection = 'push';
        cfg.lastSyncStats = stats;
        saveConfig(cfg);

        return stats;
    } finally {
        _syncInProgress = false;
    }
}

// ============ 拉取: 飞书 → 系统(遍历该多维表格下全部数据表) ============
async function pullFromFeishu(options = {}) {
    const cfg = getConfig();
    if (!cfg || !cfg.appId || !cfg.appSecret) throw ERR.BAD_REQUEST('请先配置飞书凭证');

    if (_syncInProgress) throw ERR.CONFLICT('同步进行中, 请稍后再试');
    _syncInProgress = true;

    try {
        const client = new FeishuBitableClient(cfg);
        const mappings = cfg.fieldMappings || [];
        const idField = cfg.fieldNameForAssetId || '资产编号';
        const strategy = (cfg.syncOptions && cfg.syncOptions.conflictStrategy) || 'last_write_wins';

        // 0. 列出全部数据表
        const tables = await listTables(cfg);

        // 1. 读取本地资产 + 同步状态
        const localRows = db.prepare('SELECT id, updated_at, version FROM assets').all();
        const localMap = new Map(localRows.map(r => [r.id, r]));
        const stateRows = db.prepare('SELECT * FROM feishu_sync_state').all();
        const stateMap = new Map(stateRows.map(r => [r.record_id, r]));

        // 2. 逐表拉取分类: newDocs / updateDocs / skipNoChange / invalid
        const newDocs = [];
        const updateDocs = [];
        let skipNoChange = 0;
        let totalRecords = 0;
        const invalid = [];
        const perTable = [];
        const ownerTableMap = {};       // 购买主体真实值 → 表ID(供 push 路由)
        const seenIds = new Map();      // 跨表去重: asset_id -> 表名

        for (const t of tables) {
            const records = await client.listAllRecords(t.table_id);
            totalRecords += records.length;
            let tNew = 0, tUpdate = 0, tSkip = 0, tInvalid = 0;

            for (const record of records) {
                const doc = recordToDoc(record, mappings, idField);
                // 记录 主体→表 路由(用"购买主体"原始值, 排除默认值)
                if (doc.owner && doc.owner !== '未知') ownerTableMap[doc.owner] = t.table_id;

                const { doc: cleanDoc, errors } = validateAssetDoc(doc);
                if (errors.length) {
                    invalid.push({ table: t.name, record_id: record.record_id, id: doc.id, errors });
                    tInvalid++;
                    continue;
                }
                // 跨表重复的资产编号: 只认第一张表, 后续记为 invalid
                if (seenIds.has(cleanDoc.id)) {
                    invalid.push({ table: t.name, record_id: record.record_id, id: cleanDoc.id,
                        errors: ['资产编号与表「' + seenIds.get(cleanDoc.id) + '」中的记录重复'] });
                    tInvalid++;
                    continue;
                }
                seenIds.set(cleanDoc.id, t.name);

                // 计算飞书端数据的 hash(用 docToFields 转回飞书格式再 hash, 确保和 push 一致)
                const remoteHash = hashFields(cleanDoc, mappings);
                const existing = localMap.get(cleanDoc.id);
                const state = stateMap.get(record.record_id);

                if (existing) {
                    // 本地有 + 飞书也有 → hash 比较判定谁更新
                    if (strategy === 'prefer_local') {
                        skipNoChange++; tSkip++;
                        continue;
                    }
                    const lastSyncedHash = state?.last_synced_hash;
                    if (lastSyncedHash && lastSyncedHash === remoteHash) {
                        skipNoChange++; tSkip++;
                    } else {
                        updateDocs.push({ ...cleanDoc, _record_id: record.record_id, _table_id: t.table_id, _remote_modified: null });
                        tUpdate++;
                    }
                } else {
                    newDocs.push({ ...cleanDoc, _record_id: record.record_id, _table_id: t.table_id, _remote_modified: null });
                    tNew++;
                }
            }
            perTable.push({ table: t.name, tableId: t.table_id, total: records.length, created: tNew, updated: tUpdate, skipped: tSkip, invalid: tInvalid });
        }

        // 3. 事务写入(本地写入失败回滚, 不污染飞书侧状态)
        let created = 0, updated = 0;
        db.transaction(() => {
            for (const doc of [...newDocs, ...updateDocs]) {
                const exists = db.prepare('SELECT id FROM assets WHERE id = ?').get(doc.id);
                writeAssetTx(doc, !exists);
                db.prepare(`
                    INSERT INTO feishu_sync_state (asset_id, record_id, table_id, last_synced_at, last_remote_modified_at, last_synced_hash, sync_direction)
                    VALUES (?, ?, ?, datetime('now','localtime'), ?, ?, 'pull')
                    ON CONFLICT(asset_id) DO UPDATE SET record_id=excluded.record_id, table_id=excluded.table_id,
                        last_synced_at=excluded.last_synced_at, last_remote_modified_at=excluded.last_remote_modified_at,
                        last_synced_hash=excluded.last_synced_hash, sync_direction='pull'
                `).run(doc.id, doc._record_id, doc._table_id, String(doc._remote_modified), hashFields(doc, mappings));
                exists ? updated++ : created++;
            }
        })();

        // 4. 保存主体→表路由映射(供 push 使用)
        saveOwnerTableMap(ownerTableMap);

        // 5. 审计 + 更新配置状态
        const stats = { created, updated, skipped: skipNoChange, invalid, total: totalRecords, perTable };
        cfg.lastSyncAt = new Date().toISOString();
        cfg.lastSyncDirection = 'pull';
        cfg.lastSyncStats = stats;
        saveConfig(cfg);

        return stats;
    } finally {
        _syncInProgress = false;
    }
}

// ============ 测试连接 ============
async function testConnection(cfg) {
    // 1. 验证凭证
    await getTenantAccessToken(cfg);
    // 2. 验证多维表格可访问
    const client = new FeishuBitableClient(cfg);
    const fields = await client.listFields();
    // 3. 验证能列出全部数据表(多表同步的前提)
    const tables = await listTables(cfg);
    // 4. 读取 1 条记录验证读权限
    const records = await client.listAllRecords();
    return {
        ok: true, tokenValid: true, tableAccessible: true,
        fieldCount: fields.length, tableCount: tables.length,
        sampleRecordId: records[0]?.record_id || null
    };
}

// ============ 自动探测字段映射 ============
const FIELD_NAME_HINTS = {
    id: ['资产编号', '编号', 'ID'],
    owner: ['归属', '归属人', '所有者'],
    type: ['类型', '资产类型'],
    brandModel: ['品牌型号', '型号'],
    purchaseDate: ['购置日期', '购入日期', '购买日期'],
    value: ['原值', '价值', '金额'],
    quantity: ['数量'],
    status: ['状态'],
    department: ['部门'],
    user: ['使用人', '使用者'],
    location: ['位置', '存放地点'],
    manager: ['管理员', '负责人'],
    unit: ['单位'],
    depreciationYears: ['折旧年限', '折旧'],
    purchaseNo: ['采购编号', '采购单号'],
    paymentNo: ['付款编号', '付款单号'],
    damageReason: ['损坏原因']
};

const FIELD_TYPE_MAP = {
    id: 'text', owner: 'text', type: 'text', brandModel: 'text',
    configuration: 'text', purchaseDate: 'date', status: 'single_select',
    user: 'text', department: 'text', location: 'text', manager: 'text',
    unit: 'text', quantity: 'number', value: 'number',
    depreciationYears: 'number', purchaseNo: 'text', paymentNo: 'text', damageReason: 'text'
};

async function autoDetectFieldMappings(cfg) {
    const client = new FeishuBitableClient(cfg);
    const fields = await client.listFields();
    const suggested = [];
    const usedFeishuFields = new Set();

    for (const [localField, hints] of Object.entries(FIELD_NAME_HINTS)) {
        for (const feishuField of fields) {
            const fieldName = feishuField.field_name;
            if (usedFeishuFields.has(fieldName)) continue;
            if (hints.some(h => fieldName.includes(h))) {
                suggested.push({
                    localField,
                    feishuField: fieldName,
                    type: FIELD_TYPE_MAP[localField] || 'text'
                });
                usedFeishuFields.add(fieldName);
                break;
            }
        }
    }
    return suggested;
}

module.exports = {
    getConfig, saveConfig,
    pushToFeishu, pullFromFeishu,
    testConnection, autoDetectFieldMappings,
    listTables,
    FeishuBitableClient
};
