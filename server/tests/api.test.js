/**
 * 服务端 API 冒烟测试 - 覆盖认证/资产CRUD/乐观锁/分页筛选/批量导入事务/选项/统计/兼容层/迁移工具
 *
 * 运行: npm test  (在 server/ 目录)
 * 原理: 以临时数据库 + 随机端口启动服务端子进程, 全流程断言, 结束后清理
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.error(`  FAIL ${name}${extra ? ' - ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}

async function api(base, method, url, { token, body, headers } = {}) {
    const h = { 'Content-Type': 'application/json', ...(headers || {}) };
    if (token) h['Authorization'] = 'Bearer ' + token;
    const resp = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await resp.json(); } catch (_) {}
    return { status: resp.status, json };
}

function makeAsset(i, over = {}) {
    return {
        id: `PC-2026-${String(i).padStart(4, '0')}`,
        owner: '信息中心', type: '笔记本电脑', brandModel: 'ThinkPad T14',
        configuration: 'i7/16G/512G', purchaseDate: `2025-0${(i % 9) + 1}-15`, status: 'active',
        user: `用户${i}`, department: i % 2 === 0 ? '财务部' : '人事部', location: `3楼-${i}室`,
        manager: '张三', unit: '台', quantity: 1, value: 6000 + i * 100, depreciationYears: 5,
        purchaseNo: `PO-${i}`, paymentNo: `PAY-${i}`, damageReason: null,
        maintenanceRecords: i % 3 === 0 ? [{ date: '2026-01-10', type: '保养', description: '清灰', manager: '李四' }] : [],
        attachments: i % 3 === 1 ? [{ name: '发票.png', type: 'image/png', size: 1000, url: 'data:image/png;base64,iVBORw0KGgo=', thumbnail: null }] : [],
        ...over,
    };
}

async function main() {
    // ============ 环境准备 ============
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-server-test-'));
    const dbPath = path.join(tmp, 'test.db');
    const port = 3457 + Math.floor(Math.random() * 500);
    const base = `http://127.0.0.1:${port}`;

    const child = spawn(process.execPath, ['src/index.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, ASSET_PORT: String(port), ASSET_DATA_DIR: tmp, ASSET_DB_PATH: dbPath },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => console.error('[server-err]', String(d).trim()));

    const waitReady = async () => {
        for (let i = 0; i < 50; i++) {
            try {
                const r = await fetch(base + '/api/ping');
                if (r.ok) return true;
            } catch (_) {}
            await new Promise(res => setTimeout(res, 200));
        }
        return false;
    };
    const ready = await waitReady();
    check('服务端启动且 /api/ping 可达(免鉴权)', ready);
    if (!ready) { child.kill(); process.exit(1); }

    try {
        // ============ 认证 ============
        let r = await api(base, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong' } });
        check('错误密码登录 → 401', r.status === 401);
        r = await api(base, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
        check('管理员登录成功', r.status === 200 && r.json.data && r.json.data.token, r.json);
        const admin = r.json.data.token;

        r = await api(base, 'GET', '/api/assets');
        check('未鉴权访问 /api/assets → 401', r.status === 401);

        // ============ 资产 CRUD ============
        const a1 = makeAsset(1);
        r = await api(base, 'POST', '/api/assets', { token: admin, body: a1 });
        check('新增资产 → 201 且返回 version=1', r.status === 201 && r.json.data.version === 1, r.json);
        check('新增资产返回维保/附件结构一致', Array.isArray(r.json.data.maintenanceRecords) && Array.isArray(r.json.data.attachments));
        check('新增资产多词字段完整回读', r.json.data.brandModel === 'ThinkPad T14' && r.json.data.purchaseDate === a1.purchaseDate
            && r.json.data.depreciationYears === 5 && r.json.data.purchaseNo === 'PO-1', r.json.data);

        r = await api(base, 'POST', '/api/assets', { token: admin, body: a1 });
        check('重复编号 → 409', r.status === 409);

        r = await api(base, 'POST', '/api/assets', { token: admin, body: { ...a1, id: 'PC-X', owner: '' } });
        check('缺必填字段 → 400', r.status === 400);

        r = await api(base, 'GET', `/api/assets/${a1.id}`, { token: admin });
        check('按编号查询资产', r.status === 200 && r.json.data.id === a1.id);

        r = await api(base, 'PUT', `/api/assets/${a1.id}`, { token: admin, body: { ...a1, user: '新用户', version: 99 } });
        check('乐观锁 version 不匹配 → 409/40901', r.status === 409 && r.json.code === 40901, r.json);

        r = await api(base, 'PUT', `/api/assets/${a1.id}`, { token: admin, body: { ...a1, user: '新用户', version: 1 } });
        check('乐观锁匹配更新成功 version→2', r.status === 200 && r.json.data.version === 2 && r.json.data.user === '新用户', r.json);

        // ============ 分页筛选 ============
        for (let i = 2; i <= 12; i++) await api(base, 'POST', '/api/assets', { token: admin, body: makeAsset(i) });
        r = await api(base, 'GET', '/api/assets?page=1&size=5', { token: admin });
        check('分页: total=12, items=5', r.json.data.total === 12 && r.json.data.items.length === 5, r.json.data);
        r = await api(base, 'GET', '/api/assets?department=' + encodeURIComponent('财务部') + '&size=100', { token: admin });
        check('部门筛选(财务部偶数编号=6条)', r.json.data.total === 6, r.json.data);
        r = await api(base, 'GET', '/api/assets?keyword=' + encodeURIComponent('ThinkPad') + '&size=100', { token: admin });
        check('关键字筛选命中品牌型号', r.json.data.total === 12);
        r = await api(base, 'GET', `/api/assets/${a1.id}`, { token: admin });
        check('详情含附件数据', Array.isArray(r.json.data.attachments) && r.json.data.attachments.length === 1);
        r = await api(base, 'GET', '/api/assets?sort=value&order=desc&size=1', { token: admin });
        check('按价值倒序排序', r.json.data.items[0].value === 7200);

        // ============ 批量导入(事务) ============
        const batch = [makeAsset(101), makeAsset(102), { ...makeAsset(103), brandModel: '' }];
        r = await api(base, 'POST', '/api/assets/batch', { token: admin, body: { assets: batch } });
        check('批量导入含无效数据 → 400 整体拒绝', r.status === 400);
        r = await api(base, 'GET', '/api/assets/check-ids?ids=' + encodeURIComponent('PC-2026-0101,PC-2026-0102'), { token: admin });
        check('整体拒绝后未入库(check-ids 为空)', r.json.data.existing.length === 0, r.json.data);

        r = await api(base, 'POST', '/api/assets/batch', { token: admin, body: { assets: [makeAsset(101), makeAsset(102)] } });
        check('批量导入 merge → inserted=2', r.status === 200 && r.json.data.inserted === 2, r.json);

        r = await api(base, 'POST', '/api/assets/batch', { token: admin, body: { assets: [makeAsset(101, { value: 99999 })] } });
        check('批量导入 merge 已存在 → updated=1', r.json.data.updated === 1 && r.json.data.inserted === 0, r.json);

        // ============ 选项 ============
        r = await api(base, 'POST', '/api/options/department', { token: admin, body: { values: ['财务部', '人事部', '技术部'] } });
        check('新增部门选项', r.status === 201, r.json);
        r = await api(base, 'DELETE', '/api/options/department/' + encodeURIComponent('技术部'), { token: admin });
        check('软删除选项', r.status === 200);
        r = await api(base, 'GET', '/api/options/department', { token: admin });
        check('选项: active 2 + deleted 1', r.json.data.options.length === 2 && r.json.data.deleted.length === 1, r.json.data);
        r = await api(base, 'POST', '/api/options/department/' + encodeURIComponent('技术部') + '/restore', { token: admin });
        check('恢复选项', r.status === 200 && (await api(base, 'GET', '/api/options/department', { token: admin })).json.data.deleted.length === 0);

        // ============ 统计 ============
        r = await api(base, 'GET', '/api/stats/summary', { token: admin });
        check('统计: total=14', r.json.data.total === 14, r.json.data);
        check('统计: byDepartment 含两部门', r.json.data.byDepartment['财务部'] === 7 && r.json.data.byDepartment['人事部'] === 7, r.json.data.byDepartment);
        check('统计: 含维保记录流水', Array.isArray(r.json.data.recentMaintenance) && r.json.data.recentMaintenance.length === 5, r.json.data.recentMaintenance);

        // ============ 角色权限 ============
        r = await api(base, 'POST', '/api/users', { token: admin, body: { username: 'viewer1', password: '123456', role: 'viewer' } });
        check('管理员创建 viewer 账号', r.status === 201, r.json);
        r = await api(base, 'POST', '/api/auth/login', { body: { username: 'viewer1', password: '123456' } });
        const viewer = r.json.data.token;
        r = await api(base, 'GET', '/api/assets?page=1&size=1', { token: viewer });
        check('viewer 可读', r.status === 200);
        r = await api(base, 'POST', '/api/assets', { token: viewer, body: makeAsset(200) });
        check('viewer 写入 → 403', r.status === 403);
        r = await api(base, 'POST', '/api/users', { token: viewer, body: { username: 'x', password: '123456', role: 'admin' } });
        check('viewer 管理用户 → 403', r.status === 403);

        // ============ 兼容层 ============
        // ============ 阶段3 新端点 ============
        r = await api(base, 'GET', '/api/info');
        check('/api/info 携带 cs=true 标识(前端启用登录守卫)', r.status === 200 && r.json.cs === true, r.json);
        r = await api(base, 'GET', '/api/data-version');
        check('/api/data-version 返回指纹(需登录, 前端轮询自动带 token)', r.status === 401, r.json);
        r = await api(base, 'GET', '/api/data-version', { token: admin });
        check('/api/data-version 登录后返回指纹', r.status === 200 && typeof r.json.stamp === 'string', r.json);
        const stampBefore = r.json.stamp;
        await api(base, 'POST', '/api/assets', { token: admin, body: makeAsset(400) });
        r = await api(base, 'GET', '/api/data-version', { token: admin });
        check('资产变更后指纹变化(多人轮询依据)', r.json.stamp !== stampBefore, { before: stampBefore, after: r.json.stamp });
        await api(base, 'DELETE', `/api/assets/PC-2026-0400`, { token: admin });
        r = await api(base, 'GET', '/api/assets/all', { token: admin });
        check('/api/assets/all 全量(含维保/附件, 供导出)', r.status === 200 && r.json.data.length === 14
            && r.json.data.every(d => Array.isArray(d.maintenanceRecords) && Array.isArray(d.attachments)), r.json.data && r.json.data.length);
        r = await api(base, 'GET', '/api/assets/all');
        check('/api/assets/all 未鉴权 → 401', r.status === 401);

        r = await api(base, 'GET', '/api/list');
        check('兼容 /api/list 免鉴权', r.status === 200 && r.json.success === true);
        r = await api(base, 'GET', '/api/load?key=assetManagementData', { token: admin });
        check('兼容 /api/load 资产全量(14条, 结构与前端一致)', r.status === 200 && r.json.success === true && r.json.data.length === 14
            && r.json.data.every(d => d.id && 'brandModel' in d && Array.isArray(d.maintenanceRecords)), r.json.data && r.json.data[0]);
        r = await api(base, 'GET', '/api/load?key=custom_options_department', { token: admin });
        check('兼容 /api/load 选项数组', r.status === 200 && Array.isArray(r.json.data) && r.json.data.length === 3);
        r = await api(base, 'POST', '/api/save?key=userStateData', { token: admin, body: { key: 'userStateData', value: { currentPage: 1, systemSettings: { systemName: '测试系统' } } } });
        check('兼容 /api/save kv 键(Bearer 鉴权)', r.status === 200);
        r = await api(base, 'GET', '/api/load?key=userStateData', { token: admin });
        check('兼容 /api/load kv 回读', r.status === 200 && r.json.data && r.json.data.systemSettings.systemName === '测试系统', r.json);
        r = await api(base, 'POST', '/api/save?key=custom_options_owner', {
            token: admin, headers: {}, body: { key: 'custom_options_owner', value: ['信息中心', '后勤部'] },
        });
        // 用 x-server-token 方式再测一次写
        r = await api(base, 'POST', '/api/save?key=systemSettings', {
            token: null, body: { key: 'systemSettings', value: { a: 1 } }, headers: { 'X-Server-Token': admin },
        });
        check('兼容 /api/save 支持 X-Server-Token', r.status === 200, r.json);
        r = await api(base, 'POST', '/api/save?key=assetManagementData', { body: { key: 'assetManagementData', value: [] } });
        check('兼容 /api/save 未鉴权 → 401', r.status === 401);
        r = await api(base, 'DELETE', '/api/delete?key=userStateData', { token: admin });
        check('兼容 /api/delete kv 键', r.status === 200);
        r = await api(base, 'DELETE', '/api/delete?key=assetManagementData', { token: admin });
        check('兼容 /api/delete 拒绝删除资产全量', r.status === 400);

        // ============ 审计日志 ============
        r = await api(base, 'GET', '/api/assets', { token: admin });
        // 审计无独立查询接口, 仅验证写操作后 audit_log 表有记录(通过统计间接验证即可, 跳过直接断言)

        // ============ 资产删除(级联) ============
        r = await api(base, 'DELETE', `/api/assets/${a1.id}`, { token: admin });
        check('删除资产', r.status === 200);
        r = await api(base, 'GET', `/api/assets/${a1.id}`, { token: admin });
        check('删除后查询 → 404', r.status === 404);
        r = await api(base, 'GET', '/api/stats/summary', { token: admin });
        check('删除后统计 total=13', r.json.data.total === 13);
    } finally {
        child.kill();
        await new Promise(res => setTimeout(res, 300));
    }

    // ============ 迁移工具 ============
    console.log('\n[migrate] 测试数据迁移工具...');
    const fixtureDir = path.join(tmp, 'legacy-data');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, 'assetManagementData.json'), JSON.stringify([makeAsset(301), makeAsset(302), { id: '', owner: 'x' }]));
    fs.writeFileSync(path.join(fixtureDir, 'custom_options_type.json'), JSON.stringify(['台式机', '打印机']));
    fs.writeFileSync(path.join(fixtureDir, 'custom_options_type_deleted.json'), JSON.stringify(['旧类型']));
    fs.writeFileSync(path.join(fixtureDir, 'userStateData.js'),
        `window.__LOCAL_DATA__ = window.__LOCAL_DATA__ || {};\nwindow.__LOCAL_DATA__.userStateData = {"currentPage":3,"systemSettings":{"systemName":"旧系统"}};\n`);
    // .js 格式资产文件
    fs.writeFileSync(path.join(fixtureDir, 'assetManagementData.js'),
        `window.__LOCAL_DATA__ = window.__LOCAL_DATA__ || {};\nwindow.__LOCAL_DATA__.assetManagementData = ${JSON.stringify([makeAsset(301), makeAsset(302), { id: '', owner: 'x' }])};\n`);

    const migDb = path.join(tmp, 'migrated.db');
    const run = (cmd) => new Promise(res => {
        const p = spawn(process.execPath, cmd, { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        p.stdout.on('data', d => out += d);
        p.stderr.on('data', d => out += d);
        p.on('close', code => res({ code, out }));
    });

    let mr = await run(['src/migrate.js', '--source', fixtureDir, '--db', migDb, '--mode', 'merge']);
    check('迁移: 含无效数据时拒绝执行(防数据丢失)', mr.code === 1 && mr.out.includes('无效数据'), mr.out);

    // 移除无效数据源后重试
    const validList = [makeAsset(301), makeAsset(302)];
    fs.writeFileSync(path.join(fixtureDir, 'assetManagementData.json'), JSON.stringify(validList));
    mr = await run(['src/migrate.js', '--source', fixtureDir, '--db', migDb, '--mode', 'merge']);
    check('迁移: 成功且核对报告全部 PASS', mr.code === 0 && mr.out.includes('PASS') && !mr.out.includes('FAIL'), mr.out);
    check('迁移: 备份目录已创建', fs.readdirSync(fixtureDir).some(d => d.startsWith('_migrate_backup_')));

    mr = await run(['src/migrate.js', '--source', fixtureDir, '--db', migDb, '--dry-run']);
    check('迁移: --dry-run 不写库', mr.code === 0 && mr.out.includes('未写入数据库'));

    // 验证迁移结果: 用迁移后的库启动服务端再读
    const port2 = port + 1;
    const base2 = `http://127.0.0.1:${port2}`;
    const child2 = spawn(process.execPath, ['src/index.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, ASSET_PORT: String(port2), ASSET_DATA_DIR: tmp, ASSET_DB_PATH: migDb },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child2.stdout.on('data', () => {});
    try {
        for (let i = 0; i < 50; i++) { try { const rr = await fetch(base2 + '/api/ping'); if (rr.ok) break; } catch (_) {} await new Promise(res => setTimeout(res, 200)); }
        const login = await api(base2, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
        const tk = login.json.data.token;
        let rr = await api(base2, 'GET', '/api/assets?size=100', { token: tk });
        check('迁移库: 资产 2 条且字段完整', rr.json.data.total === 2 && rr.json.data.items[0].brandModel === 'ThinkPad T14', rr.json.data);
        rr = await api(base2, 'GET', '/api/options/type', { token: tk });
        check('迁移库: 选项 active 2 + deleted 1', rr.json.data.options.length === 2 && rr.json.data.deleted.length === 1, rr.json.data);
        rr = await api(base2, 'GET', '/api/load?key=userStateData', { token: tk });
        check('迁移库: .js 源 kv 键解析正确(systemName=旧系统)', rr.status === 200 && rr.json.data.systemSettings.systemName === '旧系统', rr.json);
    } finally {
        child2.kill();
    }

    // ============ 清理 ============
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

    console.log('\n==============================================');
    console.log(`结果: ${passed} 通过, ${failed} 失败`);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('[test] 异常:', e); process.exit(1); });
