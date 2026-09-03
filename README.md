# 电脑固定资产管理系统 v3.4

> 固定资产管理平台，双运行形态：
> **单机版** — 基于 Electron 的离线桌面应用，便携式 .exe 单文件运行；
> **C/S 版** — 多用户客户端/服务端架构，浏览器或 Electron 客户端接入，数据集中存储于 SQLite。

## 运行形态

| 形态 | 适用场景 | 说明 |
|------|----------|------|
| 单机便携版 | 个人/单机使用 | 双击 EXE 即用，数据随 EXE 走（行为与 v2.x 完全一致） |
| C/S 客户端 | 团队多用户 | 应用内"连接服务器设置"或 EXE 旁 `server.config.json` 即直连服务端，本地不落数据 |
| 浏览器访问 | 团队多用户 | 直接访问服务端地址，免安装，Edge/Chrome 均可 |

## 功能特性

- **资产 CRUD** — 资产信息的增删改查，支持自定义字段下拉选项
- **数据导入导出** — Excel / JSON 格式导入导出，支持模板下载和数据备份恢复（服务端事务保护）
- **统计图表** — 4 个 Chart.js 图表（资产状态分布、人员资产、部门资产、设备类型）
- **二维码标签** — 资产二维码生成与标签打印（70mm x 50mm）
- **附件管理** — 图片 / PDF 附件上传、缩略图预览、文件查看器（支持缩放）
- **维护记录** — 资产维护记录的添加和删除
- **多用户与权限**（C/S）— 登录认证（JWT），角色 `admin / editor / viewer`，操作审计；**所有用户可自助修改自己的登录密码**（顶栏用户区 → "修改密码"，需验证旧密码）；admin 还可在"用户管理"页面重置任意用户密码 / 修改角色 / 删除账号
- **数据手动双向同步** — 两个入口：① 连接服务器设置窗口；② 系统设置 → "服务器连接"卡片。均可将服务端数据拉取到本地、或将本地数据推送到服务端（全量覆盖，带二次确认），用于单机 ↔ 服务端数据互导
- **服务端信息查看** — 系统设置"服务器连接"卡片（C/S 客户端模式自动显示）+ 连接服务器设置窗口，均展示服务器地址 / 名称 / 版本 / 当前登录用户；免鉴权 `GET /api/info` 即可查看
- **并发安全**（C/S）— 乐观锁版本冲突检测、数据版本变更提醒、批量导入事务回滚
- **皮肤主题** — 亮色 / 暗色 / 纯黑 / 科技 四套皮肤循环切换
- **离线运行**（单机版）— 完全离线使用，数据三重冗余存储

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Electron（单机版 / C/S 客户端，双模式自适应） |
| 服务端 | Node.js + Koa + better-sqlite3（SQLite WAL）+ JWT |
| 服务端打包 | @yao-pkg/pkg → 独立 `asset-server.exe`（免 Node.js 运行） |
| 前端 | 原生 HTML / CSS / JavaScript（模块化，无框架） |
| 图表 | Chart.js |
| 表格 | SheetJS (XLSX) |
| 二维码 | qrcode-generator |
| PDF预览 | pdf.js |
| 图标 | Font Awesome |
| 单机数据存储 | localStorage + IndexedDB + 本地 .js 文件（三重冗余） |
| C/S 数据存储 | SQLite 单文件（服务端唯一数据源） |

## 快速开始

### 形态一：单机便携版 .exe

1. 通过 `npm run build` 生成 portable exe（位于 `dist/` 目录下）
2. 双击 `固定资产管理系统-便携版-{version}.exe` 即可运行，无需安装
3. 双击项目根目录下的 `安装.bat` 可创建桌面快捷方式

### 形态二：C/S 客户端（接入已有服务端）

**方式一（推荐）：应用内设置** — 启动客户端 → 按 Alt 键显示菜单 → 设置 → 连接服务器设置 → 填入地址并"测试连接" → 保存并重启。全程界面操作，无需手工建文件。

**方式二：配置文件（批量预配置）** — 在客户端 EXE 同目录新建 `server.config.json`：

   ```json
   { "serverUrl": "http://<服务器IP>:3456" }
   ```

