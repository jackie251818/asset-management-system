/**
 * 飞书同步 REST 路由
 * 全部 requireAdmin (app_secret 敏感)
 *
 * 设计参考: .trae/documents/feishu-bidirectional-sync.md
 */

const Router = require('@koa/router');
const { ok, ERR } = require('../errors');
const { requireAdmin, audit } = require('../auth');
const sync = require('../feishu-sync');
const router = new Router({ prefix: '/api/feishu' });

// 辅助: 掩码 app_secret(GET 返回时防泄露)
function maskSecret(secret) {
    if (!secret || secret.length < 8) return '***';
    return secret.substring(0, 4) + '*'.repeat(Math.max(4, secret.length - 6)) + secret.substring(secret.length - 2);
}

// ============ 配置 CRUD ============

/** GET /api/feishu/config — 读取配置(app_secret 掩码) */
router.get('/config', async (ctx) => {
    requireAdmin(ctx);
    const cfg = sync.getConfig();
    if (cfg && cfg.appSecret) cfg.appSecret = maskSecret(cfg.appSecret);
    ok(ctx, cfg || {});
});

/** POST /api/feishu/config — 保存配置 */
router.post('/config', async (ctx) => {
    requireAdmin(ctx);
    const body = ctx.request.body || {};
    const existing = sync.getConfig() || {};

    // 识别掩码: 如果 appSecret 含 *, 保留原值不覆盖
    let appSecret = body.appSecret;
    if (appSecret && appSecret.includes('*')) {
        appSecret = existing.appSecret;
    }

    const cfg = {
        appId: body.appId || existing.appId || '',
        appSecret: appSecret || existing.appSecret || '',
        appToken: body.appToken || existing.appToken || '',
        tableId: body.tableId || existing.tableId || '',
        fieldNameForAssetId: body.fieldNameForAssetId || existing.fieldNameForAssetId || '资产编号',
        fieldMappings: body.fieldMappings || existing.fieldMappings || [],
        syncOptions: body.syncOptions || existing.syncOptions || { pushEnabled: true, pullEnabled: true, conflictStrategy: 'last_write_wins' },
        lastSyncAt: existing.lastSyncAt || null,
        lastSyncDirection: existing.lastSyncDirection || null,
        lastSyncStats: existing.lastSyncStats || null
    };
    sync.saveConfig(cfg);
    audit(ctx.state.user.username, 'feishu.config.save', 'feishu_sync_config', '配置已保存');
    ok(ctx, { saved: true });
});

/** DELETE /api/feishu/config — 清空配置 */
router.delete('/config', async (ctx) => {
    requireAdmin(ctx);
    const { db } = require('../db');
    db.prepare('DELETE FROM kv_store WHERE key = ?').run('feishu_sync_config');
    audit(ctx.state.user.username, 'feishu.config.delete', 'feishu_sync_config', '配置已清空');
    ok(ctx, { deleted: true });
});

// ============ 连接测试与字段探测 ============

/** POST /api/feishu/test-connection */
router.post('/test-connection', async (ctx) => {
    requireAdmin(ctx);
    const body = ctx.request.body || {};
    const existing = sync.getConfig() || {};
    const cfg = {
        appId: body.appId || existing.appId,
        appSecret: (body.appSecret && !body.appSecret.includes('*')) ? body.appSecret : existing.appSecret,
        appToken: body.appToken || existing.appToken,
        tableId: body.tableId || existing.tableId
    };
    if (!cfg.appId || !cfg.appSecret || !cfg.appToken || !cfg.tableId) {
        throw ERR.BAD_REQUEST('请填写完整的飞书凭证');
    }
    const result = await sync.testConnection(cfg);
    ok(ctx, result);
});

/** GET /api/feishu/fields — 列出飞书表字段(使用已保存配置) */
router.get('/fields', async (ctx) => {
    requireAdmin(ctx);
    const cfg = sync.getConfig();
    if (!cfg) throw ERR.BAD_REQUEST('请先配置飞书凭证');
    const { FeishuBitableClient } = sync;
    const client = new FeishuBitableClient(cfg);
    const fields = await client.listFields();
    ok(ctx, { fields: fields.map(f => ({ field_id: f.field_id, field_name: f.field_name, type: f.type })) });
});

