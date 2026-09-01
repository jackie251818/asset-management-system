/**
 * 资产 REST API
 *
 * GET    /api/assets            分页筛选(服务端过滤)
 * GET    /api/assets/all        全量导出(打印/导出 Excel 用)
 * GET    /api/assets/check-ids?ids=a,b  编号占用检查(导入去重)
 * GET    /api/assets/:id        详情(含维保记录/附件)
 * POST   /api/assets            新增(编号唯一)
 * PUT    /api/assets/:id        更新(乐观锁: body.version 不匹配返回 409/40901)
 * DELETE /api/assets/:id        删除(级联维保记录/附件)
 * POST   /api/assets/batch      批量导入(事务, mode: merge|replace)
 */

const Router = require('@koa/router');
const { db } = require('../db');
const { ok, ERR } = require('../errors');
const { validateAssetDoc, rowsToDocs } = require('../asset-mapper');
const { requireWrite } = require('../auth');

const router = new Router({ prefix: '/api/assets' });

/** 审计日志 */
function audit(ctx, action, target, detail) {
    db.prepare('INSERT INTO audit_log (username, action, target, detail) VALUES (?, ?, ?, ?)')
        .run(ctx.state.user ? ctx.state.user.username : null, action, target, detail || null);
}

const SORTABLE = {
    id: 'a.id', type: 'a.type', department: 'a.department', owner: 'a.owner',
    status: 'a.status', value: 'a.value', purchaseDate: 'a.purchase_date',
    user: 'a."user"', updatedAt: 'a.updated_at',
};

/** 构建筛选 WHERE 子句与参数 */
function buildFilters(q) {
    const conds = [];
    const params = [];
    if (q.keyword) {
        const like = `%${String(q.keyword).trim()}%`;
        conds.push(`(a.id LIKE ? OR a.brand_model LIKE ? OR a.configuration LIKE ? OR a."user" LIKE ?
            OR a.department LIKE ? OR a.location LIKE ? OR a.manager LIKE ? OR a.owner LIKE ? OR a.type LIKE ?)`);
        params.push(like, like, like, like, like, like, like, like, like);
    }
    for (const [param, col] of [['status', 'a.status'], ['type', 'a.type'],
        ['department', 'a.department'], ['owner', 'a.owner'], ['user', 'a."user"']]) {
        if (q[param] && q[param] !== 'all') { conds.push(`${col} = ?`); params.push(String(q[param]).trim()); }
    }
    if (q.purchaseDateFrom) { conds.push('a.purchase_date >= ?'); params.push(String(q.purchaseDateFrom)); }
    if (q.purchaseDateTo) { conds.push('a.purchase_date <= ?'); params.push(String(q.purchaseDateTo)); }
    return conds.length ? { where: ' WHERE ' + conds.join(' AND '), params } : { where: '', params };
}

/** GET /api/assets 分页筛选 */
router.get('/', async (ctx) => {
    const q = ctx.query;
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const size = Math.min(500, Math.max(1, parseInt(q.size, 10) || 20));
    const { where, params } = buildFilters(q);
    const sortCol = SORTABLE[q.sort] || 'a.id';
    const order = String(q.order).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const total = db.prepare(`SELECT COUNT(*) AS n FROM assets a${where}`).get(...params).n;
    const rows = db.prepare(
        `SELECT a.* FROM assets a${where} ORDER BY ${sortCol} ${order} LIMIT ? OFFSET ?`
    ).all(...params, size, (page - 1) * size);

    ok(ctx, { items: rowsToDocs(rows), total, page, size, pages: Math.ceil(total / size) });
});

/** GET /api/assets/all 全量 */
router.get('/all', async (ctx) => {
    const { where, params } = buildFilters(ctx.query);
    const rows = db.prepare(`SELECT a.* FROM assets a${where} ORDER BY a.id ASC`).all(...params);
    ok(ctx, rowsToDocs(rows));
});

/** GET /api/assets/check-ids?ids=a,b,c → 已存在的编号列表 */
router.get('/check-ids', async (ctx) => {
    const ids = String(ctx.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 5000);
    if (!ids.length) return ok(ctx, { existing: [] });
    const marks = ids.map(() => '?').join(',');
    const existing = db.prepare(`SELECT id FROM assets WHERE id IN (${marks})`).all(...ids).map(r => r.id);
    ok(ctx, { existing });
});

/** GET /api/assets/:id */
router.get('/:id', async (ctx) => {
    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(ctx.params.id);
    if (!row) throw ERR.NOT_FOUND('资产不存在: ' + ctx.params.id);
    ok(ctx, rowsToDocs([row])[0]);
});

