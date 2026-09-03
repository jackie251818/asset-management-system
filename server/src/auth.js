/**
 * 认证与用户管理
 *
 * 角色权限:
 *   admin  全部权限(含用户管理)
 *   editor 数据读写
 *   viewer 只读(GET)
 *
 * 免鉴权路由: POST /api/auth/login, GET /api/ping, GET /api/list, GET /api/info
 * 其余 /api/* 一律要求 Authorization: Bearer <token>
 * (兼容层另接受 X-Server-Token 头携带 JWT, 供旧前端 window.__SERVER_TOKEN__ 注入)
 */

const Router = require('@koa/router');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const config = require('./config');
const { ok, ERR } = require('./errors');

const router = new Router({ prefix: '/api/auth' });

function signToken(user) {
    return jwt.sign({ uid: user.id, username: user.username, role: user.role },
        config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES });
}

function getUserById(id) {
    return db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id);
}

/** 鉴权中间件: 校验 JWT, 注入 ctx.state.user { uid, username, role } */
function authMiddleware() {
    return async (ctx, next) => {
        const header = (ctx.headers['authorization'] || '').toString();
        const legacy = (ctx.headers['x-server-token'] || '').toString();
        const token = header.replace(/^Bearer\s+/i, '').trim() || legacy.trim();
        if (!token) throw ERR.UNAUTHORIZED('缺少登录凭证, 请先登录');
        let payload;
        try {
            payload = jwt.verify(token, config.JWT_SECRET);
        } catch (_) {
            throw ERR.UNAUTHORIZED('登录凭证无效或已过期, 请重新登录');
        }
        const user = getUserById(payload.uid);
        if (!user) throw ERR.UNAUTHORIZED('账号不存在或已被删除');
        ctx.state.user = user;
        await next();
    };
}

/** 写操作权限检查(viewer 拒绝) */
function requireWrite(ctx) {
    if (ctx.state.user.role === 'viewer') throw ERR.FORBIDDEN('只读账号无权执行写操作');
}

/** 管理员权限检查 */
function requireAdmin(ctx) {
    if (ctx.state.user.role !== 'admin') throw ERR.FORBIDDEN('该操作需要管理员权限');
}

/** 审计日志(与 routes/assets.js 的 audit_log 表共用) */
function audit(username, action, target, detail) {
    db.prepare('INSERT INTO audit_log (username, action, target, detail) VALUES (?, ?, ?, ?)')
        .run(username || null, action, target || null, detail || null);
}

// ============ 认证路由 ============

/** POST /api/auth/login { username, password } → { token, user } */
router.post('/login', async (ctx) => {
    const { username, password } = ctx.request.body || {};
    if (!username || !password) throw ERR.BAD_REQUEST('请输入用户名和密码');
    const name = String(username).trim();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(name);
    if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
        audit(name, 'auth.login_failed', null, '用户名或密码错误');   // 登录失败审计
        throw ERR.UNAUTHORIZED('用户名或密码错误');
    }
    audit(user.username, 'auth.login');                               // 登录成功审计
    ok(ctx, { token: signToken(user), user: { id: user.id, username: user.username, role: user.role } });
});

/** GET /api/auth/me → 当前用户信息 */
router.get('/me', async (ctx) => {
    ok(ctx, { id: ctx.state.user.id, username: ctx.state.user.username, role: ctx.state.user.role });
});

/** POST /api/auth/logout — 退出审计(JWT 无状态, 凭证由前端清除) */
router.post('/logout', async (ctx) => {
    audit(ctx.state.user.username, 'auth.logout');
    ok(ctx, { loggedOut: true });
});

/** POST /api/auth/change-password { oldPassword, newPassword } */
router.post('/change-password', async (ctx) => {
    const { oldPassword, newPassword } = ctx.request.body || {};
    if (!oldPassword || !newPassword) throw ERR.BAD_REQUEST('请提供旧密码和新密码');
    if (String(newPassword).length < 6) throw ERR.BAD_REQUEST('新密码长度至少 6 位');
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.state.user.id);
    if (!bcrypt.compareSync(String(oldPassword), row.password_hash)) throw ERR.BAD_REQUEST('旧密码错误');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(bcrypt.hashSync(String(newPassword), 10), ctx.state.user.id);
    audit(ctx.state.user.username, 'user.change_password');           // 修改自己密码审计
    ok(ctx, { changed: true });
});

// ============ 用户管理(admin) ============