/** POST /api/feishu/fields — 列出字段(允许表单未保存的凭证/表ID临时覆盖) */
router.post('/fields', async (ctx) => {
    requireAdmin(ctx);
    const body = ctx.request.body || {};
    const existing = sync.getConfig() || {};
    const cfg = {
        appId: body.appId || existing.appId,
        appSecret: (body.appSecret && !body.appSecret.includes('*')) ? body.appSecret : existing.appSecret,
        appToken: body.appToken || existing.appToken,
        tableId: body.tableId || existing.tableId
    };
    if (!cfg.appId || !cfg.appSecret || !cfg.appToken || !cfg.tableId) {
        throw ERR.BAD_REQUEST('请先选择数据表');
    }
    const { FeishuBitableClient } = sync;
    const client = new FeishuBitableClient(cfg);
    const fields = await client.listFields();
    ok(ctx, { fields: fields.map(f => ({ field_id: f.field_id, field_name: f.field_name, type: f.type })) });
});

/** GET /api/feishu/tables — 列出多维表格下全部数据表(使用已保存配置) */
router.get('/tables', async (ctx) => {
    requireAdmin(ctx);
    const cfg = sync.getConfig();
    if (!cfg) throw ERR.BAD_REQUEST('请先配置飞书凭证');
    const tables = await sync.listTables(cfg);
    ok(ctx, { tables: tables.map(t => ({ table_id: t.table_id, name: t.name })) });
});

/** POST /api/feishu/tables — 列出数据表(允许表单未保存的凭证临时覆盖) */
router.post('/tables', async (ctx) => {
    requireAdmin(ctx);
    const body = ctx.request.body || {};
    const existing = sync.getConfig() || {};
    const cfg = {
        appId: body.appId || existing.appId,
        appSecret: (body.appSecret && !body.appSecret.includes('*')) ? body.appSecret : existing.appSecret,
        appToken: body.appToken || existing.appToken
    };
    if (!cfg.appId || !cfg.appSecret || !cfg.appToken) {
        throw ERR.BAD_REQUEST('请先填写 App ID / App Secret / App Token');
    }
    const tables = await sync.listTables(cfg);
    ok(ctx, { tables: tables.map(t => ({ table_id: t.table_id, name: t.name })) });
});

/** POST /api/feishu/fields/auto-detect — 自动探测字段映射 */
router.post('/fields/auto-detect', async (ctx) => {
    requireAdmin(ctx);
    const cfg = sync.getConfig();
    if (!cfg) throw ERR.BAD_REQUEST('请先配置飞书凭证');
    const suggested = await sync.autoDetectFieldMappings(cfg);
    ok(ctx, { suggestedMappings: suggested });
});

// ============ 同步操作 ============

/** POST /api/feishu/sync/push — 推送到飞书 */
router.post('/sync/push', async (ctx) => {
    requireAdmin(ctx);
    const result = await sync.pushToFeishu(ctx.request.body || {});
    audit(ctx.state.user.username, 'feishu.sync.push', null,
        `created=${result.created} updated=${result.updated} skipped=${result.skipped} failed=${result.failed.length}`);
    ok(ctx, result);
});

/** POST /api/feishu/sync/pull — 从飞书拉取 */
router.post('/sync/pull', async (ctx) => {
    requireAdmin(ctx);
    const result = await sync.pullFromFeishu(ctx.request.body || {});
    audit(ctx.state.user.username, 'feishu.sync.pull', null,
        `created=${result.created} updated=${result.updated} skipped=${result.skipped} invalid=${result.invalid.length}`);
    ok(ctx, result);
});

/** GET /api/feishu/sync/status — 最近同步状态 */
router.get('/sync/status', async (ctx) => {
    requireAdmin(ctx);
    const cfg = sync.getConfig();
    ok(ctx, {
        lastSyncAt: cfg?.lastSyncAt || null,
        lastSyncDirection: cfg?.lastSyncDirection || null,
        lastSyncStats: cfg?.lastSyncStats || null
    });
});

module.exports = { router };