/** 写入资产主表 + 维保记录 + 附件(调用方负责事务包裹) */
const writeAssetTx = (doc, isNew) => {
    const now = new Date().toISOString();
    if (isNew) {
        db.prepare(`INSERT INTO assets (id, owner, type, brand_model, configuration, purchase_date, status,
            "user", department, location, manager, unit, quantity, value, depreciation_years,
            purchase_no, payment_no, damage_reason, version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
            .run(doc.id, doc.owner, doc.type, doc.brandModel, doc.configuration, doc.purchaseDate,
                doc.status, doc.user, doc.department, doc.location, doc.manager, doc.unit,
                doc.quantity, doc.value, doc.depreciationYears, doc.purchaseNo, doc.paymentNo,
                doc.damageReason, now, now);
    } else {
        db.prepare(`UPDATE assets SET owner = ?, type = ?, brand_model = ?, configuration = ?,
            purchase_date = ?, status = ?, "user" = ?, department = ?, location = ?, manager = ?,
            unit = ?, quantity = ?, value = ?, depreciation_years = ?, purchase_no = ?,
            payment_no = ?, damage_reason = ?, version = version + 1, updated_at = ?
            WHERE id = ?`)
            .run(doc.owner, doc.type, doc.brandModel, doc.configuration, doc.purchaseDate,
                doc.status, doc.user, doc.department, doc.location, doc.manager, doc.unit,
                doc.quantity, doc.value, doc.depreciationYears, doc.purchaseNo, doc.paymentNo,
                doc.damageReason, now, doc.id);
    }
    // 维保记录: 全删全插(记录顺序即前端数组顺序)
    db.prepare('DELETE FROM maintenance_records WHERE asset_id = ?').run(doc.id);
    const insMr = db.prepare('INSERT INTO maintenance_records (asset_id, date, type, description, manager, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    doc.maintenanceRecords.forEach((r, i) => insMr.run(doc.id, r.date, r.type, r.description, r.manager, i));
    // 附件: 全删全插
    db.prepare('DELETE FROM attachments WHERE asset_id = ?').run(doc.id);
    const insAtt = db.prepare('INSERT INTO attachments (asset_id, name, mime_type, size, data_url, thumbnail, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
    doc.attachments.forEach((a, i) => insAtt.run(doc.id, a.name, a.type, a.size, a.url, a.thumbnail, i));
};

/** POST /api/assets 新增 */
router.post('/', async (ctx) => {
    requireWrite(ctx);
    const { doc, errors } = validateAssetDoc(ctx.request.body);
    if (errors.length) throw ERR.BAD_REQUEST('资产数据无效: ' + errors.join('; '));
    if (db.prepare('SELECT id FROM assets WHERE id = ?').get(doc.id)) {
        throw ERR.CONFLICT('资产编号已存在: ' + doc.id);
    }
    db.transaction(() => writeAssetTx(doc, true))();
    audit(ctx, 'asset.create', doc.id);
    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(doc.id);
    ok(ctx, rowsToDocs([row])[0], 201);
});

/** PUT /api/assets/:id 更新(乐观锁) */
router.put('/:id', async (ctx) => {
    requireWrite(ctx);
    const existing = db.prepare('SELECT * FROM assets WHERE id = ?').get(ctx.params.id);
    if (!existing) throw ERR.NOT_FOUND('资产不存在: ' + ctx.params.id);
    const { doc, errors } = validateAssetDoc({ ...ctx.request.body, id: ctx.params.id });
    if (errors.length) throw ERR.BAD_REQUEST('资产数据无效: ' + errors.join('; '));
    const clientVersion = parseInt(ctx.request.body && ctx.request.body.version, 10);
    if (!clientVersion || clientVersion !== existing.version) {
        throw ERR.VERSION_CONFLICT();
    }
    db.transaction(() => writeAssetTx(doc, false))();
    audit(ctx, 'asset.update', doc.id, `v${existing.version} -> v${existing.version + 1}`);
    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(doc.id);
    ok(ctx, rowsToDocs([row])[0]);
});

/** DELETE /api/assets/:id */
router.delete('/:id', async (ctx) => {
    requireWrite(ctx);
    const info = db.prepare('DELETE FROM assets WHERE id = ?').run(ctx.params.id);
    if (!info.changes) throw ERR.NOT_FOUND('资产不存在: ' + ctx.params.id);
    audit(ctx, 'asset.delete', ctx.params.id);
    ok(ctx, { deleted: true });
});

/** POST /api/assets/batch 批量导入(事务: 全部成功或全部回滚) */
router.post('/batch', async (ctx) => {
    requireWrite(ctx);
    const body = ctx.request.body || {};
    const list = Array.isArray(body.assets) ? body.assets : [];
    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    if (!list.length) throw ERR.BAD_REQUEST('assets 不能为空');

    // 先整体校验, 任一无效则拒绝(防脏数据入库)
    const valid = [];
    const invalid = [];
    const seen = new Set();
    list.forEach((raw, i) => {
        const { doc, errors } = validateAssetDoc(raw);
        if (errors.length) { invalid.push({ index: i, id: raw && raw.id, errors }); return; }
        if (seen.has(doc.id)) { invalid.push({ index: i, id: doc.id, errors: ['批量内编号重复'] }); return; }
        seen.add(doc.id);
        valid.push(doc);
    });
    if (invalid.length) {
        throw ERR.BAD_REQUEST(`${invalid.length} 条数据无效, 已整体拒绝: ` +
            invalid.slice(0, 5).map(v => `#${v.index}(${v.id || '无编号'}): ${v.errors[0]}`).join('; '));
    }

    const result = db.transaction(() => {
        const ret = { inserted: 0, updated: 0 };
        if (mode === 'replace') {
            db.prepare('DELETE FROM maintenance_records').run();
            db.prepare('DELETE FROM attachments').run();
            db.prepare('DELETE FROM assets').run();
        }
        for (const doc of valid) {
            const exists = db.prepare('SELECT id FROM assets WHERE id = ?').get(doc.id);
            writeAssetTx(doc, !exists);
            exists ? ret.updated++ : ret.inserted++;
        }
        return ret;
    })();

    audit(ctx, `asset.batch.${mode}`, null, `inserted=${result.inserted}, updated=${result.updated}`);
    ok(ctx, { ...result, mode, total: valid.length });
});

module.exports = { router, writeAssetTx };
