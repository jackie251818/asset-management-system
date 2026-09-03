# 固定资产管理系统 C/S 架构部署文档

| 项目 | 内容 |
|---|---|
| 文档版本 | v3.0（服务端 v1.0.0；新增 v3.4 客户端改动：系统设置页服务器连接卡片 + mainWindow preload 注入 + 用户自助改密码；保留 v2.9 全部内容：源码部署前端文件缺失风险说明 + 客户端模式 HTTP 404 预检/拦截增强；7.3 客户端接入含应用内连接设置、服务端信息面板与数据手动双向同步） |
| 架构形态 | 客户端/服务端（C/S），服务端内嵌 SQLite 数据库 |
| 适用系统 | Windows 10 / 11 / Windows Server 2016+；Linux x64（Ubuntu 20.04+/Debian 11+/RHEL 9+，见第 11 章）；CentOS 7 专用方案见第 12 章 |
| 维护要求 | 服务端需固定内网 IP 或 DHCP 保留地址 |

---

## 1. 架构总览

```
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│  客户端 A (浏览器)  │   │  客户端 B (浏览器)  │   │  客户端 C (Electron) │
└────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘
         │   HTTP REST (JWT 鉴权) │                      │
         └──────────────┬───────┴──────────────────────┘
                        ▼
        ┌───────────────────────────────┐
        │  服务端 asset-server.exe        │  ← 监听 0.0.0.0:3456
        │  (源码部署 = Node.js + Koa)     │     EXE 免 Node；源码需 Node ≥ 18
        ├───────────────────────────────┤
        │   SQLite 数据库 (嵌入式)        │  ← data/asset.db 单文件
        └───────────────────────────────┘
```

| 组件 | 说明 | 通信端口 |
|---|---|---|
| 服务端进程 | 独立 EXE（`asset-server.exe`，免 Node.js）或源码方式（Node.js 运行 `server/src/index.js`） | TCP 3456（可通过环境变量修改） |
| 数据库 | SQLite 单文件，随服务端进程嵌入运行，**无需单独安装数据库软件** | 本地文件 IO，无网络端口 |
| 客户端 | 浏览器 / Electron 客户端（见第 7 章） | 访问服务端 3456；生产部署包场景经 nginx 80/443 |

**部署路径导航**（按服务器系统选择阅读）：

| 部署场景 | 阅读路径 |
| --- | --- |
| Windows 直连（单机/部门级） | 第 2、3 章（数据与迁移第 4 章）→ 启动自启第 5 章 → 网络 6.1-6.3 |
| Windows 生产（统一入口 + HTTPS + 服务化） | 第 6.4 节生产部署包 |
| Linux（现代发行版） | 第 11 章 |
| CentOS 7 | 第 12 章 |
| 客户端接入 / 安全加固 / 日常运维 / 排障 | 第 7 / 8 / 9 / 10 章 |

---

## 2. 部署前准备

### 2.1 环境要求

| 项 | 服务端 | 客户端 |
|---|---|---|
| 操作系统 | Windows 10/11、Windows Server 2016+；**Linux x64 见第 11 章** | Windows 7+（浏览器方式不限系统） |
| 运行环境 | EXE 方式：无需；源码方式：Node.js ≥ 18（已验证 v22.16.0） | 无（浏览器）；Electron 客户端无需 Node |
| 内存 | ≥ 2GB | ≥ 2GB |
| 磁盘 | ≥ 1GB（含数据与备份空间） | — |
| 网络 | 固定内网 IP，客户端可访问 3456（部署包方案对外为 80/443） | 与服务端同局域网 |

### 2.2 下载与检查清单

- [ ] **部署物（二选一）**
  - [ ] 方式 A（推荐）：`server\dist\asset-server.exe` 独立 EXE；生产环境建议直接取 `server\deploy\` 生产部署包（已含 EXE + nginx + nssm + 服务脚本）
  - [ ] 方式 B：整个 `server/` 源码目录（`package.json`、`src/`、`tests/`）
- [ ] （仅方式 B）Node.js LTS 安装包（https://nodejs.org/）
- [ ] （Linux/CentOS 部署）`asset-server-linux` 产物或源码、`deploy/asset-server.service`（CentOS 7 为 `asset-server-centos7.service`）、`verify-linux.sh`（见第 11/12 章）
- [ ] 旧单机版数据目录（含 `assetManagementData.json/.js` 等，用于第 4.6 节迁移）
- [ ] 服务器固定 IP 已配置
- [ ] 已通读 2.3 Windows 部署注意事项汇总

### 2.3 Windows 部署注意事项汇总

部署前通读，可避免绝大多数现场问题（Linux 版对应 11.12 节）：

| # | 事项 | 说明 |
| --- | --- | --- |
| 1 | 程序目录选择 | 用**纯英文、无空格**路径（如 `D:\asset-server`），可减少 bat/NSSM 的引号解析类问题；避免桌面、OneDrive/同步盘目录；**不要放 `C:\Program Files\`**——UAC 写入重定向会把数据写到 VirtualStore 造成"数据丢失"假象 |
| 2 | 部署包路径必须 ASCII | 仅 6.4 部署包（nginx）硬性要求：中文路径下证书加载失败、服务起不来；一键安装.bat 已内置预检拦截 |
| 3 | 数据目录 | 必须本地物理盘；勿放 U 盘/网络映射盘/exFAT（原子写不可靠，见 4.3）；勿被 OneDrive/坚果云等同步工具管理——同步锁与 SQLite 锁冲突会损坏数据库 |
| 4 | 杀软/Defender 排除 | 将程序与数据目录加入排除，防止实时扫描拖慢 SQLite 写入；pkg 打包的单文件 EXE 偶发被误报，同样以排除解决：`Add-MpPreference -ExclusionPath "D:\asset-server"` |
| 5 | 端口占用 | 先查后装：`netstat -ano | findstr :3456`；Server 系统注意 **IIS 默认占用 80/443**（`W3SVC` 服务），冲突则停用 IIS 或改用 3456 直连方案 |
| 6 | 系统保留端口段 | Hyper-V/WSL/WinNAT 的动态排除范围可能吞掉 3456：`netsh interface ipv4 show excludedportrange protocol=tcp`，命中则换端口（`ASSET_PORT`）并重启 WinNAT 或系统 |
| 7 | 电源计划 | 服务器设**高性能 + 从不睡眠**（睡眠=服务中断）：控制面板 → 电源选项；显示器关闭无影响 |
| 8 | Windows 更新重启 | NSSM 服务 / 计划任务(ONSTART) 会随开机自动恢复；重启后按 5.3 验证一次 |
| 9 | PowerShell 执行策略 | 运行 `.ps1`（如 make-cert.ps1）用 `powershell -ExecutionPolicy Bypass -File xxx.ps1`，勿全局放开策略 |
| 10 | bat 编码 | 一键安装.bat 按 **GBK/ANSI** 编码交付（cmd 中文正常显示）；自行编辑时勿存成 UTF-8，否则中文注释/提示乱码 |
| 11 | 计划任务账号 | `/RU SYSTEM` 最省事（无密码、不受改密影响）；用普通账号则必须勾"不管用户是否登录都要运行"并录入密码 |
| 12 | 时间同步 | `w32tm /resync`；服务器时间漂移大会导致 JWT 过期判断异常（登录态提前/延后失效） |
| 13 | 防火墙 profile | netsh 放行规则默认作用于全部配置文件（域/专用/公用）；更稳妥的做法是把服务器网卡的网络位置设为**专用**，并按 6.2 限定来源网段 |
| 14 | 升级窗口 | 升级=停服务→替换 EXE→启服务（秒级）；数据目录（asset.db）不参与升级，升级前照例先备份（4.4） |

---

## 3. 服务端部署步骤

> **部署方式二选一**：
> - **方式 A：独立 EXE（推荐）**——免装 Node.js，把 `server\dist\asset-server.exe` 复制到服务器任意**可写且建议纯英文**的目录直接运行（具体步骤见 3.0）；生产环境建议直接采用 `server\deploy\` 一体化部署包（EXE + nginx + HTTPS + 一键服务化，见第 6.4 节）。
> - **方式 B：源码部署**——适合需要二次开发或深度使用工具脚本的场景，需 Node.js 环境，步骤见 3.1-3.4。
>
> 注意：`backup.js`、`reset-admin.js`、`migrate` 等工具脚本依赖 Node.js 环境（源码部署自带）。**EXE 部署**的机器可在旁边另放一份 `server/` 源码目录专用于跑工具脚本，或采用 4.4 方式 C 冷备份。

### 3.0 方式 A：独立 EXE 部署步骤（免 Node.js）

```powershell
# ① 建目录并放置 EXE（路径建议纯英文, 事项见 2.3-#1）
New-Item -ItemType Directory -Path "D:\asset-server" -Force
Copy-Item "server\dist\asset-server.exe" "D:\asset-server\"

# ② 前台首次启动验证
cd D:\asset-server
.\asset-server.exe
#    出现服务端横幅即初始化完成; 数据目录默认跟随 EXE 所在目录(data\), 与启动时的工作目录无关
#    需独立数据盘: $env:ASSET_DATA_DIR = "D:\asset-data" 后再启动(服务化后改 NSSM AppEnvironmentExtra, 见 5.2)

# ③ 探活
curl http://127.0.0.1:3456/api/ping        # 返回含 "pong" 即正常 (Ctrl+C 可停止)

# ④ 开机自启(最简方案: 计划任务; 无崩溃拉起能力, 需要时改用 6.4 部署包的 NSSM 服务)
schtasks /Create /TN "AssetServer" /TR "D:\asset-server\asset-server.exe" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
schtasks /Run /TN "AssetServer"            # 立即启动一次以验证
schtasks /Query /TN "AssetServer" /V       # 查看状态

