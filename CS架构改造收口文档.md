# C/S 架构改造 — 收口文档

| 项目 | 内容 |
|---|---|
| 收口日期 | 2026-08-31（2026-09-01 增补：连接设置窗口服务端信息面板 + 数据手动双向同步，见验收记录 #14/#15） |
| 改造范围 | 固定资产管理系统 v2.4（Electron 单机版）→ v3.0（单机 + C/S 双形态 + 统一登录入口 + 用户管理） |
| 收口结论 | **改造目标全部达成，验收项全部通过，具备生产交付条件** |
| 关联文档 | [CS架构部署文档.md](CS架构部署文档.md)（操作手册）· [CS架构改造变更摘要.md](CS架构改造变更摘要.md)（变更明细）· [README.md](README.md)（v3.2） |

---

## 1. 改造目标与达成情况

| 目标 | 达成情况 |
| --- | --- |
| 多用户并发使用（C/S 架构） | ✅ Koa + SQLite 服务端，浏览器/Electron 客户端接入 |
| 数据集中存储与安全 | ✅ SQLite（WAL）单文件；JWT 鉴权；三角色权限（admin/editor/viewer）；操作审计；防目录穿越 |
| 旧版本平滑兼容 | ✅ 单机模式行为不变；旧薄 API 兼容层保留；提供一次性迁移工具（JSON→SQLite） |
| 客户端免改造接入 | ✅ Electron 双模式：应用内"连接服务器设置"界面化切换（推荐），`server.config.json` 保留为批量预配置方式 |
| 服务端易部署 | ✅ 独立 EXE（免 Node.js）；生产部署包一键安装（证书+防火墙+双服务+健康检查） |
| 生产级运行保障 | ✅ nginx 80/443 反代 + 自签 HTTPS + NSSM 服务化（崩溃拉起/日志轮转/开机自启）+ 备份/恢复/密码重置工具 |
| **统一登录入口**（单机版免密 / C/S 版账号密码） | ✅ `login.html` 重写为模式选择+登录二合一，Electron 内嵌自动免密，浏览器选模式后记住选择（`localStorage.app_mode`） |
| **用户管理**（管理员/普通用户两类） | ✅ 服务端 `/api/users` 全 CRUD + PATCH 重置密码 + 最后一个 admin 保护；前端 `js/users.js` 管理视图；admin 角色可见菜单 |
| **侧栏全局切换运行模式入口** | ✅ `index.html` 侧栏 `#switch-mode-btn`（全局可见，按 4 种运行环境分流）；`login.html?switch=1` 强制绕开自动免密/自动跳转；Electron 内嵌补 `cs-settings://` 同构拦截 |

---

## 2. 验收验证记录

| # | 验收项 | 方式 | 结果 |
| --- | --- | --- | --- |
| 1 | 服务端 API（CRUD/鉴权/分页/乐观锁/导入事务/迁移） | 57 项自动化测试（`npm test`） | ✅ 全部通过 |
| 2 | 前端改造（登录守卫/REST 化/本地快照隔离/预设清理） | 浏览器端到端 | ✅ 通过（4 个问题发现并修复） |
| 3 | 单机模式回归 | Electron 便携版运行 | ✅ 与 v2.x 行为一致 |
| 4 | Electron 双模式切换 | 应用内设置 / server.config.json | ✅ 通过 |
| 5 | 服务端独立 EXE | pkg 打包产物运行验证（含数据目录跟随 EXE） | ✅ 通过 |
| 6 | 生产部署闭环（证书→服务端→nginx 80/443→静态页） | 本机实测（ASCII 路径） | ✅ 全链路 PASS |
| 7 | NSSM 服务化（安装/RUNNING/卸载/端口释放） | 本机实测 | ✅ 通过 |
| 8 | 一键安装脚本（新机模拟：自动取 EXE、自动生成证书、防火墙、健康检查、幂等重跑） | `C:\asset-deploy-test` 模拟实测 | ✅ HTTP80/HTTPS443 PASS |
| 9 | 客户端应用内连接设置（快捷键拉起窗口/get/test 真实探测/save/apply 重启进客户端模式/clear 重启回单机） | 打包 EXE + CDP 驱动 GUI 实测 | ✅ 全链路通过 |
| 10 | 统一登录入口 login.html（模式选择卡片 + C/S 登录二合一 + `?switch=1` 强制绕开自动免密/自动跳转） | 浏览器端到端 + Electron 内嵌端口 | ✅ 通过 |
| 11 | 用户管理 CRUD（新建 admin/普通用户、重置密码 PATCH、删除最后一个 admin 400 保护、admin 角色可见菜单项） | 服务端 API 冒烟（curl/Invoke-RestMethod） + C/S 浏览器 UI | ✅ 全通过 |
| 12 | CORS 跨域兼容（file:// Origin:null 反射、OPTIONS 预检 204、Authorization/X-Server-Token 头放行） | 服务端 API 冒烟 | ✅ 通过 |
| 13 | 侧栏"切换运行模式"入口（4 种运行环境按 matrix 分支分流、Electron 内嵌补 `cs-settings://` 同构拦截、login.html?switch=1 强制模式选择路径） | browser_use 端到端（C/S HTTP + Electron 内嵌） | ✅ 全路径覆盖 |
| 14 | 连接设置窗口服务端信息面板 + 数据手动双向同步（拉取 7 键 / 推送 7 键 / 二次确认 / 双向一致性 / 必填字段校验） | 打包 EXE（asar 校验）+ 真实服务端 `192.168.40.251:3456` HTTP 端到端 | ✅ 全链路通过（2026-09-01） |
| 15 | 连接设置窗口按钮点击无反应修复（两处根因：① sandbox + asar preload 静默失败 → sandbox:false + try-catch 兜底；② 误加 CSP `script-src` 拦截内联脚本 → 移除） | asar 解包验证 + CDP 实测（connApi 注入/卡片切换/测试连接/信息面板） | ✅ 修复确认 |

