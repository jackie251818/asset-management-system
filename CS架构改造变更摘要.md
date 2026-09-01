# C/S 架构改造变更摘要

> 改造周期：2026-08-30（单日完成阶段 1-3 及三项增强）；2026-08-31 增补增强 ④⑤；2026-09-01 增补增强 ⑥（服务端信息面板 + 数据手动双向同步 + sandbox 修复）
> 关联文档：`CS架构部署文档.md`（部署操作手册）

---

## 1. 改造目标

将原单机版（Electron 便携 EXE，数据存本地 `data/*.js`）演进为可多人同时使用的 **C/S 架构**，同时保留单机模式向后兼容：

```
┌─────────────┐   HTTP/HTTPS    ┌──────────────────┐    SQLite     ┌────────────┐
│ 浏览器 /     │ ──────────────► │  asset-server.exe │ ───────────► │ asset.db   │
│ Electron 客户端│  REST + JWT    │  (Koa + 静态页)    │   WAL 模式   │ (单文件库)  │
└─────────────┘                 └──────────────────┘              └────────────┘
```

核心收益：多用户并发、集中存储、角色权限、数据备份/恢复/迁移体系、生产级部署（反代 + HTTPS + 服务化）。

---

## 2. 变更清单

### 2.1 阶段 1+2：服务端与数据库（新增 `server/`）

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `server/src/index.js` | 新增 | Koa 入口：路由挂载、静态页服务（Cache-Control: no-cache）、端口 3456 |
| `server/src/config.js` | 新增 | 端口/JWT/数据目录配置；`IS_PKG` 打包感知（数据目录跟随 EXE）；JWT 密钥自动生成持久化 `secret.key` |
| `server/src/db.js` | 新增 | SQLite 建库建表、WAL 并发模式 |
| `server/src/auth.js` | 新增 | 用户管理 + bcrypt 密码哈希 + JWT 签发/校验；角色 `admin / editor / viewer` |
| `server/src/routes/assets.js` | 新增 | RESTful 资产 CRUD、分页筛选、**乐观锁**（version 冲突检测）、批量导入事务回滚 |
| `server/src/asset-mapper.js` | 新增 | DB snake_case ↔ 前端 camelCase 字段映射（`FIELD_TO_COL`） |
| `server/src/compat.js` | 新增 | 旧版薄 API 兼容层（`/api/load`、`/api/save`、`/api/list`、`/api/delete`、`/api/ping`），`raw()` 保持旧契约裸响应 |
| `server/src/migrate.js` | 新增 | 旧单机 JSON/JS → SQLite 迁移（事务快照 + 校验 + 自动备份） |
| `server/tests/api.test.js` | 新增 | 57 项 API 测试（含鉴权、冲突、迁移场景），全部通过 |
| `server/backup.js` | 新增 | 数据库备份 + 轮换清理 |
| `server/reset-admin.js` | 新增 | 管理员密码重置（强制 ≥6 位） |

关键设计：
- **安全边界**：写接口（save/delete/exec）强制鉴权（`Authorization: Bearer` / `X-Server-Token`）；静态文件中间件防目录穿越与敏感文件（db/key）下载
- **多端一致性**：`/api/data-version` 版本端点，客户端轮询感知他人变更并提示刷新
- **兼容期策略**：旧前端零改动可直连兼容层，新页面逐步切 REST