# ⑤ 放行端口 + 跨机验证
netsh advfirewall firewall add rule name="AssetServer 3456" dir=in action=allow protocol=TCP localport=3456
#    客户端机器: curl http://<服务器IP>:3456/api/ping
```

> - 计划任务方式的日志不可见，排障可先前台运行 `.\asset-server.exe` 复现；生产长期运行建议 6.4 部署包（NSSM 服务 + 日志轮转 + nginx 入口）。
> - 备份/迁移/重置密码等工具脚本依赖 Node.js：EXE 部署机器可另备一份 `server/` 源码目录（3.1-3.3 装好依赖，不启动服务，仅跑脚本），或用 4.4 方式 C 冷备份。

### 3.1 安装 Node.js（仅方式 B 需要）

1. 双击 Node.js LTS 安装包，全部默认下一步（自动加入 PATH）；
2. 验证安装（命令提示符或 PowerShell）：

```powershell
node -v    # 应输出 v18 以上版本
npm -v     # 应输出 9 以上版本
```

### 3.2 复制服务端程序

将**整个项目根目录**复制到服务器（前端文件 + `server/` 后端源码 + 根目录配置），例如：

```
D:\asset-server\                    ← 以下均以此路径为例
├── index.html                      ★ 前端主页面 (静态文件服务基准)
├── login.html                      ★ 登录页
├── styles.css                      ★ 样式表
├── asset_label_print.html          ★ 标签打印页
├── final_chart_fix.js              ★ 图表修复脚本
├── build-info.json                 ★ 构建信息
├── js\                             ★ 前端业务脚本 (api.js / assets.js / dashboard.js ...)
├── libs\                           ★ 第三方库 (chart.min.js / xlsx / pdf / qrcode ...)
├── server\
│   ├── package.json
│   ├── src\                        ← 服务端源码
│   ├── tests\                      ← 测试脚本
│   └── data\                       ← 数据目录（数据库文件存放处，自动创建）
└── node_modules\                   ← 执行 3.3 后生成（不要跨平台拷贝！）
```

> **⚠️ 2026-09-01 实测踩坑（Linux 方式 B 同此）**：服务端静态文件基准 `STATIC_ROOT = path.join(config.SERVER_ROOT, '..')`，源码运行时解析为 `server/` 目录的**上一级**——前端文件必须放在 `server/` 旁边（与 `server/` 平级），不是放在 `server/` 里面。如果只传了 `server/` 而漏了根目录前端文件，`/login.html`、`/index.html`、`/js/*`、`/libs/*` 全部返回 HTTP 404。**方式 A 打包产物无此问题**——pkg 的 assets 字段已声明把前端文件嵌入 `asset-server.exe`。

> 建议不要放在 `C:\Program Files\` 等受 UAC 保护的目录，避免写入权限问题。

### 3.3 安装依赖

```powershell
cd D:\asset-server
npm install --omit=dev
```

- `better-sqlite3` 为原生模块，npm 会自动下载 Windows x64 预编译二进制，正常情况无需编译环境；
- 若服务器**无法联网**，在任一台联网的同系统（Windows x64）机器上执行 `npm install --omit=dev`，然后将整个 `server` 目录（含 `node_modules`）整体拷贝到服务器即可。

### 3.4 首次启动验证

```powershell
cd D:\asset-server
npm start
```

启动成功会输出横幅：

```
==============================================
  固定资产管理系统 - 服务端 v1.0.0
==============================================
  监听地址 : 0.0.0.0:3456
  数据库   : D:\asset-server\data\asset.db
  本机访问 : http://127.0.0.1:3456
  局域网   : http://192.168.1.10:3456
  初始账号 : admin / admin123 (请登录后立即修改密码)
==============================================
```

看到横幅即表示服务端与数据库初始化完成。按 `Ctrl+C` 停止，继续后续配置。

---

## 4. 数据库部署（重点）

### 4.1 数据库选型说明

本系统使用 **SQLite** 作为数据库，特点与部署影响：

| 特性 | 说明 |
|---|---|
| **免安装** | SQLite 以库形式嵌入服务端进程，**不需要**在服务器上安装 MySQL/SQL Server 等数据库软件 |
| **单文件存储** | 整个数据库就是磁盘上的一个文件 `asset.db`，备份=复制文件，搬家=拷贝文件 |
| **WAL 并发模式** | 服务端启用 WAL（Write-Ahead Logging），多客户端同时读写不互相阻塞 |
| **事务保障** | 导入/批量操作全部走事务，断电、异常中断不会产生半写数据 |
| **容量** | 单文件支持 TB 级，资产管理系统万级资产规模完全够用 |

> 服务器上只会看到三个文件：`asset.db`（主库）、`asset.db-wal` / `asset.db-shm`（WAL 运行时文件，勿手工删除）。

### 4.2 数据库初始化（自动完成）

首次启动服务端时自动执行，无需人工干预：

1. 在数据目录创建 `asset.db` 并建全部表（用户表、资产表、维保记录表、附件表、选项表、KV 表、审计日志表）；
2. 若用户表为空，创建初始管理员：**admin / admin123**（⚠️ 部署后必须立即登录修改密码，见第 8 章）；
3. 在数据目录生成 `secret.key`（JWT 签名密钥，64 位随机 hex）。

### 4.3 自定义数据库存放位置

默认数据库位于 `server\data\asset.db`。如需放到其他位置（如独立数据盘 D:\asset-data\），通过环境变量指定：

```powershell
$env:ASSET_DATA_DIR = "D:\asset-data"     # 数据目录（数据库、secret.key、备份都在此）
$env:ASSET_DB_PATH  = "D:\asset-data\asset.db"   # 也可只单独指定数据库文件
npm start
```

> - 只设 `ASSET_DATA_DIR` 即可，`ASSET_DB_PATH` 通常不必单独设；
> - 数据目录请勿放在 U 盘/网络映射盘（FAT32/exFAT 不支持部分原子操作，且断连易损坏数据库）；
> - 全部环境变量见附录 A。

### 4.4 数据库备份

> 下方方式 A/B 的备份脚本依赖 Node.js 环境（源码部署自带）；**EXE 部署**可用方式 C 冷备份，或另备一份 `server/` 源码目录跑工具脚本（见第 3 章说明）。

#### 方式 A：在线热备份（推荐，不停机）

程序已内置备份脚本 `server\backup.js`（基于 SQLite 在线备份 API，复制期间服务可正常使用）：

```powershell
cd D:\asset-server
node backup.js                 # 备份到 <数据目录>\backups，自动保留最近 10 份
node backup.js E:\db-backups   # 或指定备份目录
```

#### 方式 B：定时自动备份（结合 Windows 计划任务）

以每天 02:00 自动备份为例（管理员 PowerShell 执行一次即可）：

```powershell
schtasks /Create /TN "AssetDB备份" /TR "node D:\asset-server\backup.js" /SC DAILY /ST 02:00 /RU SYSTEM
```

#### 方式 C：冷备份（停机维护时）

停止服务端后，直接复制整个数据目录即可（此时没有 `-wal/-shm` 半写风险）：

```powershell
# 服务端已停止
Copy-Item D:\asset-server\data D:\backup\data-20260830 -Recurse
```

**备份保留策略建议**：每日 1 份保留 10 天 + 每周 1 份保留 2 个月；备份目录尽量与数据目录**不同物理磁盘**。

### 4.5 数据库恢复

1. 停止服务端（第 5.2 节的服务：`nssm stop AssetServer`，或直接关闭进程）；
2. 将备份的 `asset-xxx.db` 复制回数据目录并改名覆盖 `asset.db`；
3. 删除旧的 `asset.db-wal`、`asset.db-shm`（如存在，属于被覆盖库的残留）；
4. 启动服务端，登录验证数据完整。

> `server/data/asset.db.bak-<时间戳>` 是迁移工具的自动备份，同样可按上述步骤恢复。

### 4.6 迁移旧单机版数据（JSON → SQLite）

旧便携版/单机版的数据是 JSON 文件，需一次性迁移进 SQLite（迁移工具依赖 Node.js，EXE 部署机器请另备源码目录，见第 3 章说明）。

**① 找到旧数据目录**（二选一，以实际存在为准）：

- 便携模式：旧版 exe 旁边的 `data\` 目录；
- 安装模式：`C:\Users\<用户名>\AppData\Roaming\固定资产管理系统\data`。

目录内应能看到 `assetManagementData.json`（或 `.js`）、`custom_options_*.json` 等文件。

**② 预检（不写库，只校验）**：

```powershell
cd D:\asset-server
npm run migrate -- --source "C:\旧版数据路径\data" --dry-run
```

输出 `将导入: 资产 N 条...` 即预检通过；若提示无效数据，按提示先在旧版中修复。

**③ 执行迁移**：

```powershell
npm run migrate -- --source "C:\旧版数据路径\data"
```

工具自动完成：旧数据目录备份到 `_migrate_backup_<时间戳>` → 数据库文件备份（如已存在）→ 事务导入 → 逐键核对报告（全部 PASS 为成功）。

**④ 迁移参数**：

| 参数 | 说明 |
|---|---|
| `--source <目录>` | 旧版数据目录（必填） |
| `--db <路径>` | 指定目标数据库文件（默认 data\asset.db） |
| `--mode merge` | 默认。按资产编号 upsert：已存在则更新，不存在则新增 |
| `--mode replace` | 清空库中资产数据后全量导入（危险，确认后使用） |
| `--dry-run` | 只校验不写库 |

**⑤ 验证**：启动服务端，用客户端/接口抽查资产总数、下拉选项、维保记录是否与旧版一致。

### 4.7 数据库日常维护（可选）

```powershell
# 完整性检查（输出 integrity_ok 即健康）
node -e "const db=require('better-sqlite3')('data/asset.db');console.log(db.pragma('integrity_check'));db.close()"

# WAL 收敛（长期运行后减小 -wal 文件；服务端运行中也可执行）
node -e "const db=require('better-sqlite3')('data/asset.db');db.pragma('wal_checkpoint(TRUNCATE)');db.close()"

# 空间回收（删除大量数据后执行；建议停服窗口内进行）
node -e "const db=require('better-sqlite3')('data/asset.db');db.exec('VACUUM');db.close()"
```

### 4.8 后续升级数据库的说明

当前规模 SQLite 足够。若未来出现超高并发（如百人同时写）或多分支机构异地写入，可平迁 MySQL/PostgreSQL：服务端数据访问集中在 `db.js` 与路由层，届时替换驱动并保持 API 不变即可，客户端无需任何改动。此为预留路径，当前无需操作。

---

## 5. 启动与开机自启

### 5.1 前台运行（调试用）

```powershell
cd D:\asset-server
npm start
```

### 5.2 注册为 Windows 服务

> **生产推荐直接使用第 6.4 节部署包一键方案**（`install-service.bat`：同时装好服务端 + nginx 反代两个服务，内置日志轮转、开机自启）。以下为源码部署时的手动 NSSM 步骤。

使用 [NSSM](https://nssm.cc/download)（下载后将 `nssm.exe` 放入如 `D:\tools\`），管理员 PowerShell：

```powershell
# 1. 安装服务
D:\tools\nssm.exe install AssetServer "C:\Program Files\nodejs\node.exe" "D:\asset-server\src\index.js"

# 2. 设置工作目录与环境变量
D:\tools\nssm.exe set AssetServer AppDirectory D:\asset-server
D:\tools\nssm.exe set AssetServer AppEnvironmentExtra ASSET_PORT=3456 ASSET_DATA_DIR=D:\asset-server\data

# 3. 崩溃自动重启
D:\tools\nssm.exe set AssetServer AppExit Default Restart
D:\tools\nssm.exe set AssetServer AppRestartDelay 5000

# 4. 启动并设为自启
D:\tools\nssm.exe start AssetServer
```

常用管理命令：

```powershell
D:\tools\nssm.exe status AssetServer    # 查看状态
D:\tools\nssm.exe restart AssetServer   # 重启（升级/恢复数据后）
D:\tools\nssm.exe stop AssetServer      # 停止
D:\tools\nssm.exe remove AssetServer confirm   # 卸载服务
```

> 替代方案：不改代码也可用"任务计划程序"设置开机运行 `npm start`，但无崩溃拉起能力，生产建议 NSSM。

### 5.3 部署验证

```powershell
# 本机
curl http://127.0.0.1:3456/api/ping
# 其他客户端机器（换成服务器内网 IP）
curl http://192.168.1.10:3456/api/ping
```

返回 JSON 含 `"success":true` 与 `"pong"` 即正常（`/api/ping` 为免鉴权探活接口）。

---

## 6. 防火墙、网络与生产部署包（Windows）

> 6.1-6.3 为基础网络配置；**6.4 是面向生产的完整部署方案**（nginx 统一入口 + HTTPS + 双服务化，体量较大故并列于本章），生产环境优先直接采用。

### 6.1 放行服务端口（服务器上执行，管理员权限）

```powershell
netsh advfirewall firewall add rule name="AssetServer 3456" dir=in action=allow protocol=TCP localport=3456
```

### 6.2 限制访问来源（可选加固）

只允许指定网段访问（替换为实际办公网段）：

```powershell
netsh advfirewall firewall delete rule name="AssetServer 3456"
netsh advfirewall firewall add rule name="AssetServer LAN" dir=in action=allow protocol=TCP localport=3456 remoteip=192.168.1.0/24
```

### 6.3 修改端口

```powershell
# 环境变量方式（NSSM 场景改 AppEnvironmentExtra 后 restart）
$env:ASSET_PORT = "8080"
```

修改后同步更新防火墙规则与客户端配置的服务器地址。

### 6.4 生产部署包：nginx 反向代理 + HTTPS + 一键服务化（可选增强）

`server/deploy/` 目录是开箱即用的生产部署包，提供 **80/443 统一入口 + TLS 加密 + Windows 服务自启**。拓扑：

```
浏览器 / Electron 客户端 ──HTTP 80 / HTTPS 443──► nginx ──► asset-server.exe (127.0.0.1:3456)
```

**目录清单**（部署前请核对）：

```
server/deploy/
├── 一键安装.bat            # ★ 一键安装入口（证书+防火墙+双服务+健康检查）
├── asset-server.exe        # 服务端（server/ 下 npm run build:exe 产物，复制进来）
├── nginx/                  # nginx Windows 版（含 nginx.exe 与 conf/）
├── nssm.exe                # 服务封装工具 (https://nssm.cc)
├── make-cert.ps1           # 自签证书生成脚本（一键脚本自动调用）
├── nginx.conf              # 反向代理配置（install 时自动复制到 nginx/conf/）
├── install-service.bat     # 服务安装（一键脚本自动调用，也可单独使用）
├── uninstall-service.bat   # 一键卸载
└── cert/                   # make-cert.ps1 生成（server.crt / server.key）
```

**部署步骤**（管理员 PowerShell）：

```powershell
# 1. 把整个 deploy 目录复制到服务器，必须是纯英文(ASCII)路径！
#    ✔ C:\asset-server   ✘ D:\资产管理系统\deploy
#    原因: nginx Windows 版使用 ANSI 路径 API, 非 ASCII 路径下无法读取证书/配置
#    (一键安装.bat 内置预检, 中文路径下会直接报错拦截)
Copy-Item -Recurse "server\deploy" "C:\asset-server"

# 2. 双击运行 一键安装.bat (或在管理员 PowerShell 中执行 .\一键安装.bat), UAC 点"是"
#    脚本自动完成: ASCII 路径预检 -> 预置 asset-server.exe(缺则从 ..\dist 取) ->
#    生成自签证书 -> 防火墙放行 80/443 -> 安装并启动 AssetServer+AssetNginx ->
#    健康检查(HTTP 80 / HTTPS 443) -> 打印访问地址与账号信息
.\一键安装.bat

# 3. 按脚本末尾汇总验证; 默认账号 admin/admin123, 登录后立即改密
```

<details>
<summary>分步执行（与一键脚本等价，便于排障或自定义）</summary>

```powershell
Set-Location C:\asset-server

# ① 生成自签证书 (SAN 自动覆盖 localhost + 主机名 + 全部局域网 IPv4, 有效期 10 年)
powershell -ExecutionPolicy Bypass -File make-cert.ps1
#    浏览器首次访问 443 会有"不受信任"告警(自签证书的固有提示), 点"继续访问"即可;
#    若要消除告警, 把 cert\server.crt 分发给客户端导入"受信任的根证书颁发机构"。

# ② 放行 80/443 (服务端 3456 仅监听本机回环, 无需对外放行)
netsh advfirewall firewall add rule name="AssetWeb 80"  dir=in action=allow protocol=TCP localport=80
netsh advfirewall firewall add rule name="AssetWeb 443" dir=in action=allow protocol=TCP localport=443

# ③ 一键安装并启动两个 Windows 服务 (自动: nginx.conf 部署 / 日志轮转 / 开机自启)
.\install-service.bat

# ④ 验证
curl http://127.0.0.1/api/ping      # 经 nginx 80 → 服务端
curl -k https://127.0.0.1/api/ping  # 经 nginx 443 (TLS) → 服务端
```

</details>

**日常管理**：

```powershell
sc.exe query AssetServer          # 查询服务状态 (nginx 为 AssetNginx)
.\nssm.exe restart AssetServer    # 重启服务端 (改配置/升级后)
.\nssm.exe restart AssetNginx
Get-Content logs\asset-server.err.log -Tail 50   # 故障排查先看错误日志
.\uninstall-service.bat         # 卸载(数据目录保留, 手动删除)
```

**升级服务端**：停 AssetServer → 覆盖 `asset-server.exe` → `.\nssm.exe restart AssetServer`（数据在 `data\asset.db`，升级不影响）。

**关键约束与已验证事项**（本机实测）：

| 事项 | 说明 |
| --- | --- |
| 路径必须纯 ASCII | nginx Windows 版 ANSI 路径限制，中文路径会导致 `cannot load certificate` 启动失败（一键脚本已内置预检拦截） |
| 证书相对路径 | nginx.conf 内 `../../cert/` 相对的是 **conf/ 目录**（非 prefix），勿改动 |
| nginx\logs 目录 | nginx 不会自动创建日志目录，缺失将启动失败；一键脚本已内置补建，手动部署时需自建 |
| AppDirectory 转义坑 | bat 已内置修复：`%~dp0` 尾反斜杠传给 nssm 会转义引号损坏 AppDirectory |
| 兼容性 | 80/443 入口均代理到 127.0.0.1:3456，服务端保持回环监听，安全模型不变 |

---

## 7. 客户端接入

> **交付状态**：服务端、数据库、浏览器端（含登录页）、Electron 双模式客户端均已交付，以下接入方式**全部当前可用**。

### 7.1 API 直连（当前可用）

服务端提供完整 REST API（附录 B），任何 HTTP 客户端均可对接。鉴权方式：

```http
POST /api/auth/login
Content-Type: application/json

{"username":"admin","password":"<密码>"}
→ {"code":0,"message":"ok","data":{"token":"<JWT>","user":{...}}}

后续请求携带:  Authorization: Bearer <token>
```

权限模型：`admin`（全部+用户管理）/ `editor`（数据读写）/ `viewer`（只读）。

### 7.2 浏览器访问（当前可用）

1. 客户端浏览器打开：
   - 直连：`http://<服务器IP>:3456`
   - 生产部署包（第 6.4 节）：`http://<服务器IP>`（80）或 `https://<服务器IP>`（443，自签证书首次访问点"继续浏览"）；
2. 首次访问进入统一登录页（`login.html`），可选择"单机版"（免密，数据存本地浏览器 IndexedDB）或"C/S 版"（输入账号密码，数据存服务端）；
3. 登录后 admin 角色侧栏可见"用户管理"菜单项，可新建/重置密码/删除普通用户；
4. 任何已登录状态下，侧栏底部"切换运行模式"按钮可返回模式选择页（`login.html?switch=1`，跳过自动免密/自动跳转），无需重开浏览器即可在单机版 / C/S 版之间切换；
5. 无需安装任何软件；Edge/Chrome 均可。

### 7.3 Electron 客户端（双模式，当前可用）

客户端 EXE 支持**两种配置方式**区分运行模式（应用内设置为推荐方式，无需手工建文件）：

| 模式 | 触发条件（按优先级） | 行为 |
|---|---|---|
| C/S 客户端模式 | ① 应用内"连接服务器设置"选择了连接模式；或 ② EXE 同目录存在 `server.config.json` 且 `serverUrl` 有效（兼容旧方式） | 窗口直连远程服务端，本地不启动服务、不落任何数据 |
| 单机模式（默认） | 无任何连接配置，或应用内设置选择了单机 | 与旧单机便携版完全一致，数据在本机 |

**方式一（推荐）：应用内设置**

1. 启动客户端 → 按 **Alt 键**显示菜单栏 → **设置 → 连接服务器设置…**（快捷键 Ctrl+Alt+S）；
2. 选择"连接服务器"，填入地址（如 `http://<服务器IP>:3456`，生产部署包场景为 `https://<服务器IP>`）→ 点击**测试连接**（探测 `/api/ping`，3.5 秒超时，兼容自签证书）；
3. 点击**保存并重启**，重启后即为客户端模式；随时可在同一界面切回单机模式。
4. 设置保存在系统用户数据目录 `connection.json`（无需写 EXE 目录权限），**优先级高于** exe 旁配置文件；"清除应用内设置"即恢复按配置文件/默认单机启动。

**已登录侧栏快速切换（2026-08-31 新增）**：
- 无论是内嵌单机模式（默认）还是 C/S 客户端模式，侧栏底部都有"切换运行模式"按钮；
- 内嵌单机点击后跳 `login.html?switch=1` → 强制停在模式选择卡片（`?switch=1` 绕开 embedded 自动免密）→ 选"C/S 版"会触发 `cs-settings://` 协议 → 自动打开连接设置窗口 → 保存后 `app.relaunch` 重启为 C/S 客户端模式；
- C/S 客户端点击后 → 清 JWT → 跳 `login.html?switch=1` → 选"单机版"会触发 `cs-standalone://` → 主进程 destroy 远程窗口 → `startStandaloneMode` 切原生内嵌单机；
- 完整切换路径矩阵（4 种运行环境）见变更摘要 2.7 节。

**服务端信息与数据手动同步（2026-09-01 新增）**：

连接服务器设置窗口（Ctrl+Alt+S）新增两个功能区域：

1. **服务端信息面板** — 填入服务器地址后点击"获取信息"（有已保存地址时自动拉取），显示服务名称 / 版本 / 服务器时间 / 数据库路径 / C/S 架构标识。数据来自免鉴权 `GET /api/info`，无需登录即可查看服务端概况。
2. **数据同步** — 在同步区域填入**服务端账号密码**（如 `admin`），可执行两个方向的手动同步：

   | 按钮 | 方向 | 行为 | 确认 |
   |---|---|---|---|
   | 服务器 → 本地（拉取） | 服务端覆盖本地 | 登录后逐键 `GET /api/load`，写入本地 `data/` 目录（`.json` + `.js` 双文件） | 二次确认 |
   | 本地 → 服务器（推送） | 本地覆盖服务端 | 登录后逐键读本地文件 `POST /api/save`，服务端**全量删除后重新插入** | ⚠ 二次确认（标注不可撤销） |

   - 同步范围（7 个数据键）：`assetManagementData`（资产全量）+ `custom_options_owner/type/department` 及各自 `_deleted` 后缀键；
   - **不同步** `userStateData` 等个人状态键，个人设置不受影响；
   - 同步完成后显示明细：每个键的同步条数、总资产数、失败键及原因；
   - 典型用途：旧单机数据并入服务端（替代第 4.6 节迁移工具的界面化途径）、多台单机之间经服务端中转数据；
   - 推送是破坏性操作（覆盖服务端全部资产），操作前建议先在服务端执行一次备份（第 4.4 节）。

> 打包验证（2026-09-01，便携 EXE v2.4.5 / 61.44 MB，最终构建 `dist_build_20260901122101`）：asar 含全部同步代码（3 个 IPC handler + 3 个 preload API + UI 元素）；真实服务端 `http://192.168.40.251:3456` 端到端实测：拉取 7 键本地双文件正确落盘 → 本地加资产后推送 7 键保存成功 → 再次拉取双向数据完全一致；服务端必填字段校验生效。同版本修复连接设置窗口按钮点击无反应（两处根因：Electron `sandbox:true` + asar 内 preload 静默失败 → `sandbox:false` + preload try-catch 兜底；误加 CSP `script-src 'self'` 静默拦截页面内联脚本 → 移除），CDP 实测窗口内 connApi 注入 / 模式卡片切换 / 测试连接"√ 连接成功" / 服务端信息面板渲染全部通过，详见变更摘要 2.8 节与修复记录 #14/#15。

**系统设置页服务器连接卡片（v3.4 新增，EXE 构建号 `dist_build_20260901142928`）**：

除了连接服务器设置窗口（Ctrl+Alt+S）这个入口，v3.4 起**系统设置页面**（侧栏 → "系统设置"）新增一张"服务器连接"卡片，C/S 客户端模式自动显示（检测到 `window.connApi` 即渲染）：

1. **服务器信息区** — 展示当前连接的服务器 URL、名称、版本、当前登录用户名与角色。URL 通过 `connApi.get()` 读取连接配置；名称/版本通过 `fetch(<serverUrl>/api/info)` 获取（免鉴权）；登录用户名通过 `ApiClient.user` 获取。
2. **数据双向同步区** — 与连接服务器设置窗口的同步功能完全相同：服务器地址（自动预填当前配置）+ 账号密码输入 + "拉取到本地"/"推送到服务器"按钮 + 结果区（绿/红/黄三色状态 + 每键同步明细）。**两个入口（系统设置页卡片 / 连接服务器设置窗口）功能等价，任选其一**。

**用户自助修改密码（v3.4 新增）**：

所有 C/S 模式已登录用户（admin / editor / viewer）均可自助修改自己的登录密码：顶栏用户区 → 点击"修改密码"按钮 → 弹窗输入当前密码 + 新密码（≥6 位）+ 确认新密码 → 前端校验通过后调 `POST /api/auth/change-password`（服务端 bcrypt 校验旧密码，通过后更新 hash）。admin 仍可在"用户管理"页面重置任意用户密码 / 修改角色 / 删除账号。

**mainWindow preload 注入（v3.4 架构改动说明）**：

| 窗口 | webPreferences（旧 → 新） | 说明 |
|---|---|---|
| 连接服务器设置窗口（connection.html） | `sandbox:false` + `preload: connection-preload.js`（未变） | 原先就有，connApi 暴露 get/test/save/apply/clear/serverInfo/syncPull/syncPush |
| C/S 客户端模式 mainWindow（L1416） | `sandbox:true` + **无 preload** → `sandbox:false` + `preload: connection-preload.js` | 旧版 mainWindow 没有任何 preload，渲染进程没有 connApi → 设置页无法显示服务器信息和同步按钮。v3.4 注入同一个 preload |
| 单机内嵌模式 mainWindow（L1581） | `sandbox:true` + **无 preload** → `sandbox:false` + `preload: connection-preload.js` | 同上，保持对称 |

> **技术细节**：Electron ≥23 `sandbox:true` 下 preload 无法 `require('electron')` 获取 `contextBridge`/`ipcRenderer`（sandbox 隔离 Node API）。connection-preload.js 内部用 `require('electron')`，所以**两个 mainWindow 必须用 `sandbox:false` + `preload: path.join(APP_DIR, 'connection-preload.js')`** 组合才能正确注入 connApi。这与 connectionWindow 的 webPreferences 配置完全一致。`contextIsolation:true` + `nodeIntegration:false` 保持不变，connApi 通过 `contextBridge.exposeInMainWorld` 仅暴露最小 IPC 面。

> 打包验证（2026-09-01，便携 EXE v2.4.5 / 61.45 MB，构建 `dist_build_20260901142928`）：asar 内含 connection-preload.js、新版 main.js（两处 preload + sandbox 配置）、新版 index.html（服务器连接卡片 + 修改密码按钮/弹窗）、新版 js/users.js（服务器卡片初始化 + 同步逻辑 + 修改密码弹窗）。真实服务端 `http://192.168.40.251:3456` 实测：系统设置页自动显示服务器地址/名称/版本/admin 用户 → 连接服务器设置窗口同步可用（两个入口均显示正确服务器信息）→ 修改密码弹窗从顶栏按钮正常打开，服务端 `POST /api/auth/change-password` 返回 200。

**方式二：配置文件（管理员批量预配置，兼容保留）**

在客户端 EXE 同目录放置 `server.config.json`：

   ```json
   { "serverUrl": "http://<服务器IP>:3456" }
   ```

启动即进客户端模式；删除该文件（且无应用内设置时）恢复单机模式。

**失败兜底**：客户端模式连接失败时，错误页提供三个按钮——**重新连接 / 修改连接设置 / 改用单机模式**（第三项仅本次启动生效，不改动已保存设置）；配置文件格式无效时启动也会弹窗三选，不再静默回落单机。

> **客户端 404 预检增强（2026-09-01 新增，EXE 构建号 `dist_build_20260901130854`）**：
>
> 旧版客户端 `did-fail-load` 只捕获网络层错误（DNS 失败、连接拒绝），HTTP 404/500 不算"加载失败"——远程 API 正常但前端静态文件缺失时，`loadURL('http://.../login.html')` 会收到服务端返回的 404 HTML 页面，主窗口裸显示"404 - 文件不存在"，用户无从判断是服务端漏部署前端文件。
>
> **新版双重防护**：
>
> 1. **预检**（`probeClientServer` 函数）：`loadURL` 之前先发两个轻量 HTTP GET——`/api/info`（探测 API 活不活）+ `/login.html`（探测前端页面存不存在）。API 活但静态 404 → 直接渲染**友好错误页**，带黄色提示框明确告诉你"源码部署时只上传了 server/ 目录，前端文件（index.html/login.html/js/libs/styles.css）缺失 → 补传到项目根目录即可"。
> 2. **兜底拦截**（`webRequest.onHeadersReceived`）：`loadURL` 后如果主框架收到 HTTP 4xx/5xx，强制 cancel 导航并渲染友好错误页。
>
> 错误页三个按钮行为不变（重新连接 / 修改设置 / 改用单机），但用户现在能看到**明确的根因提示**而非裸 404。预检与拦截全部在主进程实现（Node.js http 模块 + Electron webRequest API），不依赖远程页面的任何脚本执行。

> 打包验证（2026-09-03，便携 EXE v2.4.5 / 61.4 MB，`dist\固定资产管理系统-便携版-2.4.5.exe`）：修复"系统设置改名后登录页仍显示旧名"——根因为全局鉴权中间件未放行 `GET /api/load?key=systemSettings`，未登录的登录页 fetch 被 401 拒绝。修复后 Electron 清缓存启动，登录页 logo 与窗口标题均显示"固定资产管理系统PRO"；安全边界实测：公开键（systemSettings / custom_options_*）无 token 返回 200，业务键（assetManagementData）无 token 仍 401；浏览器端到端 6 步（改名→退出两次→登录页输入→重登持久化）通过。

> 打包验证（2026-09-01，便携 EXE v2.4.5 / 61.44 MB，最终构建 `dist_build_20260901130854`）：asar 含全部新代码（`probeClientServer`、`webRequest.onHeadersReceived`、增强的 `clientErrorPageHtml` 带 hint 参数）；在远程服务器 `http://192.168.40.251:3456`（API 正常 / 静态已补传 HTTP 200）上探测预检逻辑：API 200 + 静态 200 → `ok=true` 正常 loadURL；静态缺失（404）场景预检能准确区分"API 活 / 静态死"并给出精准修复建议。

> 打包验证（2026-08-31，便携 EXE v2.4.5 / 61.44 MB）：asar 含 `connection.html`/`connection-preload.js`；Ctrl+Alt+S 拉起设置窗口（CDP 注入按键不触发菜单加速器，实测须用 `SetForegroundWindow + SendKeys` 发送 OS 级按键）；`get`/`test`/`save`/`apply`/`clear` 全链路通过——`save` 写入 `%APPDATA%\asset-management-system\connection.json`，`apply` 触发 `app.relaunch()` 重启后仍直连服务端（应用内设置优先级高于 exe 旁配置文件）；`clear` + 重启回单机模式（内嵌服务随机端口，数据目录 `%APPDATA%\asset-management-system\data\` 正常落盘）。

> 旧单机便携版可继续独立使用，两者数据互不影响（单机版数据如需并入服务端，推荐走本节"数据同步 → 本地 → 服务器（推送）"界面化操作；大批量场景可用第 4.6 节迁移工具）。

### 7.4 兼容层（过渡期，当前可用）

新服务端实现了旧版薄 API 兼容层（`/api/load`、`/api/save`、`/api/list`、`/api/ping`、`/api/delete`、`/api/info`、`/api/data-version`），契约与旧版完全一致：

- 读接口鉴权策略（2026-09-03 起精确化）：`GET /api/ping`、`GET /api/info`、`GET /api/list` 全量免鉴权；`GET /api/load` **仅公开键免鉴权**——`key=systemSettings`（登录页动态系统名称）与 `key=custom_options_*`（下拉选项），其余键（如 `assetManagementData` 资产数据、`asset_userStateData_*` 用户状态）仍必须携带 JWT，否则 401；
- `POST/DELETE` 写接口需要 JWT（`Authorization: Bearer` 或 `X-Server-Token` 头均可）；写接口的键名还受 compat 层白名单约束（`KV_KEYS` 精确名单 + `asset_userStateData_` 前缀匹配）；
- 旧前端切换到新服务端只需：登录获取 token → 注入 `window.__SERVER_TOKEN__`。

---

## 8. 安全加固清单（上线必做）

> 本章默认 Windows 视角；Linux 部署的安全要点见 11.12（禁 root、目录 750、禁放 NFS 等），CentOS 7 的加固要求见 12.1。

| # | 措施 | 操作 |
|---|---|---|
| 1 | **修改默认密码** | admin 首次登录后可通过两种方式修改密码：① 顶栏"修改密码"按钮自助改密（需验证旧密码）；② "用户管理"页面 admin 重置（无需旧密码）。服务端接口 `POST /api/auth/change-password`（自助）与 `PATCH /api/users/:id`（admin 重置） |
| 2 | 保护 JWT 密钥 | `data\secret.key` 不要外泄；泄漏或怀疑泄露时删除该文件并重启服务端（全部用户需重新登录），或用环境变量 `ASSET_JWT_SECRET` 指定自己的密钥 |
| 3 | 控制密钥有效期 | 默认 token 12 小时过期；可用 `ASSET_JWT_EXPIRES` 调整（如 `30m`、`7d`） |
| 4 | 防火墙限源 | 见 6.2，仅放行办公网段 |
| 5 | HTTPS | 已随部署包交付（第 6.4 节）：nginx 443 + 自签证书；把 `cert\server.crt` 导入客户端"受信任的根证书颁发机构"可消除浏览器告警 |
| 6 | 最小权限运行 | NSSM 可指定普通域账户运行（`nssm set AssetServer ObjectName .\assetuser <密码>`），数据目录仅授权该账户 |
| 7 | 数据目录 ACL | 数据目录禁止普通用户写权限，防误删 `asset.db` |
| 8 | 按需创建账号 | 日常使用创建 `editor`/`viewer` 账号，admin 仅管理员持有 |

---

## 9. 日常运维

| 操作 | 命令/位置 |
|---|---|
| 查看服务状态 | `D:\tools\nssm.exe status AssetServer`（部署包在 deploy 目录 `.\nssm.exe status`） |
| 重启服务端 | `D:\tools\nssm.exe restart AssetServer`（部署包 `.\nssm.exe restart`） |
| 服务日志 | 部署包方案：`deploy\logs\asset-server(.err).log`、`nginx(.err).log`（10MB 自动轮转）；源码手动 NSSM 方案需安装时自行指定 `AppStdout/AppStderr` |
| 操作审计 | 数据库 `audit_log` 表记录登录/增删改/导入（含操作人、时间、对象） |
| 升级服务端 | EXE：停 AssetServer → 备份 `data\` → 覆盖 `asset-server.exe` → 启动；源码：停服 → 备份 `data\` → 覆盖 `src\`/`package.json` → `npm install` → 启动 |
| 回滚版本 | 停服 → 还原程序目录与 `asset.db` 备份 → 启动 |
| 数据库备份 | 第 4.4 节，建议每日自动 |
| 服务器换机 | EXE：拷贝部署包（含 `data\`、`cert\`）→ 重新 `install-service.bat`；源码：新机装 Node → 拷贝整个 `server\`（含 `data\`）→ NSSM 启动 |
| Linux / CentOS 服务器 | systemctl 管理见 11.5；CentOS 7 特殊事项见第 12 章 |

---

## 10. 故障排查 FAQ

> 平台说明：Q1、Q2、Q5、Q7、Q8 平台通用；Q3、Q4、Q6、Q9 默认 Windows 环境。Linux 部署排障先看 11.12 与 11.13 验证清单；CentOS 7 见 12.6。

**Q1：启动报 `EADDRINUSE` 端口被占用**
```powershell
netstat -ano | findstr :3456     # 找到占用进程 PID
tasklist | findstr <PID>         # 确认进程
```
换端口（`ASSET_PORT`）或停掉占用进程。

**Q2：`npm install` 时 better-sqlite3 报错/卡住**
多为网络问题导致预编译包下载失败。用离线方式：联网机器 `npm install --omit=dev` 后整体拷贝（见 3.3）。

**Q3：客户端机器无法访问**
依次检查：① 服务端进程在运行（源码手动方案 `D:\tools\nssm.exe status` / 部署包 `.\nssm.exe status`）；② 服务器防火墙规则（6.1）；③ 服务器 IP 是否输对（`ipconfig` 确认）；④ 客户端 `ping 服务器IP` 通不通；⑤ VPN/多网卡环境确认走的是正确网段。

**Q4：忘记 admin 密码**

程序已内置重置脚本，在服务器上执行（需至少 6 位新密码）：

```powershell
cd D:\asset-server
node reset-admin.js 新密码
```

脚本直接修改数据库，无需旧密码、无需停止服务端；重置后请立即登录并再次修改为自己的密码。若数据库在自定义位置，先设置 `ASSET_DB_PATH` 环境变量（`reset-admin.js` 需 Node 环境；EXE 部署机器无 Node 时另备源码目录跑脚本，见 3.0 尾注）。

**Q5：提示"数据已被其他用户修改"(409/40901)**
乐观锁生效，属正常现象：他人已先保存该资产，刷新列表后重新编辑保存即可。

**Q6：控制台中文显示乱码**
仅影响显示不影响功能。PowerShell 执行 `chcp 65001` 切换 UTF-8 后重启服务端。

**Q7：数据库文件能否多台服务器共享（NAS）？**
不能。SQLite 是嵌入式单机数据库，`asset.db` 必须放在服务器本地磁盘。多机共享需求属于未来 MySQL 迁移场景（4.8）。

**Q8：误删了 asset.db-wal / asset.db-shm**
立即停服，用最近一次备份恢复 `asset.db`（4.5），否则可能丢失最近未收敛的写入。

**Q9：EXE / 部署包方式启动异常如何排查？**

1. 服务状态：`sc.exe query AssetServer`（nginx 为 `AssetNginx`）；
2. 错误日志：`deploy\logs\asset-server.err.log`、`nginx.err.log`（故障排查先看这里）；
3. nginx 报 `cannot load certificate` → 部署路径含中文等**非 ASCII 字符**，把整个 deploy 包移到纯英文路径（见 6.4 关键约束）；
4. 端口被占（80/443/3456）：`netstat -ano | findstr :<端口>` 定位进程后换端口或停止占用方。

**Q10：Electron C/S 客户端模式主窗口显示"404 - 文件不存在"**

这是**源码部署方式 B 漏传前端静态文件**的典型症状。排查步骤：

```bash
# 在服务端执行（Linux）
curl -s http://127.0.0.1:3456/api/info   # API 是否正常? 应该返回 {"success":true,...}
curl -o /dev/null -w '%{http_code}' http://127.0.0.1:3456/login.html  # 前端是否存在? 应该返回 200
ls -la /opt/asset-server/ | grep -E 'index|login|styles|js|libs'     # 前端文件是否在项目根目录?
```

| API `/api/info` | 前端 `/login.html` | 诊断 |
|---|---|---|
| 200 ✅ | 404 ❌ | **前端文件缺失**（最常见）—— 只上传了 `server/` 源码目录，没上传项目根的 index.html/login.html/js/libs/styles.css 等。解决：补传（见 11.4 步骤 ② 警告）或改用方式 A 打包产物（pkg 已内嵌前端） |
| 404 ❌ | 404 ❌ | 服务端进程没启动或端口不对（`systemctl status asset-server` / `ss -tlnp | grep 3456`） |
| 200 ✅ | 200 ✅ | 服务端正常——问题在客户端 EXE，更新到 `dist_build_20260901130854` 版本（含预检+拦截双重防护）再试 |

客户端新版（`dist_build_20260901130854`）已能**自动预检**并在启动时检测到"API 活但静态 404"，显示友好错误页带修复建议，不再裸显示 404 HTML。

---

## 11. Linux 服务器部署

服务端为标准 Node.js 应用，天然支持 Linux。两种方式按需选择：

| 方式 | 适用 | 前置要求 |
| --- | --- | --- |
| A：打包产物 `asset-server-linux` | 追求免 Node.js 环境 | Linux x64，glibc ≥ 2.28（Ubuntu 20.04+ / Debian 11+ / RHEL 9+） |
| B：源码 + Node.js | 便于二次开发与使用工具脚本 | Node.js ≥ 18（推荐 20/22 LTS） |

> 老系统（如 CentOS 7，glibc 2.17）两种方式均不支持——延伸部署方案（unofficial-builds Node / Docker / 换机迁移）已独立为**第 12 章**。内网无外网环境推荐方式 A（免 Node.js 安装与 npm 拉包）。

### 11.1 系统准备（两种方式通用）

```bash
# ① 时区（影响备份时间戳与日志时间）
sudo timedatectl set-timezone Asia/Shanghai

# ② 系统更新（可选）
sudo apt update && sudo apt -y upgrade          # Ubuntu/Debian
# sudo dnf -y update                            # RHEL/Rocky/Alma

# ③ 创建专用运行用户（禁止用 root 跑服务）
sudo useradd -r -s /usr/sbin/nologin asset      # RHEL 系 shell 路径为 /sbin/nologin

# ④ 目录规划
sudo mkdir -p /opt/asset-server/data            # 程序目录(数据子目录)
sudo chown -R asset:asset /opt/asset-server
sudo chmod 750 /opt/asset-server                # asset.db 为明文数据, 限制其他用户访问
```

目录规划约定：

| 路径 | 用途 | 属主/权限 |
| --- | --- | --- |
| `/opt/asset-server` | **程序根目录** —— 打包产物方式：放 `asset-server-linux` 可执行文件；**源码方式**：放前端静态文件（index.html、login.html、styles.css、js/、libs/ 等，见 11.4 步骤 ② 警告） | asset:asset，750 |
| `/opt/asset-server/data` | 数据目录（asset.db、secret.key、备份） | asset:asset，750 |
| `/opt/asset-server/server` | **仅方式 B 源码部署**：Node.js API 后端源码（src/、node_modules/） | asset:asset，750 |
| `/etc/systemd/system/asset-server.service` | 服务单元 | root 管理 |
| 日志 | 归 journald（`journalctl -u asset-server`），无需单独目录 | — |

> **关键**：服务端静态文件基准 `STATIC_ROOT = path.join(config.SERVER_ROOT, '..')` —— 源码部署时 `SERVER_ROOT` 解析为 `/opt/asset-server/server`，上一级即 `/opt/asset-server`，**前端静态文件必须放在这个目录下**（与 `server/` 平级）。如果只上传了 `server/` 源码目录而漏了前端文件，`/login.html`、`/index.html`、`/js/*`、`/libs/*` 全部返回 HTTP 404，Electron C/S 客户端模式主窗口会显示"404 - 文件不存在"页面。**方式 A 打包产物无此问题**——pkg 打包时已将前端静态文件内嵌进 `asset-server-linux` 可执行文件。

> 若希望数据与程序分离（便于备份/扩容），将数据目录指向 `/var/lib/asset-server` 并在单元文件中设置 `Environment=ASSET_DATA_DIR=/var/lib/asset-server`，同时 `chown asset:asset` 该目录。

### 11.2 Node.js 安装（仅方式 B 需要）

```bash
# 已有 Node? 检查版本(需 ≥ 18)
node -v

# Ubuntu/Debian — NodeSource 安装 Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# RHEL/Rocky/Alma — 二选一
sudo dnf module install -y nodejs:22            # 系统模块源
# 或 NodeSource:
# curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
# sudo dnf install -y nodejs
```

> - 内网离线环境无法执行上述步骤时，请改用**方式 A**（产物已内置运行时，免 Node）。
> - 若 `npm install` 阶段 better-sqlite3 触发源码编译（一般有预编译二进制，不会），需先装工具链：Ubuntu `sudo apt install -y build-essential python3`；RHEL `sudo dnf groupinstall -y "Development Tools" && sudo dnf install -y python3`。

### 11.3 方式 A：打包产物部署（免 Node.js）

```bash
# ① 开发机交叉打包（Windows 或 Linux 上均可执行，在 server/ 目录）
npm run build:linux        # 产物: server/dist/asset-server-linux (约 88MB, 内含静态页与原生模块)

# ② 上传（Windows PowerShell 示例；或用 SFTP 图形工具）
scp server\dist\asset-server-linux user@192.168.1.100:/tmp/

# ③ 放置程序
sudo mv /tmp/asset-server-linux /opt/asset-server/
sudo chmod +x /opt/asset-server/asset-server-linux
sudo chown asset:asset /opt/asset-server/asset-server-linux

# ④ 安装 systemd 服务（单元文件在部署包 deploy/asset-server.service）
sudo cp asset-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now asset-server

# ⑤ 自检
systemctl status asset-server          # active (running)
curl http://127.0.0.1:3456/api/ping
```

### 11.4 方式 B：源码部署

```bash
# ① 按 11.2 安装 Node.js

# ② 上传源码 + ★★★ 必须同时上传项目根目录的前端静态文件 ★★★
#    不要拷贝 node_modules —— Windows 下装的原生模块与 Linux 不兼容, 必须服务器重新安装
#    Windows PowerShell 示例 (先删掉 server\node_modules):
#       scp -r server user@192.168.1.100:/tmp/        ← 只传 API 后端
#       scp index.html login.html styles.css asset_label_print.html final_chart_fix.js build-info.json user@192.168.1.100:/tmp/
#       scp -r js libs user@192.168.1.100:/tmp/
#    或用 SFTP 图形工具 (WinSCP / FileZilla) 批量上传
sudo mv /tmp/server /opt/asset-server/server
# ★ 把前端静态文件放到 server/ 的上一级目录 (即 /opt/asset-server/), 与 server/ 平级
sudo mv /tmp/index.html /tmp/login.html /tmp/styles.css /tmp/asset_label_print.html \
       /tmp/final_chart_fix.js /tmp/build-info.json /opt/asset-server/
sudo mv /tmp/js /opt/asset-server/
sudo mv /tmp/libs /opt/asset-server/

# ③ 安装依赖 + 权限
cd /opt/asset-server/server
sudo npm install --omit=dev                       # 以 root 装依赖(装完统一 chown)
sudo chown -R asset:asset /opt/asset-server

# ④ systemd 单元按源码方式调整 asset-server.service 中两行:
#    WorkingDirectory=/opt/asset-server/server
#    ExecStart=/usr/bin/node /opt/asset-server/server/src/index.js
sudo cp asset-server.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now asset-server

# ⑤ 自检 + 工具脚本（备份/重置密码/迁移在此方式下直接可用）
curl http://127.0.0.1:3456/api/ping                    # API 探活 → 200
curl -o /dev/null -w '%{http_code}' http://127.0.0.1:3456/login.html   # ★ 前端文件 → 200
sudo -u asset node backup.js
```

> **⚠️ 2026-09-01 实测踩坑：源码部署前端文件缺失**
>
> 服务端静态文件基准 `STATIC_ROOT = path.join(config.SERVER_ROOT, '..')`，源码运行时 `SERVER_ROOT` 解析为 `/opt/asset-server/server`，上一级即 `/opt/asset-server`——**前端静态文件必须放在这个目录下，与 `server/` 平级**。
>
> **缺失会导致**：`/login.html`、`/index.html`、`/js/*`、`/libs/*` 全部返回 HTTP 404（服务端 404 HTML，不是网络失败）。Electron C/S 客户端模式主窗口会显示"404 - 文件不存在"页面。Electron `did-fail-load` 只捕获网络层错误（DNS 失败、连接拒绝），HTTP 404 不算"加载失败"，所以旧版客户端不会触发错误页兜底。
>
> **完整前端静态文件清单**（项目根目录）：
>
> | 文件/目录 | 大小 | 用途 |
> |---|---|---|
> | `index.html` | ~82 KB | 主应用页面 |
> | `login.html` | ~16 KB | 登录页（Electron 客户端模式默认加载） |
> | `styles.css` | ~55 KB | 样式表 |
> | `asset_label_print.html` | ~33 KB | 资产标签打印页 |
> | `final_chart_fix.js` | ~4 KB | 图表修复脚本 |
> | `build-info.json` | 0.1 KB | 构建时间戳信息 |
> | `js/` | 18 files | 前端业务脚本（api.js、assets.js、dashboard.js 等） |
> | `libs/` | 7 files | 第三方库（chart.min.js、xlsx、pdf、qrcode、font-awesome 等） |
>
> **验证方法**：部署后在服务器本机执行 `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:3456/login.html`，预期 **200**；如果返回 **404**，说明前端文件没传对位置（应该在 `/opt/asset-server/`，不是 `/opt/asset-server/server/`）。**方式 A 打包产物无此问题**——pkg 的 `package.json` assets 字段已声明把前端文件嵌入 `asset-server-linux` 可执行文件。
>
> **修复已验证（2026-09-01，IP 192.168.40.251）**：首次部署时只传了 `server/` 源码目录，导致 API 正常（`/api/info` 200）但静态全挂（`/login.html` 404）。用 WinSCP/pscp 补传上述 6 个根目录文件 + `js/` + `libs/` 到 `/opt/asset-server/` 并 `chown asset:asset` 后，无需重启 Node 进程（serveStatic 每次请求实时读磁盘），立即全部 **HTTP 200**：login.html 14,588 B / index.html 77,752 B / styles.css 53,438 B / js/init.js 18,925 B / libs/chart.min.js 208,353 B。

### 11.5 systemd 服务管理

常用命令：

| 操作 | 命令 |
| --- | --- |
| 状态 / 启停 | `systemctl status\|start\|stop\|restart asset-server` |
| 开机自启 | `systemctl enable asset-server`（取消 `disable`） |
| 改单元后生效 | `sudo systemctl daemon-reload && sudo systemctl restart asset-server` |
| 实时日志 | `journalctl -u asset-server -f` |
| 最近 200 行 | `journalctl -u asset-server -n 200 --no-pager` |
| 错误过滤 | `journalctl -u asset-server -p err --since today` |

日志持久化（可选，默认重启后旧日志丢失）：

```bash
sudo mkdir -p /var/log/journal && sudo systemd-tmpfiles --create --prefix /var/log/journal
# /etc/systemd/journald.conf 中设置 Storage=persistent、SystemMaxUse=200M 后:
sudo systemctl restart systemd-journald
```

### 11.6 环境变量（systemd 场景）

写入 `asset-server.service` 的 `Environment=` 行（改后 `daemon-reload && restart`），变量含义见附录 A。常用：

| 变量 | 缺省 | 说明 |
| --- | --- | --- |
| `ASSET_HOST` | 0.0.0.0 | 建议按单元文件设为 `127.0.0.1`（配合 nginx，安全模型与 Windows 版一致） |
| `ASSET_PORT` | 3456 | 服务端口 |
| `ASSET_DATA_DIR` | `<工作目录>/data` | 数据目录，建议独立如 `/var/lib/asset-server` |
| `ASSET_JWT_EXPIRES` | 12h | token 有效期 |

### 11.7 nginx 反向代理 + HTTPS

Linux 上 nginx 配置与 Windows 版逻辑相同，但无 ASCII 路径限制，且可用 Let's Encrypt 正式证书：

```bash
sudo apt install -y nginx          # 或 sudo dnf install nginx

# HTTP(80) 站点配置
sudo tee /etc/nginx/conf.d/asset.conf > /dev/null <<'EOF'
server {
    listen 80;
    server_name _;
    client_max_body_size 64m;
    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
EOF
sudo nginx -t && sudo systemctl reload nginx
```

**HTTPS 方案一：certbot 正式证书（有公网域名时推荐，自动续期）**

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d asset.example.com          # 自动改写 conf 并配置 443 + 续期定时器
# 注: 签发验证需 80 端口可被公网访问; 纯内网环境用方案二
```

**HTTPS 方案二：自签证书（纯内网环境）**

```bash
sudo mkdir -p /etc/nginx/cert
# SAN 中把 192.168.1.100 换成本机内网 IP(可多写几个 IP, 用逗号分隔)
sudo openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
  -keyout /etc/nginx/cert/server.key -out /etc/nginx/cert/server.crt \
  -subj "/CN=asset-server" \
  -addext "subjectAltName=DNS:localhost,DNS:$(hostname),IP:127.0.0.1,IP:192.168.1.100"
sudo chmod 600 /etc/nginx/cert/server.key

# 追加 443 server 块(location 内代理配置与 80 块相同)
sudo tee /etc/nginx/conf.d/asset-ssl.conf > /dev/null <<'EOF'
server {
    listen 443 ssl;
    server_name _;
    ssl_certificate     /etc/nginx/cert/server.crt;
    ssl_certificate_key /etc/nginx/cert/server.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    client_max_body_size 64m;
    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
EOF
sudo nginx -t && sudo systemctl reload nginx
# 客户端消除"不信任"告警: 将 server.crt 下发并导入受信任的根证书颁发机构
```

**SELinux 注意（仅 RHEL/Rocky/Alma enforcing 模式）**：nginx 反代后端出现 502 而后端直连正常时，放行网络连接布尔值：

```bash
sudo setsebool -P httpd_can_network_connect 1
```

### 11.8 防火墙

```bash
# Ubuntu/Debian (ufw) —— ★ enable 前务必先放行 SSH, 否则会把自己锁在机器外
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp        # 服务端 3456 仅回环, 无需放行
sudo ufw enable && sudo ufw status

# RHEL/Rocky (firewalld)
sudo firewall-cmd --permanent --add-service={http,https}
sudo firewall-cmd --permanent --add-service=ssh && sudo firewall-cmd --reload
```

### 11.9 定时备份（cron）

```bash
# 方式 B(有 Node): 每日 02:00, 保留逻辑见 backup.js 内置轮换
sudo touch /var/log/asset-backup.log && sudo chown asset /var/log/asset-backup.log
sudo crontab -e -u asset
0 2 * * * cd /opt/asset-server/server && node backup.js >> /var/log/asset-backup.log 2>&1
```

```bash
# 方式 A(免 Node): 用 sqlite3 自带的在线备份(不锁库, 可在服务运行中执行)
sudo apt install -y sqlite3                       # 或 sudo dnf install sqlite
sudo mkdir -p /var/backups/asset-server && sudo chown asset /var/backups/asset-server
sudo crontab -e -u asset
0 2 * * * sqlite3 /opt/asset-server/data/asset.db ".backup '/var/backups/asset-server/asset-$(date +\%F).db'" && find /var/backups/asset-server -name 'asset-*.db' -mtime +14 -delete
```

> cron 里的 `%` 必须转义为 `\%`（cron 特殊字符）。备份建议定期拷贝到异机/对象存储；恢复时停服 → 用备份文件替换 `asset.db` → 起服（见 4.5）。

### 11.10 Windows ⇄ Linux 迁移

SQLite 数据库文件跨平台通用，迁移只需拷贝数据目录：

```bash
# ① Windows 服务器: 停服后取数据文件
#    asset.db + secret.key（JWT 密钥, 拷走可保已签发 token 不失效）; asset.db-wal/-shm 勿拷
#    PowerShell 示例: scp deploy\data\asset.db deploy\data\secret.key user@192.168.1.100:/tmp/

# ② Linux 服务器: 停服 → 放入数据目录 → 起服
sudo systemctl stop asset-server
sudo cp /tmp/asset.db /tmp/secret.key /opt/asset-server/data/
sudo chown asset:asset /opt/asset-server/data/*
sudo systemctl start asset-server
curl http://127.0.0.1:3456/api/ping
```

反向迁移（Linux → Windows）同理：停服 → 拷贝 `asset.db` + `secret.key` 到数据目录 → 启动。

### 11.11 升级与回滚

```bash
# 升级（数据目录不动即保留全部数据）
sudo systemctl stop asset-server
sudo cp /opt/asset-server/asset-server-linux /tmp/asset-server-linux.bak-$(date +%F)   # 留回滚底
sudo mv 新版/asset-server-linux /opt/asset-server/ && sudo chmod +x /opt/asset-server/asset-server-linux
sudo chown asset:asset /opt/asset-server/asset-server-linux
sudo systemctl start asset-server && sudo bash verify-linux.sh

# 回滚：用 .bak 覆盖回 asset-server-linux 后 restart
```

源码方式升级：备份 `data/` 与 `.env 类配置` → 覆盖 `server/` 源码（不含 node_modules）→ `npm install --omit=dev` → restart。

### 11.12 注意事项汇总

| # | 事项 | 说明 |
| --- | --- | --- |
| 1 | glibc ≥ 2.28 | 打包产物硬性要求（Ubuntu 20.04+/Debian 11+/RHEL 9+）；CentOS 7 方案见第 12 章 |
| 2 | 勿从 Windows 拷 node_modules | better-sqlite3 原生模块按平台编译，必须在 Linux 服务器上重新 `npm install` |
| 3 | SELinux（RHEL 系） | nginx 反代 502 → `setsebool -P httpd_can_network_connect 1`（见 11.7） |
| 4 | ufw 先放 SSH | `ufw allow OpenSSH` 必须在 `ufw enable` 之前，否则远程连接会被切断 |
| 5 | SQLite 禁放网络文件系统 | asset.db 勿放 NFS/SMB 挂载目录——文件锁不可靠，存在数据损坏风险；放本地盘 |
| 6 | 禁用 root 运行服务 | 统一用专用用户 `asset`；单元文件已按此配置 |
| 7 | 数据目录权限 | asset.db 为明文存储，目录 750、不放共享可读路径；备份文件同样注意权限 |
| 8 | 时区 | `timedatectl set-timezone Asia/Shanghai`，否则备份时间戳/日志时间与预期差 8 小时 |
| 9 | certbot 前提 | 需域名解析到本机且 80 端口公网可达；纯内网用自签方案二 |
| 10 | 自签证书告警 | 客户端导入 `server.crt` 到受信任根证书即可消除浏览器告警 |
| 11 | 日志增长 | journald 建议限额 `SystemMaxUse=200M`（见 11.5），避免长期运行占满磁盘 |
| 12 | 内存/swap | ≥2GB 内存；1GB 小机建议加 2G swap（`fallocate` + `mkswap`）防编译/导入时 OOM |
| 13 | 升级窗口 | 升级仅需 stop→替换→start（秒级），数据目录始终不动；先备份再升级 |

### 11.13 验证清单

部署包自带一键验证脚本 `verify-linux.sh`（只读检查，不修改任何配置）：

```bash
sudo bash verify-linux.sh                       # 建议以 root/sudo 运行以读取服务日志
# 常用变量: SERVICE_NAME=服务名 PORT=端口 DATA_DIR=数据目录路径
#   例: DATA_DIR=/var/lib/asset-server bash verify-linux.sh
# 退出码 0=通过; 1=存在 FAIL 项
```

脚本覆盖以下检查（也可手工逐项执行）：

| 检查项 | 命令 | 预期 |
| --- | --- | --- |
| 服务状态 | `systemctl status asset-server` | active (running) |
| 服务端探活 | `curl http://127.0.0.1:3456/api/ping` | 返回含 `"pong"` |
| 前端页面 | `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:3456/login.html` | 200 |
| nginx 探活 | `curl http://127.0.0.1/api/ping` | 返回含 `"pong"` |
| HTTPS 探活 | `curl -k https://<域名或IP>/api/ping`（自签加 `-k`） | 返回含 `"pong"` |
| 数据库文件 | `ls -la /opt/asset-server/data/asset.db` | 存在且数据目录可写 |

---

## 12. CentOS 7 部署（特殊场景）

> 第 11 章两种标准方式在 CentOS 7 上均不可用（原因见 12.1）。本章内容自足可独立操作；nginx/HTTPS/备份/验证等通用细节复用第 11 章对应小节。

### 12.1 背景与方案选择

CentOS 7 的 glibc 为 **2.17**（`ldd --version` 可确认），因此两条标准路径均不可用：

| 不可用项 | 原因 |
| --- | --- |
| 交叉产物 `asset-server-linux` | 基于 node22 基座打包，要求 glibc ≥ 2.28 |
| 官方 Node 18/20/22 tarball | 官方二进制自 v18 起基于 RHEL 8 构建，同样要求 glibc ≥ 2.28 |

可行路径（按推荐度排序）：

| 路径 | 方式 | 一句话评价 |
| --- | --- | --- |
| 一（推荐） | 源码 + unofficial-builds glibc-217 版 Node 20 + 本章专用 systemd 单元 | Node.js 官方社区构建项目，改动最小 |
| 二 | Docker 容器跑官方 node:20 镜像 | 绕开宿主 glibc，但引入容器运维 |
| 三 | 换机部署（Rocky/Alma/Ubuntu 按第 11 章标准路径）+ 数据迁移 | 长期正解 |

> **必须知晓的风险**：CentOS 7 已于 2024-06-30 EOL，无任何安全补丁。本系统含账号与经营数据，作为生产服务器有实际安全暴露面——路径一/二仅作过渡，尽快按路径三迁移。过渡期务必：仅内网暴露、按 6.2（Windows）/ 11.8（Linux）限定来源网段、nginx 前置、登录后立即修改默认密码。
>
> 部署前确认系统状态：`cat /etc/os-release`、`uname -m`（需 x86_64）、`ldd --version | head -1`（预期 2.17）、`free -h && df -h /opt`（内存 ≥ 2G、磁盘 ≥ 1G）。

### 12.2 路径一：unofficial-builds Node 20 + 源码部署（推荐）

**步骤 1：修复 yum 源（EOL 后必做）**

CentOS 7 官方镜像源已下线，`yum install` 报 404 / mirrorlist 解析失败时，切换到归档源：

```bash
# 切到 CentOS 官方归档（或用阿里云镜像 mirrors.aliyun.com/centos-vault，国内更快）
sudo sed -i -e 's|^mirrorlist=|#mirrorlist=|' \
            -e 's|^#baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|' \
            /etc/yum.repos.d/CentOS-*.repo
sudo yum clean all && sudo yum makecache
```

**步骤 2：系统准备**

```bash
sudo timedatectl set-timezone Asia/Shanghai      # 时区(影响备份时间戳/日志)
sudo useradd -r -s /sbin/nologin asset           # ★ CentOS 7 nologin 路径是 /sbin/nologin
sudo mkdir -p /opt/asset-server/data
sudo chown -R asset:asset /opt/asset-server
sudo chmod 750 /opt/asset-server                 # asset.db 为明文数据, 限制访问
```

**步骤 3：安装 unofficial-builds Node 20**

```bash
# 下载页: https://unofficial-builds.nodejs.org/download/release/
# 认准文件名含 linux-x64-glibc-217 的 tarball, 选 v20.19.x 最新版(版本号以站点实际列表为准)
curl -fsSLO https://unofficial-builds.nodejs.org/download/release/v20.19.x/node-v20.19.x-linux-x64-glibc-217.tar.xz
sudo tar -xJf node-v20.19.x-linux-x64-glibc-217.tar.xz -C /usr/local --strip-components=1
node -v && npm -v        # 能输出版本即安装成功(默认路径 /usr/local/bin/node)
```

> - 下载较慢时可在 Windows 开发机下载后 `scp` 上传；服务器完全无外网时同样如此；
> - `tar -xJf` 需要 xz（CentOS 7 自带）；若无 curl 先 `yum install -y curl`；
> - 升级 Node = 重新解压新版 tarball 覆盖 `/usr/local`，应用无需改动。

**步骤 4：上传源码并安装依赖**

```bash
# Windows 开发机(PowerShell): 先删掉 server\node_modules(原生模块必须 Linux 侧重装)!
# scp -r server user@<IP>:/tmp/
sudo mv /tmp/server /opt/asset-server/server
cd /opt/asset-server/server
sudo npm install --omit=dev
sudo chown -R asset:asset /opt/asset-server
# 验证原生模块可用:
node -e "require('better-sqlite3');console.log('sqlite OK')"
```

better-sqlite3 安装的两种结果：

| 结果 | 处理 |
| --- | --- |
| 自动下载预编译二进制（多数情况） | 无需处理 |
| 触发源码编译失败 | CentOS 7 自带 GCC 4.8 不支持 C++14，装 devtoolset 后重试：`sudo yum install -y centos-release-scl-rh devtoolset-11-gcc devtoolset-11-gcc-c++ devtoolset-11-make`（SCL 源同在 vault）→ `scl enable devtoolset-11 bash` → 重跑 `npm install --omit=dev` |

> **内网服务器无法访问 npm registry 时**：在任一台联网的 **linux-x64** 机器上 `npm install --omit=dev`，然后把整个 `server/` 目录（含 node_modules）拷到 CentOS 7。此法可行是因为 better-sqlite3 预编译二进制按 linux-x64 分发，与安装机器的 glibc 版本基本无关；但**不要**从 Windows/macOS 拷 node_modules，也**不要**从"执行过源码编译"的新系统机器拷（编译产物可能链接新 glibc 符号）。

**步骤 5：安装 systemd 服务（CentOS 7 专用单元）**

单元文件全文（部署包自带 `deploy/asset-server-centos7.service`，无法复制文件时可直接按此手写）：

```ini
[Unit]
Description=Asset Management Server (Koa + SQLite) - CentOS 7
After=network.target

[Service]
Type=simple
User=asset
WorkingDirectory=/opt/asset-server/server
# unofficial-builds glibc-217 版 Node 的默认安装路径; 若装在别处请相应修改
ExecStart=/usr/local/bin/node /opt/asset-server/server/src/index.js
# 安全模型与 Windows 版一致: 服务端仅监听本机回环, 由 nginx 80/443 对外反代;
# 若无 nginx 直连局域网, 改为 0.0.0.0 并用 firewalld 放行 3456
Environment=ASSET_HOST=127.0.0.1
Environment=ASSET_PORT=3456
# 数据目录(缺省为工作目录下 data/); 独立数据目录示例(需先 chown asset:asset):
# Environment=ASSET_DATA_DIR=/var/lib/asset-server
Restart=always
RestartSec=3
# 以下两项在 systemd 219 (CentOS 7) 下受支持
NoNewPrivileges=true
PrivateTmp=true
# 内网低并发无需调整; 如有需要可放开:
# LimitNOFILE=16384

[Install]
WantedBy=multi-user.target
```

安装并启动：

```bash
# 单元文件: 部署包 deploy/asset-server-centos7.service (与通用版的差异见文件头注释)
sudo cp asset-server-centos7.service /etc/systemd/system/
# 按需检查/修改三处: ExecStart 的 node 路径(默认 /usr/local/bin/node)、
#                    WorkingDirectory(默认 /opt/asset-server/server)、
#                    Environment=ASSET_DATA_DIR(可选独立数据目录)
sudo systemctl daemon-reload
sudo systemctl enable --now asset-server
systemctl status asset-server                     # active (running)
curl http://127.0.0.1:3456/api/ping               # 返回含 "pong"
```

单元字段与 CentOS 7 systemd 219 的兼容性（已逐项核对，可放心使用）：

| 字段 | systemd 219 支持 | 用途 |
| --- | --- | --- |
| `Type=simple` / `Restart=always` / `RestartSec` | ✓ | 前台进程 + 崩溃 3 秒拉起 |
| `Environment=` | ✓ | 端口/数据目录等配置 |
| `User=` / `WorkingDirectory=` | ✓ | 以 asset 用户运行 |
| `NoNewPrivileges=` / `PrivateTmp=` | ✓ | 基础加固 |
| `LimitNOFILE=`（注释项） | ✓ | 需要时放开 |
| journalctl `-u/-f/-n/--since/-p err` | ✓ | 日志查看（命令表见 11.5） |

日志持久化（可选）：`mkdir -p /var/log/journal` + `/etc/systemd/journald.conf` 设 `Storage=persistent`、`SystemMaxUse=200M` → `systemctl restart systemd-journald`（219 均支持）。

**步骤 6：nginx 反代 + HTTPS（可选，推荐）**

```bash
sudo yum install -y epel-release && sudo yum install -y nginx
# 站点配置与 11.7 完全相同(/etc/nginx/conf.d/asset.conf, proxy_pass 127.0.0.1:3456)
sudo nginx -t && sudo systemctl enable --now nginx
```

HTTPS 说明：CentOS 7 EPEL 的 certbot 基于 Python 2 且上游已停更，**不建议**在此系统上走 certbot；推荐两种替代——① 用 11.7「方案二」的 openssl 自签命令生成证书并配 443 server 块（客户端导入 `server.crt` 消除告警）；② 直接按路径三换机后用 certbot。

**步骤 7：定时备份**

```bash
# 方式 B(本路径有 Node): 每日 02:00 热备份, 保留逻辑见 backup.js 内置轮换
sudo touch /var/log/asset-backup.log && sudo chown asset /var/log/asset-backup.log
sudo crontab -e -u asset
0 2 * * * cd /opt/asset-server/server && node backup.js >> /var/log/asset-backup.log 2>&1
```

也可用系统 sqlite3 在线备份（`yum install -y sqlite`）：CentOS 7 自带 SQLite 3.7.17，`.backup` 命令可用（3.6.11 起支持），但 **`VACUUM INTO` 不可用**（需 3.27+）。命令模板见 11.9。

**步骤 8：验证**

```bash
sudo bash verify-linux.sh        # 一键验证(脚本在 CentOS 7 全部可用: bash/sort -V/ss/curl/journalctl)
```

CentOS 7 特有抽查项：`node -v` 能输出版本（unofficial 构建）；`systemctl is-enabled asset-server` 为 enabled；`firewall-cmd --list-all` 含 http/https；浏览器登录后改默认密码。

### 12.3 路径二：Docker 容器

```bash
# ① 安装 docker-ce(阿里镜像源 yum 配置; CentOS 7 支持的最后一个大版本仍可安装)
# ② 经典坑检查: /var/lib/docker 所在 xfs 分区 ftype=0 时 overlay2 无法使用
xfs_info /var/lib/docker | grep -o 'ftype=[01]'    # 输出 ftype=0 → 重格为 mkfs.xfs -n ftype=1 或换 ext4
# ③ 运行(数据落宿主目录, 容器重建不丢)
docker run -d --name asset-server --restart unless-stopped \
  -p 80:3456 \
  -v /opt/asset-server/data:/app/data \
  -e ASSET_HOST=0.0.0.0 -e ASSET_DATA_DIR=/app/data \
  node:20-slim node /app/server/src/index.js       # 源码挂载进容器或自建镜像
# SELinux enforcing 时挂载目录加 :z: -v /opt/asset-server/data:/app/data:z
# ④ 验证: curl http://127.0.0.1/api/ping; 日志: docker logs -f asset-server
```

日志轮转建议在 `/etc/docker/daemon.json` 配 `"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}`。升级 = 换镜像 tag 重建容器，`/opt/asset-server/data` 卷不动即保数据。

> **iStoreOS / OpenWrt 软路由**（musl libc，标准产物与官方 Node 均不可用）也采用 Docker 容器方案，且须避开 LuCI 占用的 80/443 端口、数据放外挂持久盘——完整说明独立成文：**《iStoreOS部署说明.md》**。

### 12.4 路径三：换机部署（长期正解）

1. 新机器装 Rocky/Alma 8/9 或 Ubuntu 20.04+，按 **11.1-11.4** 标准路径部署（优先方式 A 产物，免 Node）；
2. 旧数据迁移：CentOS 7 上 `systemctl stop asset-server` → 拷 `asset.db + secret.key`（勿拷 -wal/-shm）→ 新机数据目录 → 启动（跨发行版通用，详见 11.10）；
3. 客户端改指向新地址（应用内"连接服务器设置"逐台修改，或批量重新分发 `server.config.json`）；验证 11.13 清单；
4. CentOS 7 无法原地升级到 Rocky 8+，只能重装+迁移；旧机退役前保留一段时间数据作回滚底。

### 12.5 禁止事项

- **原地编译/替换 glibc 到 2.28+**：glibc 是系统基石，强行升级会连锁破坏 yum/systemd 等全部程序；
- **硬跑标准产物**：把 `asset-server-linux` 或官方 Node tarball 拷过去必然报 `GLIBC_2.28 not found`；
- **从 Windows/macOS 拷 node_modules**：原生模块平台不符；从"执行过源码编译"的新 Linux 机器拷同样有 glibc 符号风险（详见 12.2 步骤 4）。

### 12.6 CentOS 7 注意事项汇总

| # | 事项 | 说明 |
| --- | --- | --- |
| 1 | EOL 无安全补丁 | 2024-06-30 起；过渡期按 12.1 要求加固，尽快换机 |
| 2 | yum 源归档 | mirrorlist 已失效，切 vault.centos.org 或阿里云 centos-vault（12.2 步骤 1） |
| 3 | GCC 4.8 太老 | C++14 源码编译需 devtoolset-11（SCL，源同在 vault） |
| 4 | SQLite CLI 3.7.17 | `.backup` 可用；`VACUUM INTO` 不可用；服务端不受影响（better-sqlite3 内置新版 SQLite） |
| 5 | systemd 219 | 本章单元字段已核对兼容；勿照抄新教程中的高版本指令（如 `Type=notify` 组合） |
| 6 | firewalld + SELinux | 无 ufw；`firewall-cmd` 放行（12.2 步骤 6）；enforcing 下 nginx 反代 502 → `setsebool -P httpd_can_network_connect 1` |
| 7 | 内核 3.10 | Docker overlay2 需 xfs ftype=1；满足则官方镜像可跑 |
| 8 | Node 认准 glibc-217 | unofficial-builds 文件名含 `linux-x64-glibc-217`，与官方包区分 |
| 9 | 小内存 | 1GB 机器建议加 2G swap（`fallocate + mkswap + swapon`，并写入 /etc/fstab） |
| 10 | 升级方式 | Node：重解压 tarball；应用：覆盖 server/ 源码（不含 node_modules）→ restart；数据目录始终不动 |

---

## 附录 A：环境变量总表

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ASSET_HOST` | `0.0.0.0` | 监听地址（全网卡） |
| `ASSET_PORT` | `3456` | 监听端口 |
| `ASSET_DATA_DIR` | `server\data` | 数据目录（数据库/密钥/备份） |
| `ASSET_DB_PATH` | `<DATA_DIR>\asset.db` | 数据库文件路径（一般不单独设） |
| `ASSET_JWT_SECRET` | 自动生成并持久化 | JWT 签名密钥 |
| `ASSET_JWT_EXPIRES` | `12h` | token 有效期 |
| `NODE_ENV` | — | 建议生产设为 `production` |

## 附录 B：API 一览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/auth/login` | 否 | 登录，返回 JWT |
| GET | `/api/auth/me` | 是 | 当前用户信息 |
| POST | `/api/auth/change-password` | 是 | 修改自身密码 |
| GET/POST | `/api/users`、DELETE `/api/users/:id` | admin | 用户管理 |
| GET | `/api/assets?page=&size=&keyword=&status=&type=&department=&owner=&user=&sort=&order=` | 是 | 分页筛选（服务端过滤） |
| GET | `/api/assets/all`、`/api/assets/:id`、`/api/assets/check-ids` | 是 | 全量/详情/编号占用 |
| POST/PUT/DELETE | `/api/assets`、`/api/assets/:id` | 写角色 | 新增/更新(乐观锁)/删除 |
| POST | `/api/assets/batch` | 写角色 | 批量导入（事务，mode=merge/replace） |
| GET/POST/DELETE | `/api/options/...` | 读/写角色 | 下拉选项维护 |
| GET | `/api/stats/summary` | 是 | 仪表盘统计聚合 |
| GET | `/api/ping`、`/api/info`、`/api/list` | 否 | 兼容层探活/元信息/键列表 |
| GET | `/api/load?key=systemSettings`、`/api/load?key=custom_options_*` | 否 | 兼容层读公开键（登录页系统名称/下拉选项，2026-09-03 起放行） |
| GET | `/api/load?key=`（其余键，如 `assetManagementData`） | 是 | 兼容层读业务数据（旧契约，需 JWT） |
| POST | `/api/save?key=`、DELETE `/api/delete?key=` | 写角色 | 兼容层写（旧契约；键名须在白名单：`KV_KEYS` 或 `asset_userStateData_` 前缀） |

统一成功格式 `{code:0,message:"ok",data}`（兼容层 `load/save` 为旧契约 `{success,data}`）；错误返回 `{code,message}`，HTTP 状态码同步设置。

## 附录 C：目录结构

```
server\
├── package.json            # 依赖与启动脚本
├── backup.js               # 数据库在线备份工具(可配计划任务)
├── reset-admin.js          # admin 密码重置工具(应急)
├── src\
│   ├── index.js            # 入口（Koa 装配、监听、横幅）
│   ├── config.js           # 环境变量与默认配置（IS_PKG 打包感知）
│   ├── db.js               # SQLite 连接、建表、默认管理员
│   ├── errors.js           # 统一错误/响应
│   ├── auth.js             # JWT 中间件、认证与用户路由
│   ├── asset-mapper.js     # DB 行 ↔ 前端资产对象映射、校验
│   ├── migrate.js          # 迁移工具（CLI）
│   └── routes\
│       ├── assets.js       # 资产 CRUD/分页/批量
│       ├── options.js      # 下拉选项
│       ├── stats.js        # 统计
│       └── compat.js       # 旧版薄 API 兼容层
├── scripts\
│   └── build-exe.js        # 打包脚本（build:exe → dist\asset-server.exe；build:linux → asset-server-linux）
├── dist\
│   ├── asset-server.exe    # Windows 独立服务端产物（免 Node.js 运行）
│   └── asset-server-linux  # Linux x64 独立服务端产物（glibc ≥ 2.28，见第 11 章）
├── deploy\                 # ★ 生产部署包（复制到服务器纯英文路径使用）
│   ├── 一键安装.bat        #   一键安装入口（证书+防火墙+双服务+健康检查）
│   ├── asset-server.exe    #   服务端（由 dist\ 复制）
│   ├── nginx\              #   nginx Windows 版
│   ├── nssm.exe            #   服务封装工具
│   ├── make-cert.ps1       #   自签证书生成
│   ├── asset-server.service          #   systemd 单元（Linux 部署，见第 11 章）
│   ├── asset-server-centos7.service  #   CentOS 7 专用 systemd 单元（见第 12 章）
│   ├── verify-linux.sh               #   Linux 部署一键验证脚本（只读，见 11.13）
│   ├── nginx.conf          #   反代配置（安装时自动部署到 nginx\conf\）
│   ├── install-service.bat / uninstall-service.bat
│   ├── cert\               #   server.crt / server.key（make-cert 生成）
│   ├── logs\               #   服务运行日志（安装后生成）
│   └── data\               #   EXE 数据目录（首次启动生成，asset.db 在此）
├── data\                   # 数据目录（源码方式，自动创建）
│   ├── asset.db            # ★ 数据库主文件（备份它=备份一切）
│   ├── asset.db-wal/-shm   # WAL 运行时文件（勿手工删）
│   ├── secret.key          # JWT 密钥（勿外泄）
│   └── backups\            # 在线备份输出（可选）
└── tests\api.test.js       # 冒烟测试（npm test）
```

## 附录 D：命令速查

```powershell
cd D:\asset-server
npm start                                          # 前台启动（源码方式）
npm test                                           # 冒烟测试
npm run migrate -- --source "C:\旧数据" --dry-run   # 迁移预检
npm run migrate -- --source "C:\旧数据"             # 执行迁移
node backup.js                                     # 立即备份
node reset-admin.js 新密码                          # 重置 admin 密码
npm run build:exe                                  # 打包独立服务端 EXE → dist\
npm run build:linux                                # 交叉打包 Linux 产物 → dist\asset-server-linux
D:\tools\nssm.exe restart AssetServer              # 重启服务（源码手动 NSSM 方案）
curl http://127.0.0.1:3456/api/ping                # 探活（直连）

# —— Linux 服务器（第 11 章，Ubuntu/Debian 示例）——
sudo systemctl status asset-server                 # 服务状态
sudo systemctl restart asset-server                # 重启服务
curl http://127.0.0.1/api/ping                     # 探活（经 nginx 80）
sudo bash verify-linux.sh                          # 一键验证（只读，10 项检查）

# —— deploy 生产部署包（管理员 PowerShell，在 deploy 目录内）——
.\一键安装.bat                                     # 一键安装(证书+防火墙+双服务+健康检查)
powershell -ExecutionPolicy Bypass -File make-cert.ps1   # 生成自签证书(分步方式)
.\install-service.bat                              # 仅装服务(分步方式)
.\uninstall-service.bat                            # 一键卸载
.\nssm.exe restart AssetServer                     # 重启服务（部署包方案）
curl -k https://127.0.0.1/api/ping                 # 探活（HTTPS 443）

# —— CentOS 7（第 12 章，unofficial-builds Node + 源码）——
# Node 认准文件名含 linux-x64-glibc-217 的 tarball; 单元文件 asset-server-centos7.service
# yum 源在 vault(12.2 步骤 1); 验证同用 verify-linux.sh; 注意事项见 12.6
```

---

*文档结束。部署过程中遇到本文未覆盖的问题，请记录现象与 `data\` 目录状态后联系系统维护人员。*
