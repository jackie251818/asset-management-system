/**
 * 服务端 EXE 功能冒烟验证 - 对运行中的 asset-server.exe 全面断言
 */
const B = 'http://127.0.0.1:8399';
let passed = 0, failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  PASS ' + name); }
    else { failed++; console.error('  FAIL ' + name + (extra ? ' - ' + JSON.stringify(extra).slice(0, 200) : '')); }
}

async function main() {
    const p = await fetch(B + '/api/ping');
    check('GET /api/ping 可达(免鉴权)', p.status === 200);

    const html = await fetch(B + '/index.html').then(r => r.text());
    check('静态首页 index.html 内置于 EXE 并可访问', html.includes('js/api.js') && html.includes('js/storage.js'));

    const login = await fetch(B + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    }).then(r => r.json());
    // REST 层统一响应格式为 {code, message, data}(区别于兼容层的 {success, data})
    check('管理员登录成功', login.data && login.data.token);
    const tk = login.data.token;

    const cr = await fetch(B + '/api/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk },
        body: JSON.stringify({
            id: 'EXE-TEST-001', owner: '测试主体', type: '笔记本电脑', brandModel: 'Test T14',
            purchaseDate: '2026-08-30', status: 'active', user: '测试用户', department: '测试部',
            unit: '台', quantity: 1, value: 1000, depreciationYears: 5,
            maintenanceRecords: [], attachments: [],
        }),
    });
    check('创建资产(REST)', cr.status === 200 || cr.status === 201, cr.status);

    const list = await fetch(B + '/api/assets', { headers: { Authorization: 'Bearer ' + tk } }).then(r => r.json());
    check('资产列表查询', Array.isArray(list.data.items) && list.data.total === 1 && list.data.items[0].id === 'EXE-TEST-001', list.data);

    const put = await fetch(B + '/api/assets/EXE-TEST-001', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk },
        body: JSON.stringify({ ...list.data.items[0], user: '改过的用户', version: 1 }),
    });
    check('编辑资产(乐观锁 version=1)', put.status === 200);

    const dv = await fetch(B + '/api/data-version', { headers: { Authorization: 'Bearer ' + tk } }).then(r => r.json());
    check('GET /api/data-version 指纹端点', dv.success && typeof dv.stamp === 'string');

    const info = await fetch(B + '/api/info').then(r => r.json());
    check('GET /api/info 携带 cs 标识', info.success && info.cs === true);

    const batch = await fetch(B + '/api/assets/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk },
        body: JSON.stringify({
            assets: [
                { id: 'EXE-TEST-002', owner: '测试主体', type: '台式机', brandModel: 'B', purchaseDate: '2026-08-30', status: 'active', user: 'u2', department: '测试部', unit: '台', quantity: 1, value: 2000, depreciationYears: 5, maintenanceRecords: [], attachments: [] },
            ],
        }),
    });
    check('批量导入 /api/assets/batch', batch.status === 200);

    const del = await fetch(B + '/api/assets/EXE-TEST-001', { method: 'DELETE', headers: { Authorization: 'Bearer ' + tk } });
    check('删除资产', del.status === 200);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