启动即直连服务端；连接失败时错误页可选"重新连接 / 修改连接设置 / 改用单机模式"。

### 形态三：浏览器访问

1. 浏览器打开 `http://<服务器IP>:3456`（生产部署包场景为 `http://<服务器IP>` 或 `https://<服务器IP>`）
2. 登录后使用（token 有效期 12 小时）

### 服务端部署（管理者）

- **推荐：生产部署包一键安装** — 将 `server/deploy/` 复制到服务器**纯英文路径**，双击 `一键安装.bat`（自动完成证书、防火墙、双 Windows 服务与健康检查）
- **源码方式** — `server/` 目录 `npm install && npm start`（需 Node.js ≥ 18）
- 详细步骤见 [CS架构部署文档.md](CS架构部署文档.md)

### 开发模式

```bash
# 安装依赖
npm install

# 启动 Electron 开发模式（单机形态）
npm start
```

### 浏览器调试（仅前端）

```bash
python -m http.server 8000
# 或 npx http-server -p 8000
```

访问 `http://localhost:8000`。注：浏览器调试模式下无 Electron 主进程，文件 API 自动降级为 IndexedDB 模式。

## 项目结构

```
├── index.html              # 主页面（登录守卫；本地快照仅 file:// 协议加载；侧栏含全局"切换运行模式"入口）
├── login.html              # 统一登录入口（模式选择卡片 + C/S 登录二合一；?switch=1 强制绕开自动免密/自动跳转）
├── styles.css              # 全局样式（含 4 套皮肤主题变量）
├── main.js                 # Electron 主进程（单机/C/S 双模式、HTTP 服务器、数据目录管理；两个 mainWindow 均注入 connection-preload.js 以暴露 connApi IPC 给渲染进程）
├── final_chart_fix.js      # 图表渲染修复（200ms 防抖）
├── asset_label_print.html  # 标签打印页面
├── 安装.bat                # 创建桌面快捷方式（调用 install.ps1）
│
├── js/                     # 前端模块
│   ├── api.js              # REST 封装 + 模式探测（embeddedMode/csMode/localMode）+ JWT
│   ├── storage.js          # 数据持久化（单机三重冗余 / C/S 服务端为唯一数据源）
│   ├── theme.js            # 皮肤主题（亮/暗/黑/科技循环切换）
│   ├── config.js · navigation.js · dashboard.js · assets.js
│   ├── asset-add.js · asset-edit.js · search-filter.js
│   ├── import-export.js · print.js · charts.js
│   ├── maintenance.js · notifications.js · init.js · users.js
│
├── libs/                   # 第三方库（离线使用）
│   └── chart / xlsx / qrcode / pdf / font-awesome 等
│
├── data/                   # 单机数据目录（运行时自动生成）
│
├── server/                 # ★ C/S 服务端（子项目）
│   ├── src/                #   index.js 入口、config、db、auth、routes/（REST + 兼容层）
│   ├── tests/api.test.js   #   57 项 API 测试（npm test）
│   ├── migrate.js          #   旧单机 JSON → SQLite 迁移工具（npm run migrate）
│   ├── backup.js           #   数据库在线备份工具
│   ├── reset-admin.js      #   admin 密码重置工具
│   ├── scripts/build-exe.js#   打包脚本（npm run build:exe → dist/asset-server.exe）
│   ├── dist/               #   独立服务端 EXE 产物
│   ├── deploy/             #   ★ 生产部署包（一键安装.bat：证书+防火墙+双服务+健康检查）
│   └── data/               #   SQLite 数据目录（asset.db）
│
├── CS架构部署文档.md       # 部署操作手册（服务端/数据库/客户端/生产环境）
├── CS架构改造变更摘要.md   # 本次 C/S 改造的变更明细
└── README.md
```

## 数据存储架构

### C/S 形态

服务端 SQLite（`server/data/asset.db`，WAL 模式）是**唯一数据源**：

```
客户端写入 → REST API（JWT 鉴权 + 乐观锁） → SQLite（事务）
客户端读取 → REST API → 服务端分页筛选
多端一致性 → 客户端轮询 /api/data-version，检测他人变更并提示刷新
```