### 2.2 阶段 3：前端改造（登录 + 存储 HTTP 化 → 统一登录入口 + 用户管理）

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `login.html` | **重写** | 统一登录入口：模式选择卡片（单机版/C/S 版）+ C/S 登录表单二合一；`?switch=1` 强制绕开 embedded 自动免密 / csMode 已登录自动跳转；两个模式卡片按 **embeddedMode / csMode / 普通浏览器** 三分支行为 |
| `js/api.js` | 新增 | 集中 fetch 封装：`baseURL`/`embeddedMode`/`localMode` + 模式探测、JWT 注入、401 统一处理；用户管理 API 封装（getUsers / createUser / deleteUser / updateUser） |
| `js/storage.js` | 重构 | C/S 模式双阶段探测（`/api/info?cs=true`）；HTTP 下服务端为唯一数据源，**本地回退仅限 file:// 协议**，防止脏数据"复活"；探测结果同步到 `ApiClient.csMode` |
| `js/init.js` | 重构 | 统一登录守卫（embedded 免密 > csMode 登录 > app_mode > 跳 login）；新增 `setupSwitchModeUI()`：侧栏全局"切换运行模式"入口（清 token/user/localStorage → `location.replace('login.html?switch=1')`）；`setupCSModeUI()` 管理 C/S 用户信息框 + 用户管理菜单（admin 可见） |
| `index.html` | 修改 | `data/*.js` 本地快照**仅 file:// 协议条件加载**；登录守卫：未认证重定向 `login.html`；侧栏新增 `#switch-mode-btn`（全局可见，按环境分流）+ `users-page` 容器 |
| `js/users.js` | **新增** | 用户管理视图：新建用户（管理员/普通用户两角色）+ 重置密码 + 删除（最后一个 admin 保护） |
| 预设数据 | 清理 | owner/department 下拉预设清空（部署环境数据改由界面维护），仅保留通用 type 预设 |

阶段 3 验证中发现并修复 4 个问题：本地模式横幅常驻、HTTP 模式误载旧快照、getItem 本地回退污染、下拉/打印卡硬编码业务数据。

### 2.3 增强 ①：Electron 客户端化（双模式）

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `main.js` | 修改 | 新增客户端模式探测：**应用内"连接服务器设置"（connection.json，推荐）或 EXE 旁 `server.config.json`** 均可进入**瘦客户端模式**（`createClientWindow` 直连远程服务端，本地不启动 HTTP、不落任何数据）；无配置/选单机即恢复单机模式 |

### 2.4 增强 ②：服务端打包为独立 EXE

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `server/package.json` | 修改 | `bin` 入口、`build:exe` 脚本、`@yao-pkg/pkg` 配置（node22-win-x64，静态页/原生模块内置 assets） |
| `server/scripts/build-exe.js` | 新增 | 打包期临时移除 `generator-function` 的 ESM `exports`（规避 MODULE_NOT_FOUND），完成后自动还原 |
| 产物 | `server/dist/asset-server.exe`（约 72MB 单文件，数据目录跟随 EXE） |

### 2.5 增强 ③：生产部署配套（`server/deploy/`，本机全链路验证通过）

| 文件 | 说明 |
| --- | --- |
| `nginx.conf` | 80/443 双入口反代 → `127.0.0.1:3456`；gzip、64m 上传上限、安全响应头 |
| `make-cert.ps1` | 自签证书（SAN 自动覆盖 localhost + 主机名 + 全部局域网 IPv4，10 年期） |
| `install-service.bat` | NSSM 一键安装 `AssetServer` + `AssetNginx` 服务：自动部署 conf、日志轮转（10MB）、开机自启 |
| `uninstall-service.bat` | 一键卸载（数据保留） |
| `nginx/` + `nssm.exe` | 运行时组件 |

### 2.6 增强 ④：客户端应用内连接设置（免手工建配置文件）

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `main.js` | 修改 | 配置解析扩展：userData `connection.json`（应用内设置，优先）→ EXE 旁 `server.config.json`（兼容）→ 默认单机；新增 IPC（get/test/save/clear/apply）、连接设置窗口、应用菜单"设置 → 连接服务器设置…"（Ctrl+Alt+S，Alt 显示菜单栏）；连接失败错误页扩为**重新连接 / 修改连接设置 / 改用单机模式**三选；无效配置启动弹窗三选，不再静默回落单机 |
| `connection.html` | 新增 | 设置界面：模式卡片单选、地址输入、测试连接（主进程探测 `/api/ping`，3.5s 超时，兼容自签证书）、保存并重启、清除应用内设置 |
| `connection-preload.js` | 新增 | contextBridge 暴露最小 IPC 面（sandbox + contextIsolation 不变） |
| `package.json` | 修改 | 打包 files 清单补上述两文件 |