> 第 9 项实测（2026-08-31）：便携 EXE v2.4.5（61.44 MB，asar 含 `connection.html`/`connection-preload.js`）；服务端在线 → exe 旁 `server.config.json` 启动即直连 `:3456`；Ctrl+Alt+S（SetForegroundWindow + SendKeys 发送 OS 级按键）拉起设置窗口；`connApi.get` 初始态 `{mode:null, appSettingExists:false, fileConfigExists:true}`；`connApi.test('http://127.0.0.1:3456')` 返回"连接成功"；`save` 写入 `%APPDATA%\asset-management-system\connection.json`；`apply` 触发 `app.relaunch()` 重启（PID 切换验证）后仍直连 `:3456`，`get` 显示 `appSettingExists:true`（应用内设置优先级生效）；删除配置文件 + `clear` + 重启 → 内嵌服务随机端口（:1366）加载 `index.html`，单机数据目录 `%APPDATA%\asset-management-system\data\` 正常落盘。

> 测试环境改动（临时目录、测试服务、防火墙规则）已全部清理还原。

---

## 3. 交付物清单

### 3.1 代码与工具

| 交付物 | 位置 | 说明 |
| --- | --- | --- |
| C/S 服务端源码 | `server/` | Koa + SQLite，REST + 旧版兼容层，57 项测试 |
| 运维工具 | `server/backup.js` · `server/reset-admin.js` · `server/migrate.js` | 备份轮换 / 密码重置 / JSON→SQLite 迁移 |
| 独立服务端 EXE | `server/dist/asset-server.exe` | 免 Node.js，数据目录跟随 EXE |
| 前端改造 | `login.html` · `js/api.js` · `js/init.js` · `js/users.js` · `js/storage.js` · `index.html` | 统一登录入口（模式选择+登录二合一）、JWT、模式探测、用户管理、侧栏切换运行模式 |
| Electron 双模式 | `main.js` · `connection.html` · `connection-preload.js` | 单机 / C/S 客户端自适应；应用内连接设置窗口 |
| 生产部署包 | `server/deploy/` | nginx + nssm + `一键安装.bat` + `make-cert.ps1` + 装卸服务脚本 |
| Linux 部署支持 | `server/dist/asset-server-linux` · `deploy/asset-server.service` · `deploy/verify-linux.sh` | 交叉打包产物（实机运行待目标机验证）+ systemd 单元 + 一键验证脚本（部署文档第 11 章） |

### 3.2 文档

| 文档 | 读者 | 用途 |
| --- | --- | --- |
| CS架构部署文档.md (v2.8) | 系统管理员 | 部署、迁移、备份、运维、FAQ（12 章 + 4 附录） |
| CS架构改造变更摘要.md | 研发/评审 | 分阶段变更明细 + 14 项关键修复记录 |
| README.md (v3.2) | 全体 | 运行形态、快速开始、开发指南、故障排查 |
| 本文档 | 项目管理/交接 | 收口确认 |

---

## 4. 使用入口速查

| 角色 | 操作 |
| --- | --- |
| 单机用户 | 双击便携 EXE（不变）；或浏览器打开后选"单机版" |
| 团队用户（浏览器） | 访问 `http://<服务器IP>`（或 `:3456` 直连）→ 登录 → admin 可见"用户管理" |
| 团队用户（客户端） | 按 Alt → 设置 → 连接服务器设置 → 填地址测试后保存重启（或分发 `server.config.json`）；同窗口可查看服务端信息、执行数据双向同步 |
| **已登录切换模式（全局）** | 侧栏底部"切换运行模式"按钮 → 清凭证 + 跳 login.html?switch=1 显示模式选择卡片 → 选新模式 |
| 系统管理员 | `server/deploy/` → 纯英文路径 → 双击 `一键安装.bat`；日常备份/重置密码见部署文档第 4 章 |
| 默认账号 | `admin / admin123`（**首次登录立即改密**） |