客户端在 HTTP 模式下**不读本地快照**，避免脏数据"复活"。

### 单机形态（与 v2.x 一致）

```
写入流程 (storageManager.setItem):
  ├── 优先 → HTTP 服务器（/api/save，仅 Electron 单机模式）
  ├── 异步 → IndexedDB（大容量存储，保留完整附件数据）
  └── 同步 → localStorage（兜底）

读取流程 (storageManager.getItem):
  ├── 优先 → HTTP 服务器（/api/load，仅 Electron 单机模式）
  ├── 其次 → IndexedDB
  └── 最后 → localStorage
```

**附件分离存储**：localStorage 仅保存附件元数据，完整 base64 数据存于 IndexedDB / 服务端。

**便携模式数据目录**：
- 便携 exe：`<exe所在目录>/data/`
- C/S 服务端 EXE：`<exe所在目录>/data/`（asset.db 在此，备份它 = 备份一切）
- 安装版：`app.getPath('userData')/data/`
- 开发模式：`<项目根>/data/`

## 账号与权限（C/S 形态）

| 角色 | 权限 |
|------|------|
| admin | 全部功能 + 用户管理 + 重置他人密码 + 修改他人角色 |
| editor | 资产增删改查、导入导出、**修改自己的登录密码** |
| viewer | 只读查询、**修改自己的登录密码** |

- 默认管理员：`admin / admin123`（**首次登录后立即改密**，顶栏"修改密码"按钮自助完成）
- 忘记密码：服务端 `node reset-admin.js 新密码`（≥6 位）；或由其他 admin 登录"用户管理"页面重置
- token 有效期 12 小时，过期重新登录

## 系统设置

在「系统设置」页面可配置：
- 系统名称（全局生效：侧边栏、浏览器标签页、**登录页 logo 与客户端窗口标题**——登录页未登录时经免鉴权 `GET /api/load?key=systemSettings` 动态拉取，改名后退出登录即可看到新名称）
- 日期格式（yyyy/mm/dd 或 yyyy-mm-dd）
- 每页显示记录数
- **服务器连接卡片**（C/S 客户端模式自动显示）— 展示当前连接的服务器地址 / 名称 / 版本 / 登录用户；内置"本地 ↔ 服务器"数据双向同步按钮（拉取/推送，全量覆盖 + 二次确认，需服务端账号密码）
- 导入 / 导出按钮（Excel / JSON）
- 数据备份与恢复
- 皮肤主题（亮色 / 暗色 / 纯黑 / 科技）

## 开发指南

### 代码规范

- **中文注释** — 所有注释使用中文
- **防御性编程** — 异步操作包裹 try-catch，DOM 访问做空值检查
- **DOM 查询** — 使用 `getElement(id)` 缓存（含 `isConnected` stale 引用保护）
- **多页面** — DOM 查询必须用 `getActivePage()` 限定作用域
- **模态框** — 使用 `.active` CSS 类控制显示，禁止 inline `style.display`
- **防抖** — 使用 `config.js` 的统一 `debounce(key, fn, delay)` 函数
- **日志** — 使用 `Logger.info/warn/error(module, ...args)`
- **C/S 模式判断** — 一律经 `storage.js` 的模式探测，禁止前端自行猜测协议/端口

### 关键约束

- HTTP 模式（C/S）下严禁加载 `data/*.js` 本地快照（index.html 仅 file:// 条件加载）
- 服务端写接口必须鉴权；静态文件中间件已内置防目录穿越
- 单机模式 `saveToLocalStorage` 同步优先（先 localStorage，再 IndexedDB）
- 编辑模式必须同步隐藏详情、附件、维护记录
- 搜索字段访问必须空值保护 `(field || '').toLowerCase()`
- 通知统一使用 `showNotification(message, type, duration)` 替代 `alert`

### 服务端开发与测试

```bash
cd server
npm install
npm start          # 前台启动（默认 0.0.0.0:3456）
npm test           # 57 项 API 测试
npm run migrate -- --source "C:\旧数据" --dry-run   # 迁移预检
npm run build:exe  # 打包独立服务端 EXE
```

