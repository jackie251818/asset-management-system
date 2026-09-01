/**
 * 自定义下拉选项 REST API
 *
 * 数据来源: 前端 custom_options_owner / custom_options_type / custom_options_department
 * (以及配套 *_deleted 数组), 统一建模到 custom_options 表, deleted=1 表示已软删除。
 *
 * GET    /api/options                  全部选项 { owner: [], type: [], department: [], owner_deleted: [], ... }
 * GET    /api/options/:kind            单类选项 { options: [], deleted: [] }
 * POST   /api/options/:kind            新增 { values: ['xxx'] } (已存在的忽略)
 * DELETE /api/options/:kind/:value     软删除
 * POST   /api/options/:kind/:value/restore  恢复
 */

const Router = require('@koa/router');
const { db } = require('../db');
const { ok, ERR } = require('../errors');
const { requireWrite } = require('../auth');

const router = new Router({ prefix: '/api/options' });

const KINDS = ['owner', 'type', 'department'];

function checkKind(kind) {
    if (!KINDS.includes(kind)) throw ERR.BAD_REQUEST(`选项类别必须是 ${KINDS.join('/')}`);
}

function readKind(kind) {
    const rows = db.prepare('SELECT value, deleted, sort_order FROM custom_options WHERE kind = ? ORDER BY sort_order, value').all(kind);
    return {
        options: rows.filter(r => !r.deleted).map(r => r.value),
        deleted: rows.filter(r => r.deleted).map(r => r.value),
    };
}

/** GET /api/options */
router.get('/', async (ctx) => {
    const data = {};
    for (const kind of KINDS) {
        const r = readKind(kind);
        data[kind] = r.options;
        data[kind + '_deleted'] = r.deleted;
    }
    ok(ctx, data);
});

/** GET /api/options/:kind */
router.get('/:kind', async (ctx) => {
    checkKind(ctx.params.kind);
    ok(ctx, readKind(ctx.params.kind));
});

/** POST /api/options/:kind { values: [] } */
router.post('/:kind', async (ctx) => {
    requireWrite(ctx);
    checkKind(ctx.params.kind);
    const kind = ctx.params.kind;
    const values = Array.isArray(ctx.request.body && ctx.request.body.values)
        ? ctx.request.body.values.map(v => String(v).trim()).filter(Boolean).slice(0, 500)
        : [];
    if (!values.length) throw ERR.BAD_REQUEST('values 不能为空');
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM custom_options WHERE kind = ?').get(kind).m;
    const ins = db.prepare(`INSERT INTO custom_options (kind, value, deleted, sort_order) VALUES (?, ?, 0, ?)
        ON CONFLICT(kind, value) DO UPDATE SET deleted = 0`);
    let added = 0;
    db.transaction(() => {
        values.forEach((v, i) => {
            const existed = db.prepare('SELECT deleted FROM custom_options WHERE kind = ? AND value = ?').get(kind, v);
            ins.run(kind, v, maxOrder + 1 + i);
            if (!existed || existed.deleted) added++;
        });
    })();
    ok(ctx, { added, kind, options: readKind(kind).options }, 201);
});

/** DELETE /api/options/:kind/:value 软删除(与前端 *_deleted 数组语义一致) */
router.delete('/:kind/:value', async (ctx) => {
    requireWrite(ctx);
    checkKind(ctx.params.kind);
    const info = db.prepare('UPDATE custom_options SET deleted = 1 WHERE kind = ? AND value = ?')
        .run(ctx.params.kind, ctx.params.value);
    if (!info.changes) throw ERR.NOT_FOUND('选项不存在');
    ok(ctx, { deleted: true });
});

/** POST /api/options/:kind/:value/restore */
router.post('/:kind/:value/restore', async (ctx) => {
    requireWrite(ctx);
    checkKind(ctx.params.kind);
    const info = db.prepare('UPDATE custom_options SET deleted = 0 WHERE kind = ? AND value = ?')
        .run(ctx.params.kind, ctx.params.value);
    if (!info.changes) throw ERR.NOT_FOUND('选项不存在');
    ok(ctx, { restored: true });
});

module.exports = { router };