---

## 5. 已知限制与注意事项

| # | 限制 | 影响 | 规避 |
| --- | --- | --- | --- |
| 1 | 部署路径必须纯英文（ASCII） | nginx Windows 版 ANSI 路径限制，中文路径下服务无法启动 | 一键脚本已内置预检拦截；按提示移至如 `C:\asset-server` |
| 2 | 自签 HTTPS 证书 | 客户端浏览器首次访问 443 有"不受信任"告警 | 点"继续浏览"，或将 `cert\server.crt` 导入客户端受信任根证书 |
| 3 | JWT 有效期 12 小时 | 过期后需重新登录，无静默续期 | 影响轻微；如需改善见第 6 节建议 |
| 4 | 工具脚本依赖 Node.js | EXE 部署机器跑 backup/reset/migrate 需 Node 环境 | 另备一份 `server/` 源码目录，或用部署文档 4.4 方式 C 冷备份 |
| 5 | 附件以 base64 入库 | 数据库体积随附件增长 | 定期备份 + 关注 `asset.db` 体积；大附件场景见第 6 节建议 |
| 6 | 单机数据与服务端数据不自动互通（无定时/自动同步） | 两个形态各自独立 | 手动双向同步：连接设置窗口填服务端账号后"服务器 → 本地 / 本地 → 服务器"（全量覆盖 + 二次确认）；或一次性迁移（部署文档 4.6） |

---

## 6. 遗留事项与后续建议

均为非阻塞优化项，按优先级排列：

| 优先级 | 事项 | 建议 |
| --- | --- | --- |
| P1 | 定时自动备份 | 生产机用任务计划程序每日执行 `node backup.js`（部署文档 4.4 已给出模板），首次生产部署后立即配置 |
| P1 | 正式 TLS 证书（可选） | 有企业 CA/域名时替换自签证书，消除告警 |
| P2 | Token 刷新机制 | 引入 refresh token 或滑动续期，减少 12h 重登 |
| P2 | 旧版兼容层下线评估 | 前端已全面切 REST；观察 1-2 个版本后可移除 `routes/compat.js` |
| P2 | 数据库体积监控 | 附件 base64 入库，建议管理界面增加存储占用统计 |
| P3 | 客户端自动更新 | 目前换版本需手动分发 EXE |
| P3 | 服务端状态页 | 简单只读状态页（版本/连接数/库体积）便于巡检 |

---

## 7. 交接指引

| 场景 | 应查阅 | 关键动作 |
| --- | --- | --- |
| 新服务器上线 | 部署文档 2/3/6.4 章 | 复制部署包 → `一键安装.bat` |
| 旧单机数据并入 | 连接设置窗口"本地 → 服务器"推送（界面化，推荐）；或部署文档 4.6 迁移工具 | 窗口内填服务端地址与账号 → 推送前确认二次弹窗；大批量场景用 `npm run migrate -- --source "C:\旧数据" --dry-run` → 执行 |
| 日常备份/恢复 | 部署文档 4.4 / 4.5 | `node backup.js` / 恢复步骤 |
| 忘记管理员密码 | 部署文档 4.7 | `node reset-admin.js 新密码` |
| 服务异常 | 部署文档 9/10 章 + FAQ Q9 | 先看 `deploy\logs\*.err.log` |
| 客户端接入 / 换服务器地址 | 部署文档第 7 章 / README | 应用内"连接服务器设置"修改保存；批量场景分发配置文件 |
| 了解代码改动 | 变更摘要文档 | 分阶段变更 + 修复记录 |
| 二次开发 | README 开发指南 + 部署文档附录 | `server/npm test` 回归 |

---

## 8. 收口确认

| 角色 | 姓名 | 日期 | 签字 |
| --- | --- | --- | --- |
| 开发负责人 | | | |
| 部署/运维确认 | | | |
| 业务验收 | | | |