### 修改 JS 后测试

Electron 开发模式下 `Ctrl+R` 刷新窗口；浏览器调试时 `Ctrl+F5` 强制刷新。C/S 形态下服务端静态文件带 `Cache-Control: no-cache`，改前端 JS 后普通刷新即生效。

## 故障排查

| 问题 | 解决方案 |
|------|----------|
| 页面空白 | 检查开发者工具控制台是否有 JS 错误，确认所有 `js/` 文件加载成功 |
| 一直跳转登录页 | 未登录或 token 过期（12h），重新登录；服务端不可达也会触发 |
| 客户端连不上服务端 | 应用内"连接服务器设置"里"测试连接"；或 `curl http://<IP>:3456/api/ping` 探活；配置文件方式检查 `serverUrl` 格式 |
| 连接设置窗口按钮点了没反应 | 已修复（v3.2：① 连接窗口 `sandbox` 改为 `false` 并给 preload 加异常兜底；② 移除误加的 CSP `script-src` 限制——它会静默拦截页面内联脚本）。请使用 **dist_build_20260901122101** 及之后的构建 |
| C/S 客户端模式下"系统设置"页没有服务器信息和同步按钮 | 旧版 mainWindow 没注入 preload，渲染进程没有 `window.connApi`。v3.4 起两个 mainWindow（C/S 客户端 + 单机内嵌）都配置了 `preload: connection-preload.js` + `sandbox:false`，connApi 自动注入。请使用 **dist_build_20260901142928** 及之后的构建 |
| 单机与服务端数据不一致 | "连接服务器设置"窗口或**系统设置 → 服务器连接卡片**均可执行数据同步：填服务端账号后"服务器 → 本地（拉取）"或"本地 → 服务器（推送）"；推送为全量覆盖，操作前有二次确认 |
| 提示"数据已被他人修改" | 多端并发场景正常提示，刷新后重试即可 |
| 单机数据不显示 | `Ctrl+F5` 强制刷新；检查 localStorage 和 IndexedDB 是否有数据 |
| 图表不渲染 | 确认 `libs/chart.min.js` 已加载；检查 `final_chart_fix.js` 是否执行 |
| Excel 导入导出不可用 | 确认 `libs/xlsx.full.min.js` 已加载 |
| 便携 exe 启动后数据丢失 | 检查 exe 所在目录的 `data/` 文件夹是否可写 |
| 服务端启动失败 | 查看 `server/deploy/logs/` 下 .err.log；确认部署路径为纯英文（nginx 限制） |
| nginx 报 cannot load certificate | 部署路径含中文，移到纯英文路径后重启服务 |
| 忘记 admin 密码 | 三种方式：① 若有其他 admin 账号登录，可在"用户管理"页面重置；② 服务端执行 `node reset-admin.js 新密码`；③ 自己记得旧密码的话，顶栏直接点"修改密码"自助修改 |

## 打包部署

```bash
# ── 单机客户端 ──
npm run build        # 便携版 .exe（首次构建 Windows 会弹窗要 UAC 确认，用于自动提权 rcedit 写入 PE 版本资源）
npm run build:nsis   # NSIS 安装版
npm run pack         # 仅打包不压缩（调试）

# ── 服务端 ──
cd server
npm run build:exe    # Windows 独立服务端 EXE → server/dist/asset-server.exe
npm run build:linux  # Linux x64 产物 → server/dist/asset-server-linux（glibc ≥ 2.28）
```

> **关于 PE 版本字符串**：electron-builder 通过 `rcedit-x64.exe` 写入 `FileDescription` / `ProductName` / `InternalName` 等 PE 资源字段，Windows 上该工具**必须以管理员权限运行**才能提交到文件的 `.rsrc` 节。`scripts/build-portable.js` 已内置自动提权逻辑：非管理员会话执行 `npm run build` 会自动弹 UAC，确认后以管理员重跑整个构建流程，无需手动右键"以管理员身份运行"。若跳过提权，rcedit 会报 `Fatal error: Unable to commit changes` 但 electron-builder 仍会重试 3 次后继续，构建产物可运行但"文件版本/产品名/内部名称"等字段会缺失（不影响功能，仅影响资源管理器属性页展示）。

