/**
 * 统计 REST API - 服务端聚合, 替代前端全量加载后内存计算
 *
 * GET /api/stats/summary
 *   { total, totalValue, totalQuantity, byStatus, byType, byDepartment, byOwner,
 *     byPurchaseYear, recentMaintenance: [...] }
 */

const Router = require('@koa/router');
const { db } = require('../db');
const { ok } = require('../errors');

const router = new Router({ prefix: '/api/stats' });

function groupCount(col) {
    const rows = db.prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM assets WHERE ${col} IS NOT NULL AND ${col} != '' GROUP BY ${col} ORDER BY n DESC`).all();
    const out = {};
    for (const r of rows) out[r.k] = r.n;
    return out;
}

/** GET /api/stats/summary */
router.get('/summary', async (ctx) => {
    const totals = db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(value), 0) AS totalValue,
        COALESCE(SUM(quantity), 0) AS totalQuantity
        FROM assets`).get();

    const years = db.prepare(`SELECT substr(purchase_date, 1, 4) AS y, COUNT(*) AS n
        FROM assets WHERE purchase_date IS NOT NULL AND length(purchase_date) >= 4
        GROUP BY y ORDER BY y`).all();
    const byPurchaseYear = {};
    for (const r of years) byPurchaseYear[r.y] = r.n;

    const recentMaintenance = db.prepare(`SELECT m.asset_id, m.date, m.type, m.description, m.manager,
        a.type AS asset_type, a.brand_model, a."user" AS asset_user
        FROM maintenance_records m LEFT JOIN assets a ON a.id = m.asset_id
        ORDER BY m.date DESC, m.id DESC LIMIT 20`).all();

    ok(ctx, {
        total: totals.total,
        totalValue: totals.totalValue,
        totalQuantity: totals.totalQuantity,
        byStatus: groupCount('status'),
        byType: groupCount('type'),
        byDepartment: groupCount('department'),
        byOwner: groupCount('owner'),
        byPurchaseYear,
        recentMaintenance,
    });
});

module.exports = { router };
