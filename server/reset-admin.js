/**
 * 管理员密码重置工具 - 忘记密码时的应急手段(需在服务器本机执行)
 *
 * 用法:
 *   node reset-admin.js 新密码      # 将 admin 账号密码重置为指定值(至少 6 位)
 *
 * 说明:
 *   1. 直接改数据库, 不需要旧密码, 不需要服务端在运行;
 *   2. 若服务端正在运行, 重置后无需重启, 下次登录即生效;
 *   3. 重置完成后请立即登录并在界面/接口中再次修改为自己的密码。
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const newPassword = process.argv[2];
if (!newPassword || String(newPassword).length < 6) {
    console.error('用法: node reset-admin.js 新密码   (新密码至少 6 位)');
    process.exit(1);
}

const dbPath = process.env.ASSET_DB_PATH || path.join(__dirname, 'data', 'asset.db');
if (!fs.existsSync(dbPath)) {
    console.error('未找到数据库文件:', dbPath, '(如数据库在自定义位置, 请先设置 ASSET_DB_PATH 环境变量)');
    process.exit(1);
}

const db = new Database(dbPath);
const info = db.prepare('UPDATE users SET password_hash = ? WHERE username = ?')
    .run(bcrypt.hashSync(String(newPassword), 10), 'admin');
db.close();

if (info.changes > 0) {
    console.log('admin 密码已重置, 请立即使用新密码登录');
} else {
    console.error('未找到 admin 账号(用户表可能为空或被修改), 请检查数据库:', dbPath);
    process.exit(1);
}