生产部署使用 `server/deploy/` 部署包（nginx 反代 + 自签证书 + NSSM 服务化，一键安装），完整手册见 **[CS架构部署文档.md](CS架构部署文档.md)**；Linux 服务器（systemd + nginx/certbot）见部署文档**第 11 章**。

**构建优化**：
- `electronLanguages: ["zh-CN", "en-US"]` 仅保留中英文语言包
- `compression: "maximum"` 最大压缩比
- 自动排除 `.md` / `.ts` / `.map` / `node_modules` 等无关文件

**构建陷阱（务必注意）**：
- **`build.files` 是严格的白名单制**：electron-builder 只会打包 `build.files` 数组里显式列出的文件，**没有"默认包含全部文件"兜底**。新增根目录 HTML/JS/CSS 文件（如 `login.html`）必须同步加到 `build.files`，否则 app.asar 里没有、运行时 404（2026-08-31 曾踩此坑，内嵌服务 `loadURL(/login.html)` 返回 404 fallback 页）。子目录下的新文件（如 `js/users.js`）如果已有 `js/**/*` glob 覆盖则无需额外加。
- **rcedit-x64.exe 需要管理员权限**：写入 PE 版本资源必须以管理员身份运行 electron-builder。`scripts/build-portable.js` 已内置自动提权（非管理员 → PowerShell `Start-Process -Verb RunAs` → UAC → 重跑），无需手动右键。跳过提权时 rcedit 会报 `Fatal error: Unable to commit changes`（electron-builder 重试 3 次后继续，产物可运行但属性页缺 FileDescription/InternalName）。

## 版本历史

- **v3.4.1** (2026-09-03) — 系统名称全局生效修复（登录页/窗口标题）+ 兼容层白名单修复：
  - **登录页动态系统名称**：`login.html` 新增 `applySystemName()`，未登录时经免鉴权 `GET /api/load?key=systemSettings` 拉取系统名称，动态更新登录页 logo 文案与 `<title>`（Electron 窗口标题经 `page-title-updated` 同步）；fetch 失败时降级读 `localStorage.last_system_name` 缓存
  - **服务端鉴权白名单精确放行**：`server/src/index.js` 全局鉴权中间件对 `GET /api/load` 仅放行公开键 `systemSettings` 与 `custom_options_*`（登录页/下拉选项需要），其余键（如 `assetManagementData` 资产数据）仍返回 401，安全边界不变
  - **兼容层 KV 白名单支持前缀匹配**：`server/src/routes/compat.js` 的 save/delete 键名校验新增 `asset_userStateData_*` 前缀（用户视图状态数据），修复带 userId 后缀的键被 400 拒绝
  - **设置保存提示改 toast**：`js/events.js` 保存系统设置后的原生 `alert('设置已保存')` 改为 `showNotification()`，避免 Electron 同步弹窗标题异常与键盘焦点丢失
  - 端到端验证：浏览器 6 步（改名→退出两次→登录页→重登持久化）通过；Electron 清缓存启动窗口标题为"登录 - 固定资产管理系统PRO"；无 token 访问资产键仍 401
  - 打包：`dist\固定资产管理系统-便携版-2.4.5.exe`（61.4 MB）

