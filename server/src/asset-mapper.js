/**
 * 资产对象映射 - DB 行(snake_case) ↔ 前端资产文档(camelCase, 与现有前端结构完全一致)
 *
 * 前端资产文档结构(见 js/asset-add.js):
 * { id, owner, type, brandModel, configuration, purchaseDate, status, user, department,
 *   location, manager, unit, quantity, value, depreciationYears, purchaseNo, paymentNo,
 *   damageReason, maintenanceRecords: [{date,type,description,manager}],
 *   attachments: [{name,type,size,url,thumbnail}] }
 */

const ASSET_FIELDS = [
    'id', 'owner', 'type', 'brandModel', 'configuration', 'purchaseDate', 'status',
    'user', 'department', 'location', 'manager', 'unit', 'quantity', 'value',
    'depreciationYears', 'purchaseNo', 'paymentNo', 'damageReason',
];

const REQUIRED_FIELDS = ['id', 'owner', 'type', 'brandModel', 'purchaseDate', 'department'];

/** camelCase 字段 → DB snake_case 列名 */
const FIELD_TO_COL = {
    id: 'id', owner: 'owner', type: 'type', brandModel: 'brand_model',
    configuration: 'configuration', purchaseDate: 'purchase_date', status: 'status',
    user: 'user', department: 'department', location: 'location', manager: 'manager',
    unit: 'unit', quantity: 'quantity', value: 'value',
    depreciationYears: 'depreciation_years', purchaseNo: 'purchase_no',
    paymentNo: 'payment_no', damageReason: 'damage_reason',
};

/** 校验并规范化单个资产文档, 返回 { doc, errors } */
function validateAssetDoc(doc) {
    const errors = [];
    if (!doc || typeof doc !== 'object') return { doc: null, errors: ['资产必须是对象'] };
    for (const f of REQUIRED_FIELDS) {
        if (doc[f] === undefined || doc[f] === null || String(doc[f]).trim() === '') {
            errors.push(`缺少必填字段 ${f}`);
        }
    }
    if (errors.length) return { doc: null, errors };
    const clean = {};
    for (const f of ASSET_FIELDS) {
        clean[f] = doc[f] !== undefined && doc[f] !== null ? doc[f] : null;
    }
    clean.quantity = parseInt(doc.quantity, 10) || 1;
    clean.value = parseFloat(doc.value) || 0;
    clean.depreciationYears = parseInt(doc.depreciationYears, 10) || 0;
    if (doc.status === 'damaged') clean.damageReason = doc.damageReason || null;
    clean.maintenanceRecords = Array.isArray(doc.maintenanceRecords)
        ? doc.maintenanceRecords.filter(r => r && typeof r === 'object')
            .map(r => ({
                date: r.date || new Date().toISOString().split('T')[0],
                type: r.type || '',
                description: r.description || '',
                manager: r.manager || '',
            }))
        : [];
    clean.attachments = Array.isArray(doc.attachments)
        ? doc.attachments.filter(a => a && typeof a === 'object')
            .map(a => ({
                name: a.name || '',
                type: a.type || '',
                size: parseInt(a.size, 10) || 0,
                url: typeof a.url === 'string' ? a.url : null,
                thumbnail: typeof a.thumbnail === 'string' ? a.thumbnail : null,
            }))
        : [];
    return { doc: clean, errors: [] };
}

/** 单行(含维保/附件) → 前端资产文档 */
function rowToDoc(row, records, atts) {
    const doc = {};
    for (const f of ASSET_FIELDS) {
        const col = FIELD_TO_COL[f] || f;
        doc[f] = row[col] !== undefined ? row[col] : null;
    }
    doc.version = row.version;
    doc.createdAt = row.created_at;
    doc.updatedAt = row.updated_at;
    doc.maintenanceRecords = (records || []).map(r => ({
        date: r.date, type: r.type, description: r.description, manager: r.manager,
    }));
    doc.attachments = (atts || []).map(a => ({
        name: a.name, type: a.mime_type, size: a.size, url: a.data_url, thumbnail: a.thumbnail,
    }));
    return doc;
}

/** 批量装配: 一次查询取出全部维保/附件, 按资产分组(避免 N+1) */
function rowsToDocs(rows) {
    if (!rows.length) return [];
    const { db } = require('./db');
    const ids = rows.map(r => r.id);
    const marks = ids.map(() => '?').join(',');
    const allRecords = db.prepare(
        `SELECT * FROM maintenance_records WHERE asset_id IN (${marks}) ORDER BY asset_id, sort_order, id`
    ).all(...ids);
    const allAtts = db.prepare(
        `SELECT * FROM attachments WHERE asset_id IN (${marks}) ORDER BY asset_id, sort_order, id`
    ).all(...ids);

    const recMap = new Map();
    for (const r of allRecords) {
        if (!recMap.has(r.asset_id)) recMap.set(r.asset_id, []);
        recMap.get(r.asset_id).push(r);
    }
    const attMap = new Map();
    for (const a of allAtts) {
        if (!attMap.has(a.asset_id)) attMap.set(a.asset_id, []);
        attMap.get(a.asset_id).push(a);
    }
    return rows.map(r => rowToDoc(r, recMap.get(r.id) || [], attMap.get(r.id) || []));
}

module.exports = { ASSET_FIELDS, REQUIRED_FIELDS, validateAssetDoc, rowToDoc, rowsToDocs };