> 验证状态（2026-08-31 实测，便携 EXE v2.4.5 / 61.44 MB）：打包 EXE + CDP 驱动 GUI 全链路通过——asar 含 `connection.html`/`connection-preload.js`；Ctrl+Alt+S（SetForegroundWindow + SendKeys 发送 OS 级按键）拉起设置窗口；`connApi.get` 初始态 `{mode:null, appSettingExists:false, fileConfigExists:true}`；`connApi.test` 真实探测在线服务端返回"连接成功"；`save` 写入 `%APPDATA%\asset-management-system\connection.json`，`apply` 触发 `app.relaunch()` 重启（PID 切换验证）；重启后仍直连 `:3456` 且 `get` 显示 `appSettingExists:true`（应用内设置优先级高于 exe 旁配置文件，实测确认）；删除配置文件 + `clear` + 重启 → 内嵌服务随机端口（:1366）加载 `index.html`，单机数据目录 `%APPDATA%\asset-management-system\data\` 正常落盘。配置文件机制原样兼容。

### 2.7 增强 ⑤：统一登录入口 + 用户管理 + 侧栏切换运行模式

**服务端**（跨域兼容 + 用户管理 API 补全）：

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `server/src/index.js` | 修改 | 新增 CORS 中间件：反射 Origin（含 `null`）、OPTIONS 预检返回 204、允许 `Content-Type / Authorization / X-Server-Token`、允许 `GET, POST, PUT, DELETE, PATCH, OPTIONS` 方法 |
| `server/src/auth.js` | 修改 | DELETE `/api/users/:id` 增加"最后一个 admin 保护"（若为最后 admin 拒绝删除，400）；新增 PATCH `/api/users/:id`（重置密码 / 改角色，admin 保护） |

**前端统一登录入口 + 用户管理**：

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `login.html` | **重写** | 模式选择卡片（单机版/C/S 版）+ C/S 登录表单二合一视图；顶部"切换模式"链接；`?switch=1` 强制绕开 embedded 自动免密 / csMode 已登录自动跳转；两个模式卡片按 **embeddedMode / csMode / 普通浏览器** 三分支行为 |
| `js/api.js` | 修改 | `baseURL`/`embeddedMode`/`localMode` 公开属性 + `_baseUrl()` 智能选择；用户管理 API 封装（getUsers / createUser / deleteUser / updateUser） |
| `js/init.js` | **重构** | 统一登录守卫（embedded 免密 > csMode 已登录 > app_mode=standalone 直进 > app_mode=client 登录 > 跳模式选择）；`setupCSModeUI()` 管理 C/S 用户信息框 + 用户管理菜单（admin 可见，其他角色隐藏）；**新增 `setupSwitchModeUI()`：侧栏全局"切换运行模式"入口** |
| `index.html` | 修改 | 侧栏新增 `#switch-mode-btn`（全局可见，图标 `fa-exchange-alt`）+ `users-page` 容器 |
| `js/users.js` | **新增** | 用户管理视图：列表表格 + 新建用户表单（角色下拉：管理员 / 普通用户）+ 重置密码（prompt 输入）+ 删除（confirm 确认 + 最后一个 admin 保护） |

**Electron 主进程（内嵌单机补切换 C/S 通道）**：

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `main.js` `startStandaloneMode()` | 修改 | 内嵌单机 mainWindow 新增 `will-navigate` 拦截：`cs-settings://` → `createConnectionWindow()`（已在 `createClientWindow()` 中实现，补齐内嵌单机的同构路径） |

**完整切换路径矩阵**（侧栏"切换运行模式"按钮 → login.html?switch=1 → 模式卡片）：

| 运行环境 | 点"单机版" | 点"C/S 版" |
|---|---|---|
| Electron 内嵌单机（embeddedMode） | splash → 已是单机跳 index | `cs-settings://` → 开连接设置窗 → 保存后 `app.relaunch` 重启为 C/S 客户端模式 |
| Electron 客户端（csMode，远程页） | `cs-standalone://` → destroy → `startStandaloneMode` 切原生单机 | 清残留 cs_auth → 登录表单 → 填账号密码登录 |
| HTTP C/S 同源（多人共享） | `cs-standalone://` 尝试（非 Electron 无效，500ms 兜底回 login.html） | 清残留 cs_auth → 登录表单 → 填账号密码登录 |
| file:// 浏览器（双击 index.html） | `setAppMode('standalone')` → splash → jumpToIndex | 清 cs_auth → `setAppMode('client')` → 登录表单（file:// 需填服务器地址） |

