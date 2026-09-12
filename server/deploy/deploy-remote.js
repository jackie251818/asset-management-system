/**
 * 自动部署脚本: 上传部署包到 Ubuntu 22.04 服务器并执行安装
 * 用法: node server/deploy/deploy-remote.js
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const DEPLOY_PKG = path.join(__dirname, '..', '..', '..', 'deploy-pkg');
const REMOTE_DIR = '/tmp/asset-deploy';
const HOST = '192.168.40.247';
const USER = 'root';
const PASS = 'capf8770733314';

function log(msg, color = '') {
    const colors = { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m', bold: '\x1b[1m' };
    console.log((colors[color] || '') + msg + colors.reset);
}

function connect() {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => resolve(conn));
        conn.on('error', reject);
        conn.connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 15000 });
    });
}

function exec(conn, cmd) {
    return new Promise((resolve, reject) => {
        conn.exec(cmd, { pty: true }, (err, stream) => {
            if (err) return reject(err);
            let out = '', errOut = '';
            stream.on('close', (code) => resolve({ code, out, err: errOut }));
            stream.on('data', (d) => { out += d.toString(); process.stdout.write(d.toString()); });
            stream.stderr.on('data', (d) => { errOut += d.toString(); });
        });
    });
}

// 递归用 sftp 上传目录
function uploadRecursive(sftp, localDir, remoteDir) {
    return new Promise((resolve, reject) => {
        (async () => {
            try {
                // 尝试创建远程目录 (忽略已存在错误)
                await new Promise((r, e) => sftp.mkdir(remoteDir, (er) => er && er.code === 4 ? r() : er ? e(er) : r()));
                const entries = fs.readdirSync(localDir);
                for (const name of entries) {
                    const lp = path.join(localDir, name);
                    const rp = remoteDir + '/' + name;
                    const st = fs.statSync(lp);
                    if (st.isDirectory()) {
                        await uploadRecursive(sftp, lp, rp);
                    } else {
                        await new Promise((r, e) => {
                            const ws = sftp.createWriteStream(rp);
                            ws.on('close', r);
                            ws.on('error', e);
                            fs.createReadStream(lp).pipe(ws);
                        });
                    }
                }
                resolve();
            } catch (e) { reject(e); }
        })();
    });
}

function uploadAll(conn, localDir, remoteDir) {
    return new Promise((resolve, reject) => {
        conn.sftp((err, sftp) => {
            if (err) return reject(err);
            uploadRecursive(sftp, localDir, remoteDir).then(() => { sftp.end(); resolve(); }).catch((e) => { sftp.end(); reject(e); });
        });
    });
}

async function main() {
    log('\n============================================', 'bold');
    log('  固定资产管理系统 - 远程自动部署', 'bold');
    log(`  目标: ${USER}@${HOST}`, 'bold');
    log('============================================\n', 'bold');

    // Step 1: 连接
    let conn;
    log('[0/5] SSH 连接...', 'yellow');
    try { conn = await connect(); log('✓ 已连接', 'green'); }
    catch (e) { log(`✗ SSH 连接失败: ${e.message}`, 'red'); process.exit(1); }

    // Step 2: 检查远程环境
    log('\n[1/5] 检查远程环境...', 'yellow');
    const pre = await exec(conn, 'uname -m && cat /etc/os-release | head -5 && ldd --version | head -1');
    console.log(pre.out);
    if (!pre.out.includes('x86_64')) { log('✗ 非 x86_64 架构', 'red'); process.exit(1); }
    log('✓ 环境满足', 'green');

    // Step 3: 准备远程目录
    log('\n[2/5] 准备远程目录...', 'yellow');
    await exec(conn, `rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR}`);
    log('✓ 远程目录已准备', 'green');

    // Step 4: 上传部署包
    log('\n[3/5] 上传部署包 (92 MB, 请耐心等, 无进度条)...', 'yellow');
    process.stdout.write('  上传中... ');
    await uploadAll(conn, DEPLOY_PKG, REMOTE_DIR);
    log('✓ 部署包上传完成', 'green');

    // Step 5: 执行安装
    log('\n[4/5] 执行一键安装脚本...', 'yellow');
    log('  ------------------------------------------------', 'cyan');
    const result = await exec(conn, `chmod +x ${REMOTE_DIR}/install-ubuntu.sh ${REMOTE_DIR}/asset-server-linux && bash ${REMOTE_DIR}/install-ubuntu.sh ${REMOTE_DIR}`);
    log('  ------------------------------------------------', 'cyan');
    if (result.code !== 0) log(`\n⚠ 安装脚本返回码: ${result.code} (继续验证)`, 'yellow');

    // Step 6: 远程验证
    log('\n[5/5] 最终验证', 'yellow');
    const checks = [
        ['/api/ping', 'curl -s http://127.0.0.1:3456/api/ping'],
        ['/api/info cs=true', "curl -s http://127.0.0.1:3456/api/info | grep -c '\"cs\":true'"],
        ['前端 feishu-sync-card', 'curl -s http://127.0.0.1:3456/index.html | grep -c feishu-sync-card'],
        ['nginx 80 反代', "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/api/ping"],
        ['HTTPS 443 反代', "curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/api/ping"],
    ];
    for (const [name, cmd] of checks) {
        const r = await exec(conn, cmd);
        const ok = name.includes('http_code') ? r.out.trim() === '200' : (name.includes('ping') ? r.out.includes('pong') : parseInt(r.out.trim()) > 0);
        if (ok) log(`✓ ${name}`, 'green'); else log(`✗ ${name} (${r.out.trim()})`, 'red');
    }

    log(`\n============================================`, 'bold');
    log(`  部署完成!`, 'bold');
    log(`  服务: http://${HOST}`, 'bold');
    log(`  HTTPS: https://${HOST}  (自签证书)`, 'bold');
    log(`  日志: journalctl -u asset-server -f`, 'bold');
    log(`============================================\n`, 'bold');

    conn.end();
}

main().catch((e) => { console.error('部署失败:', e); process.exit(1); });