- **v3.4** (2026-09-01) — 用户管理升级 + 设置页服务器信息与同步入口统一：
  - **所有用户可自助修改登录密码**：顶栏"修改密码"按钮（admin/editor/viewer 均可），前端旧密码校验 + 两次新密码一致性校验 + 最小 6 位；服务端已有 `POST /api/auth/change-password` 接口（bcrypt 校验旧密码后更新 hash），admin 仍可在"用户管理"页面重置任意用户密码。同步修改：js/api.js 新增 `changePassword()`、index.html 顶栏加按钮 + 弹窗、js/users.js 新增弹窗逻辑
  - **系统设置页新增"服务器连接"卡片**：C/S 客户端模式自动显示（检测到 `window.connApi` 即渲染），展示当前服务器地址 / 名称 / 版本 / 登录用户名与角色；卡片下方集成"本地 ↔ 服务器"双向同步表单（服务器地址预填 + 账号密码 + 拉取/推送按钮 + 结果区），原连接服务器设置窗口（Ctrl+Alt+S）的同步功能现在有了两个入口
  - **mainWindow 注入 preload**：两个 BrowserWindow（C/S 客户端 L1416 + 单机内嵌 L1581）新增 `preload: path.join(APP_DIR, 'connection-preload.js')` + `sandbox:false`（preload 里需要 `require('electron')` 获取 contextBridge/ipcRenderer），渲染进程现在能调用 `window.connApi.get()`/`syncPull()`/`syncPush()` 等 IPC；修复之前 mainWindow 没有任何 preload → 没有 connApi → 设置页无法显示服务器信息和同步按钮的问题
  - 服务端 API 实测：`admin → POST /api/auth/change-password → 200 {changed:true}` 通过；新前端文件已 pscp 同步到 Linux `/opt/asset-server/`
  - 打包：`dist_build_20260901142928\固定资产管理系统-便携版-2.4.5.exe`（61.45 MB）

- **v3.3** (2026-09-01) — Electron C/S 客户端模式白屏卡死 + 源码部署前端文件缺失根因修复：
  - 服务端源码部署方式 B 只传了 `server/` 目录漏前端文件 → `/opt/asset-server/` 补传 index.html / login.html / styles.css / asset_label_print.html / final_chart_fix.js / build-info.json + js/(18) + libs/(7) → 全部 HTTP 200，无需重启 Node
  - **Electron 客户端双重防护**：① 启动前 `probeClientServer` 预检并发探测 `/api/info` + `/login.html`，API 活但静态 404 时直接渲染友好错误页（带黄色修复提示框告诉用户"补传前端文件到项目根目录"）；② `loadURL` 后用 `mainWindow.webContents.session.webRequest.onHeadersReceived`（注意：Electron ≥23 已废弃 `webContents.webRequest`，必须用 `session.webRequest`）拦截主框架 HTTP 4xx/5xx，cancel 导航并渲染友好错误页
  - 根因链：用户部署 Linux 只传 server/ → 静态全 404 → Electron loadURL 收到 404 HTML 但 did-fail-load 不算 HTTP 错误 → 旧版又用了废弃 API `webContents.webRequest` 被 try-catch 吞掉 → 白屏卡死
  - 部署文档升级至 v2.9

- **v3.2** (2026-09-01) — 连接设置窗口升级：新增服务端信息面板（免鉴权 `/api/info`）与**数据手动双向同步**（服务器 → 本地拉取 / 本地 → 服务器推送，全量覆盖 + 二次确认 + 每键同步明细回显）；修复连接设置窗口按钮点击无反应（两处根因：Electron sandbox + asar 内 preload 静默失败 → `sandbox: false` + preload 异常兜底；误加 CSP `script-src 'self'` 拦截内联脚本 → 移除）；服务端实测 `192.168.40.251:3456` 双向同步全链路通过

- **v3.1** (2026-08-31) — 客户端应用内连接设置：Alt 菜单 →"连接服务器设置"（测试连接/保存并重启/清除设置），连接失败三选兜底，`server.config.json` 降级为批量预配置方式；Linux/iStoreOS 部署文档与 verify-linux.sh 验证脚本

- **v3.0** (2026-08-30) — C/S 架构改造：新增 Node.js + SQLite 服务端（角色权限/乐观锁/审计/迁移备份工具），前端登录与 REST 化，Electron 双模式客户端化，服务端独立 EXE 打包，生产部署包（nginx + 自签证书 + NSSM 一键安装），暗色系皮肤

- **v2.4.4** (2026-08-14) — 代码整理与文档更新，优化项目结构和部署流程
- **v2.4.3** (2026-08-14) — 全项目性能优化 + 运行时 Bug 修复（P0~P3 全部完成）
- **v2.4.2** (2026-08-14) — 自动文件同步与手动连接体验优化
- **v2.4.1** (2026-08-14) — 模态框闪烁修复 + 编辑模式视觉优化
- **v2.4** — 初始版本

## 许可

本项目仅供内部使用。
