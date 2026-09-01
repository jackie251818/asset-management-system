/**
 * 数据库在线备份工具 - 使用 SQLite backup API, 备份期间服务可正常运行
 *
 * 用法:
 *   node backup.js                  # 备份到 <数据目录>\backups, 自动保留最近 10 份
 *   node backup.js D:\backup-dir    # 指定备份目录
 *
 * 建议配合 Windows 计划任务每日自动执行(见 CS架构部署文档.md 第 4.4 节)。
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./src/config');

const destDir = process.argv[2] || path.join(config.DATA_DIR, 'backups');
fs.mkdirSync(destDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0];
const dest = path.join(destDir, `asset-${stamp}.db`);

new Database(config.DB_PATH).backup(dest).then(() => {
    console.log('备份完成:', dest);
    // 清理过期备份: 按文件名时间戳排序, 只保留最近 10 份
    const keep = 10;
    const files = fs.readdirSync(destDir)
        .filter(f => f.startsWith('asset-') && f.endsWith('.db')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
        fs.unlinkSync(path.join(destDir, f));
        console.log('清理过期备份:', f);
    }
}).catch(e => {
    console.error('备份失败:', e.message);
    process.exit(1);
});