> 验证状态（2026-08-31）：
> - **服务端 API 冒烟**：CORS OPTIONS 204 + Origin:null 反射 ✅；GET/POST/PATCH/DELETE 用户管理全通 ✅；最后一个 admin 删除返回 400 ✅
> - **C/S 浏览器端到端**：侧栏 switch-mode-btn 可见可点击（hard refresh 后），跳 login.html?switch=1 正确显示模式选择卡片，选 C/S 版正常走登录表单，清 localStorage 后回模式选择 ✅
> - **Electron 内嵌模式**：裸 login.html splash → 自动跳 index（保留原行为）；login.html?switch=1 成功绕开自动免密，3 秒后仍停在模式选择卡片 ✅
> - **ApiClient.logout() 等价性**：仅本地清理（无服务端注销调用），手动清完全等价且多清 app_mode + cs_server_url ✅
> - **静态资源缓存**：服务端已有 `Cache-Control: no-cache`，无需额外处理 ✅
> - **打包（重要教训）**：新增 `login.html` 后忘了同步 `package.json.build.files` → electron-builder 白名单制导致 app.asar 里缺 login.html（connection.html 显式列了所以有，login.html 没列所以丢了）→ 内嵌服务 `loadURL(/login.html)` 返回 404 fallback HTML → 用户看到"404 Not Found / 请求的文件不存在"。修复：`build.files` 数组加 `"login.html"`；经验证 app.asar 顶层文件列表出现 login.html，运行后 `/login.html` 200、mainWindowTitle 正常 ✅

### 2.8 增强 ⑥：连接设置窗口 — 服务端信息面板 + 数据手动双向同步（2026-09-01）

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `main.js` | 修改 | ① `createConnectionWindow` 的 `webPreferences.sandbox: true → false`（修复打包后按钮点击无反应，见修复记录 #14），窗口 480×440 → 540×680（容纳新增同步区域），允许拖拽调整大小；② `registerConnectionIpc` 末尾新增 `httpJson()`（Node http/https 通用请求，Bearer 注入 + 8s 超时）、`loginServer()`（POST `/api/auth/login` 取 JWT）、`writeLocalDataKey()` / `readLocalDataKey()`（本地 `data/<key>.json` + `data/<key>.js` 双文件读写，与内嵌服务器格式完全一致）、`SYNC_KEYS`（7 个数据键）常量；③ 新增 3 个 IPC handler：`conn:serverInfo`（免鉴权 GET `/api/info`）、`conn:syncPull`（登录 → 逐键 GET `/api/load` → 写本地）、`conn:syncPush`（登录 → 读本地 → 逐键 POST `/api/save`，`{key, value}` 包装全量替换） |
| `connection-preload.js` | 修改 | 整体 try-catch 包装（preload 初始化失败时 console 报错而非静默中断）；新增 `serverInfo` / `syncPull` / `syncPush` 三个 IPC 暴露 |
| `connection.html` | **重写** | ① 新增**服务端信息面板**（"获取信息"按钮拉取后显示服务名称 / 版本 / 服务器时间 / 数据库路径 / C/S 标识）；② 新增**数据同步区域**：用户名 + 密码输入（同步需 JWT，与主窗口登录态隔离，独立输入）+ "服务器 → 本地（拉取）" + "本地 → 服务器（推送）"两个按钮 + 结果回显（每键同步条数 / 总资产数 / 错误明细）；③ 两个方向均有**二次确认弹窗**，推送方向特别标注"服务端数据将被全量删除后重新插入，不可撤销"；④ 有已保存地址时自动拉取一次服务端信息 |

**同步范围与语义**：

- 同步 7 个数据键：`assetManagementData`（资产全量）+ `custom_options_owner/type/department` 及各自 `_deleted` 后缀键；
- **排除** `userStateData` 等个人状态键（换机不丢个人设置）；
- `assetManagementData` 服务端侧走 `replaceAllAssets` 事务（DELETE 三表后重 INSERT），是**整体替换语义**；
- 推送前二次确认；拉取仅覆盖上述 7 键，个人设置不受影响。

