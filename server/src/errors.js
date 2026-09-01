/**
 * 统一错误与响应格式
 *
 * 成功响应: { code: 0, message: 'ok', data: ... }
 * 失败响应: { code: <业务码>, message: <中文描述> }  HTTP 状态码同时设置
 */

class ApiError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const ERR = {
    BAD_REQUEST:   (msg) => new ApiError(400, 40000, msg || '请求参数错误'),
    UNAUTHORIZED:  (msg) => new ApiError(401, 40100, msg || '未登录或凭证已过期'),
    FORBIDDEN:     (msg) => new ApiError(403, 40300, msg || '没有操作权限'),
    NOT_FOUND:     (msg) => new ApiError(404, 40400, msg || '资源不存在'),
    CONFLICT:      (msg) => new ApiError(409, 40900, msg || '资源冲突'),
    VERSION_CONFLICT: () => new ApiError(409, 40901, '数据已被其他用户修改, 请刷新后重试'),
    INTERNAL:      (msg) => new ApiError(500, 50000, msg || '服务器内部错误'),
};

/** 成功响应 */
function ok(ctx, data, status = 200) {
    ctx.status = status;
    ctx.body = { code: 0, message: 'ok', data };
}

/** 全局错误中间件 */
function errorMiddleware() {
    return async (ctx, next) => {
        try {
            await next();
        } catch (err) {
            if (err instanceof ApiError) {
                ctx.status = err.status;
                ctx.body = { code: err.code, message: err.message };
                return;
            }
            // better-sqlite3 唯一约束冲突
            if (err && /UNIQUE constraint/.test(err.message || '')) {
                ctx.status = 409;
                ctx.body = { code: 40900, message: '数据已存在(唯一性冲突)' };
                return;
            }
            console.error('[server] 未处理异常:', err);
            ctx.status = 500;
            ctx.body = { code: 50000, message: '服务器内部错误: ' + (err.message || 'unknown') };
        }
    };
}

module.exports = { ApiError, ERR, ok, errorMiddleware };