const usersRouter = new Router({ prefix: '/api/users' });

/** GET /api/users */
usersRouter.get('/', async (ctx) => {
    requireAdmin(ctx);
    ok(ctx, db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all());
});

/** POST /api/users { username, password, role } */
usersRouter.post('/', async (ctx) => {
    requireAdmin(ctx);
    const { username, password, role } = ctx.request.body || {};
    if (!username || !password) throw ERR.BAD_REQUEST('用户名和密码不能为空');
    if (String(password).length < 6) throw ERR.BAD_REQUEST('密码长度至少 6 位');
    if (!['admin', 'editor', 'viewer'].includes(role)) throw ERR.BAD_REQUEST('角色必须是 admin/editor/viewer');
    const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
        .run(String(username).trim(), bcrypt.hashSync(String(password), 10), role);
    audit(ctx.state.user.username, 'user.create', String(username).trim(), 'role=' + role);
    ok(ctx, { id: info.lastInsertRowid, username, role }, 201);
});

/** DELETE /api/users/:id */
usersRouter.delete('/:id', async (ctx) => {
    requireAdmin(ctx);
    const id = parseInt(ctx.params.id, 10);
    if (id === ctx.state.user.id) throw ERR.BAD_REQUEST('不能删除自己的账号');
    const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
    if (!target) throw ERR.NOT_FOUND('用户不存在');
    // 保护最后一个 admin: 若被删者是 admin 且当前 admin 仅剩 1 个, 拒绝(避免锁死系统)
    if (target.role === 'admin') {
        const adminCount = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?').get('admin').n;
        if (adminCount <= 1) throw ERR.BAD_REQUEST('不能删除最后一个管理员账号(至少保留一个)');
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    audit(ctx.state.user.username, 'user.delete', target.username, 'role=' + target.role);
    ok(ctx, { deleted: true });
});

/** PATCH /api/users/:id { password?, role? } — admin 重置他人密码 / 修改角色 */
usersRouter.patch('/:id', async (ctx) => {
    requireAdmin(ctx);
    const id = parseInt(ctx.params.id, 10);
    const { password, role } = ctx.request.body || {};
    const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
    if (!target) throw ERR.NOT_FOUND('用户不存在');

    // 修改角色: 校验取值 + 最后一个 admin 不能降级保护
    if (role !== undefined) {
        if (!['admin', 'editor', 'viewer'].includes(role)) throw ERR.BAD_REQUEST('角色必须是 admin/editor/viewer');
        if (target.role === 'admin' && role !== 'admin') {
            const adminCount = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?').get('admin').n;
            if (adminCount <= 1) throw ERR.BAD_REQUEST('不能降级最后一个管理员账号(至少保留一个)');
        }
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
        audit(ctx.state.user.username, 'user.change_role', target.username, target.role + ' -> ' + role);
    }
    // 重置密码: 长度校验 + bcrypt 哈希(轮次 10, 与创建/登录一致)
    if (password !== undefined) {
        if (String(password).length < 6) throw ERR.BAD_REQUEST('密码长度至少 6 位');
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
            .run(bcrypt.hashSync(String(password), 10), id);
        audit(ctx.state.user.username, 'user.reset_password', target.username);
    }
    ok(ctx, { id, username: target.username, role: role !== undefined ? role : target.role });
});

// ============ 操作日志查询(admin) ============

const auditRouter = new Router({ prefix: '/api/audit' });

/** GET /api/audit?page=1&pageSize=50&action=auth&username=x
 *  action 按前缀筛选: auth(登录相关) / asset(资产操作) / user(用户管理) */
auditRouter.get('/', async (ctx) => {
    requireAdmin(ctx);
    const page = Math.max(1, parseInt(ctx.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(ctx.query.pageSize, 10) || 50));
    const action = (ctx.query.action || '').toString().trim();
    const username = (ctx.query.username || '').toString().trim();
    const where = [];
    const params = [];
    if (action) { where.push('action LIKE ?'); params.push(action + '%'); }
    if (username) { where.push('username LIKE ?'); params.push('%' + username + '%'); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${whereSql}`).get(...params).n;
    const items = db.prepare(
        `SELECT id, username, action, target, detail, created_at FROM audit_log ${whereSql}
         ORDER BY id DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, (page - 1) * pageSize);
    ok(ctx, { items, total, page, pageSize });
});

module.exports = { authMiddleware, requireWrite, requireAdmin, audit, authRouter: router, usersRouter, auditRouter };
