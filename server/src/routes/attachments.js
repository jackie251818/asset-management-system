/**
 * 附件预览 API
 *
 * GET /api/attachments/preview?asset_id=X&name=Y&thumb=0|1
 *   HEIC/HEIF 浏览器无法直接解码, 服务端转 JPEG 后返回(磁盘缓存, 仅转一次)
 *   缩略图 thumb=1: 最长边 480, q70; 大图 thumb=0: 最长边 2048, q85
 *   走标准鉴权头, 前端以 fetch(blob) 方式加载后赋给 <img>, 不直接暴露在 <img src>
 *
 * 转换依赖外部运行时: python3 + pillow-heif(libheif>=1.17, 兼容 iPhone HDR gain-map)
 * 转换环境缺失(如便携版 Windows 无 Python)时返回 501, 前端回退客户端 heic2any/下载
 */

const Router = require('@koa/router');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { db } = require('../db');
const config = require('../config');
const { ApiError, ERR } = require('../errors');

const router = new Router({ prefix: '/api/attachments' });

const CACHE_DIR = path.join(config.DATA_DIR, 'att-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

// 同一 key 的并发请求共享同一次转换
const inflight = new Map();

const VARIANTS = {
    thumb: { maxDim: 480, quality: 70, suffix: 't' },
    full: { maxDim: 2048, quality: 85, suffix: 'f' }
};

function isHeicName(name, mime) {
    return /\.(heic|heif)$/i.test(name || '') || /^image\/hei(c|f)$/i.test(mime || '');
}

// 解析可用的 Python 可执行文件(缓存结果)
let pythonCmd = null;
let pythonChecked = false;
function resolvePython() {
    if (pythonChecked) return Promise.resolve(pythonCmd);
    pythonChecked = true;
    const candidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
    const exec = promisify(execFile);
    return (async () => {
        for (const c of candidates) {
            try {
                await exec(c, ['-c', 'import pillow_heif']);
                pythonCmd = c;
                return c;
            } catch (_) { /* 试下一个 */ }
        }
        return null;
    })();
}

function runConverter(py, input, output, quality, maxDim) {
    return new Promise((resolve, reject) => {
        const script = path.join(__dirname, '..', '..', 'tools', 'heic_convert.py');
        const args = process.platform === 'win32' && py === 'py'
            ? ['-3', script, input, output, String(quality), String(maxDim)]
            : [script, input, output, String(quality), String(maxDim)];
        const child = spawn(py, args, { windowsHide: true });
        let stderr = '';
        child.stderr.on('data', d => { stderr += d; });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve() : reject(new Error((stderr || 'exit ' + code).slice(-500))));
    });
}

async function convertToJpeg(buffer, variant) {
    const py = await resolvePython();
    if (!py) throw new ApiError(501, 50100, '服务端未安装 HEIC 转换环境(python3 + pillow-heif)');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heic-'));
    const input = path.join(tmpDir, 'in.heic');
    const output = path.join(tmpDir, 'out.jpg');
    try {
        fs.writeFileSync(input, buffer);
        await runConverter(py, input, output, variant.quality, variant.maxDim);
        return fs.readFileSync(output);
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
}

/** GET /api/attachments/preview */
router.get('/preview', async (ctx) => {
    const assetId = (ctx.query.asset_id || '').toString();
    const name = (ctx.query.name || '').toString();
    const thumb = ctx.query.thumb === '1' || ctx.query.thumb === 'true';
    if (!assetId || !name) throw ERR.BAD_REQUEST('缺少 asset_id 或 name 参数');

    const row = db.prepare(
        'SELECT name, mime_type, size, data_url FROM attachments WHERE asset_id = ? AND name = ?'
    ).get(assetId, name);
    if (!row) throw ERR.NOT_FOUND('附件不存在');
    if (!isHeicName(row.name, row.mime_type)) throw ERR.BAD_REQUEST('该附件不是 HEIC/HEIF 格式');

    const variant = thumb ? VARIANTS.thumb : VARIANTS.full;
    const cacheKey = crypto.createHash('sha1')
        .update(assetId + '|' + name + '|' + (row.size || 0) + '|' + variant.suffix)
        .digest('hex');
    const cacheFile = path.join(CACHE_DIR, cacheKey + '.jpg');

    let jpeg;
    try {
        jpeg = fs.readFileSync(cacheFile);
        ctx.set('X-Cache', 'HIT');
    } catch (_) {
        if (!inflight.has(cacheKey)) {
            const comma = (row.data_url || '').indexOf(',');
            if (comma < 0) throw ERR.BAD_REQUEST('附件数据格式无效');
            const raw = Buffer.from(row.data_url.slice(comma + 1), 'base64');
            inflight.set(cacheKey, convertToJpeg(raw, variant).then(buf => {
                fs.writeFileSync(cacheFile, buf);
                return buf;
            }).finally(() => inflight.delete(cacheKey)));
        }
        jpeg = await inflight.get(cacheKey);
        ctx.set('X-Cache', 'MISS');
    }

    ctx.set('Cache-Control', 'private, max-age=86400');
    ctx.set('Content-Length', String(jpeg.length));
    ctx.type = 'image/jpeg';
    ctx.body = jpeg;
});

module.exports = { router };
