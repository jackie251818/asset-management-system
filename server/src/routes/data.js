/**
 * 数据管理 API
 *
 * POST /api/data/clear           清空业务数据(全部资产+维保+附件+盘点批次与明细) — 管理员
 * POST /api/data/factory-reset   恢复出厂设置(需密码验证): 清空全部数据表并重置为默认管理员 — 管理员
 *
 * 说明:
 *  - 统计报表由资产数据派生, 资产清空后报表自动归零, 无需单独处理
 *  - 清空/重置均改变 assets 与 kv_store 内容, /api/data-version 指纹随之变化,
 *    其他端(PC 轮询/手机 App 重新拉取)会自动同步到空状态
 *  - 恢复出厂: users 表重置为 config.DEFAULT_ADMIN(admin/admin123),
 *    kv_store 全清(含系统设置/备份历史/资产卡片模板/飞书同步配置), 审计日志重建
 */

const Router = require('@koa/router');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const config = require('../config');
const { ok, ERR } = require('../errors');
const { requireAdmin } = require('../auth');

const router = new Router({ prefix: '/api/data' });

function audit(username, action, target, detail) {
    db.prepare('INSERT INTO audit_log (username, action, target, detail) VALUES (?, ?, ?, ?)')
        .run(username || null, action, target || null, detail || null);
}

/** 清空盘点相关 kv 键(批次列表 + 各批次明细) */
function clearInventoryKeys() {
    db.prepare("DELETE FROM kv_store WHERE key = 'inventory_sessions' OR key LIKE 'inventory_session_%'").run();
}

/** POST /api/data/clear — 清空业务数据(管理员) */
router.post('/clear', async (ctx) => {
    requireAdmin(ctx);
    let assetCount = 0;
    let sessionCount = 0;
    db.transaction(() => {
        assetCount = db.prepare('SELECT COUNT(*) AS n FROM assets').get().n;
        const sessions = db.prepare("SELECT value_json FROM kv_store WHERE key = 'inventory_sessions'").get();
        if (sessions) {
            try { sessionCount = (JSON.parse(sessions.value_json) || []).length; } catch (e) { sessionCount = 0; }
        }
        // 先清子表再清主表(外键级联本可自动, 显式删除更直观)
        db.prepare('DELETE FROM maintenance_records').run();
        db.prepare('DELETE FROM attachments').run();
        db.prepare('DELETE FROM assets').run();
        clearInventoryKeys();
    })();
    audit(ctx.state.user.username, 'data.clear', 'assets+inventory',
        `清空资产 ${assetCount} 条, 盘点批次 ${sessionCount} 个`);
    ok(ctx, { cleared: true, assets: assetCount, inventorySessions: sessionCount });
});

/** POST /api/data/factory-reset — 恢复出厂设置(管理员 + 密码验证) */
router.post('/factory-reset', async (ctx) => {
    requireAdmin(ctx);
    const { password } = ctx.request.body || {};
    if (!password) throw ERR.BAD_REQUEST('请输入密码验证身份');
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.state.user.id);
    if (!row || !bcrypt.compareSync(String(password), row.password_hash)) {
        audit(ctx.state.user.username, 'data.factory_reset_failed', null, '密码验证失败');
        throw ERR.BAD_REQUEST('密码验证失败, 无法执行恢复出厂设置');
    }

    const operator = ctx.state.user.username;
    db.transaction(() => {
        // 业务数据: 资产三表 + 盘点 + 自定义下拉选项(字段信息)
        db.prepare('DELETE FROM maintenance_records').run();
        db.prepare('DELETE FROM attachments').run();
        db.prepare('DELETE FROM assets').run();
        db.prepare('DELETE FROM custom_options').run();
        // 全部 kv(系统设置/备份历史/资产卡片模板/Excel 格式分析/飞书同步配置等)
        db.prepare('DELETE FROM kv_store').run();
        // 用户账号与审计日志重置
        db.prepare('DELETE FROM audit_log').run();
        db.prepare('DELETE FROM users').run();
        db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
            .run(config.DEFAULT_ADMIN.username, bcrypt.hashSync(config.DEFAULT_ADMIN.password, 10), config.DEFAULT_ADMIN.role);
    })();
    // 重建后的全新审计首条记录
    audit(operator, 'data.factory_reset', 'system', '系统已恢复出厂设置, 数据与账号已重置');

    ok(ctx, { reset: true, defaultAdmin: { username: config.DEFAULT_ADMIN.username } });
});

module.exports = { router };