> 验证状态（2026-09-01，便携 EXE v2.4.5 / 61.44 MB，最终构建 `dist_build_20260901122101`）：asar 解包确认 3 个 handler + 3 个 preload API + 全部 UI 元素（btn-pull/btn-push/btn-info/confirmDialog/sync-section）与窗口尺寸均已进入打包产物；服务端实测 `http://192.168.40.251:3456`（Linux 部署）：`/api/info` 免鉴权返回名称/版本/服务器时间 ✅；`admin` 登录取 JWT ✅；**syncPull 7 键拉取**（资产 3 条 + 自定义选项）本地 `.json`/`.js` 双文件正确落盘 ✅；**syncPush 7 键推送**（本地加 1 条资产后全量推送，`{key, value}` 包装）服务端保存成功 ✅；**双向一致性**：推送后再次拉取，服务端资产数与本地完全一致、新增资产 ID/字段全部匹配 ✅；服务端字段校验生效（缺 `type/brandModel/department` 必填字段的资产被 400 拒绝）✅。测试数据已清理（服务端恢复 0 资产）。
>
> 注意：中间构建 `dist_build_20260901113924` 曾因 connection.html 误加 CSP meta 导致按钮全部无反应（修复记录 #15），已在 `dist_build_20260901122101` 修复并经 CDP 实测全链路通过——交付以 **dist_build_20260901122101** 为准。

---

## 3. 关键修复记录（验证阶段定位）

| # | 问题 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 兼容层响应格式不符 | 统一 `{code,message,data}` 包装破坏旧契约 | `compat.js` 改用 `raw()` 裸响应 |
| 2 | 前端字段落库为 null | camelCase 未映射 snake_case 列 | `asset-mapper.js` 增加 `FIELD_TO_COL` 全量映射 |
| 3 | 部分测试 401 | 测试脚本 GET 漏带 token | 补齐鉴权 |
| 4 | reset-admin 弱密码 | 无长度校验 | 强制 ≥6 位 |
| 5 | login.html 图标不加载 | Font Awesome 用了 `<script>` | 改 `<link rel="stylesheet">` |
| 6 | api.js 报 Logger 未定义 | 加载顺序差异 | `typeof Logger !== 'undefined'` 防御 |
| 7 | 服务端启动报库目录不存在 | data 目录未创建 | config 启动时 `mkdirSync`（并补运行时目录） |
| 8 | 打包 EXE 报 MODULE_NOT_FOUND | `generator-function` ESM exports 在 pkg 快照内失效 | build-exe.js 打包期补丁 |
| 9 | make-cert.ps1 误报失败 | openssl stderr 进度输出在 PS5.1 `EAP=Stop` 下变 NativeCommandError | 临时 `EAP=Continue` + `2>$null`，以产物为准 |
| 10 | nginx 载入证书失败 | ① 配置相对路径基于 conf/ 而非 prefix；② **nginx Windows 版不支持非 ASCII 路径** | 路径改 `../../cert/`；部署约束：deploy 必须放纯英文路径 |
| 11 | AssetServer 服务无法启动（`CreateProcess: 目录名称无效`） | `%~dp0` 尾反斜杠 + 引号被 NSSM 转义，AppDirectory 值损坏为 `C:\xxx"` | bat 内 `set SVC_DIR=%SCRIPT_DIR:~0,-1%` |
| 12 | install-service.bat 等待步骤报错 | `timeout` 在 stdin 重定向下不可用 | 改 `ping -n 3 127.0.0.1` |
| 13 | 打包 EXE 启动后 mainWindow 显示 404 | **`build.files` 白名单缺 `login.html`**（electron-builder 无默认兜底） | `package.json.build.files` 加 `"login.html"`；同时补 `build-portable.js` 自动提权（rcedit 管理员权限） |
| 14 | 打包 EXE 连接设置窗口"测试连接/保存并重启"按钮点击无反应（dev 模式正常） | Electron `sandbox: true` + asar 内 preload：Electron 初始化 preload 时 asar 虚拟文件系统尚未就绪，`require('electron')` 静默失败 → preload 整体中断 → `window.connApi === undefined` → 页面内 `connApi.test(...)` 同步 throw TypeError（Promise 链外，`.catch` 接不住）→ 界面无任何反馈 | `createConnectionWindow` 改 `sandbox: false`；`connection-preload.js` 整体 try-catch 兜底（失败时 console.error 可见）；经验证 asar 内 `sandbox:false` 与 try-catch 均生效，打包 EXE 全链路恢复可用 |
| 15 | #14 修复重打包后按钮**仍然**全部无反应（窗口能开、无任何报错，模式卡片/脚注均无初始状态） | 重写 `connection.html` 时新增了 CSP meta `script-src 'self'`，而页面逻辑是**内联 `<script>`** → 内联脚本被 CSP 静默拦截，所有事件监听未绑定、`connApi.get()` 初始化也没跑 | 移除 CSP meta（本地离线页面无需 script-src 限制，源码留注释防回归）；CDP 实测（`--remote-debugging-port` + Ctrl+Alt+S 拉窗）：connApi 注入 ✓、footnote 初始化 ✓、模式卡片切换 ✓、测试连接"√ 连接成功" ✓、服务端信息面板真实数据渲染 ✓ |

---

## 4. 验证结果

| 验证项 | 结果 |
| --- | --- |
| 服务端 API 测试（57 项） | 全部通过 |
| 阶段 3 浏览器端到端（登录/增删改查/导入/多端冲突提示） | 通过 |
| Electron 双模式（单机 / 瘦客户端） | 通过 |
| 客户端应用内连接设置（测试连接/保存重启/清除/失败兜底） | 打包 EXE + CDP 驱动 GUI 全链路通过 |
| 服务端 EXE 打包产物运行（/api/info、数据目录跟随 EXE） | 通过 |
| 生产部署闭环：证书生成 → 后端 3456 → nginx 80/443 反代 → 静态页 200 | 全部通过 |
| NSSM 服务安装 → RUNNING → 卸载 → 端口释放 | 通过 |
| 统一登录入口：login.html 模式选择卡片 + C/S 登录二合一（含 ?switch=1 强制路径） | 通过 |
| 用户管理 CRUD（新建 admin/普通用户、重置密码、删除、最后一个 admin 保护） | 通过 |
| 侧栏"切换运行模式"入口：4 种运行环境按 matrix 分支分流、Electron 内嵌补 cs-settings:// 拦截 | 通过 |
| CORS 跨域兼容（Origin:null 反射、OPTIONS 预检 204） | 通过 |
| 连接设置窗口服务端信息面板 + 数据手动双向同步（服务端 192.168.40.251:3456 实测：拉取 7 键 / 推送 7 键 / 双向一致性 / 必填校验） | 通过 |

---

## 5. 交付物总览

```
├── server/                     # C/S 服务端（源码 + 57 项测试 + 迁移/备份/重置工具）
│   ├── dist/asset-server.exe   # 独立服务端 EXE
│   └── deploy/                 # 生产部署包（nginx + 证书脚本 + 服务安装脚本）
├── main.js / login.html / js/  # Electron 双模式客户端 + 前端 HTTP 化改造
├── CS架构部署文档.md           # 10 章 + 4 附录（含 6.4 生产部署包专节）
└── CS架构改造变更摘要.md       # 本文档
```

## 6. 使用提示

- **单机用户**：无需任何操作，原便携 EXE 行为不变
- **接入服务端**：客户端按 Alt → 设置 → 连接服务器设置 → 填地址测试后保存重启；批量场景可分发 `server.config.json`（`{"serverUrl":"http://<服务器IP>:3456"}`）；或浏览器直接访问服务端地址
- **数据手动同步**：连接设置窗口（或单机模式填服务端地址）填服务端账号后，"服务器 → 本地（拉取）"拉取服务端数据覆盖本地 7 个数据键；"本地 → 服务器（推送）"将本地 7 键全量覆盖到服务端（二次确认后执行）。适用场景：旧单机数据并入服务端（代替 4.6 迁移工具的界面化途径）、多机之间经服务端中转数据
- **生产部署**：按部署文档 6.4 节，deploy 包复制到**纯英文路径**（如 `C:\asset-server`）→ `make-cert.ps1` → `install-service.bat`
- **默认管理员**：`admin / admin123`（首次登录后立即改密；忘记密码用 `reset-admin.js` 重置）
