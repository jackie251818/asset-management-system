# EXE 客户端发布与在线更新流程（v3.7.1+）

> 适用对象：系统管理员/发布人
> 适用版本：便携版 EXE **v3.7.1 及以上**，且客户端以 **C/S 客户端模式**（连接服务器）运行
> 最后更新：2026-09-13

---

## 1. 功能概述

v3.7.1 起，便携版 EXE 内置**在线自更新器**。已分发到各员工电脑的客户端无需逐台手动替换：

| 时机 | 行为 |
|---|---|
| 客户端启动并成功加载服务端页面后 6 秒 | **静默检查**一次更新；网络不通/超时时完全无感知，不打扰用户 |
| 发现新版本 | 弹原生对话框：新版本号、当前版本号、更新说明（notes）→ 用户选「立即更新 / 暂不更新」 |
| 确认更新 | 后台下载（任务栏图标显示进度条）→ **SHA256 校验** → 自动替换原 EXE → 自动重启为新版 |
| 任何时候按 **Alt 键** → 设置 → **检查更新** | 手动检查："已是最新 / 发现新版本 / 无法获取更新信息 / 单机模式不支持"均有明确提示 |

**关键前提：v3.7.1 是首个带更新器的版本，这一版仍需手动分发替换一次。** 之后发布的所有新版本，已运行 v3.7.1+ 的客户端都能自动发现并升级。

> 单机模式（未连接服务器）不检查更新——没有可访问的更新源，菜单手动检查会提示"当前为单机模式，不支持在线更新"。

---

## 2. 更新原理（了解即可，日常发版可直接跳到第 4 节）

### 2.1 版本源：服务器上的一个静态 JSON

客户端向**当前所连服务器**请求（同源，跟随用户的连接地址自动适配）：

```
http://<服务器地址>/downloads/client-update.json
```

文件内容（UTF-8，**不要带 BOM**）：

```json
{
  "version": "3.7.2",
  "url": "http://192.168.40.247/downloads/asset-mgmt-client.exe",
  "notes": "1. 修复 XXX\n2. 新增 YYY",
  "sha256": "（新 exe 的 SHA256 小写十六进制）",
  "publishedAt": "2026-09-13T06:00:00Z"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `version` | 是 | 最新版本号，语义化 `主.次.补丁`，按 `.` 分段**数字比较**（`3.7.10 > 3.7.9`）。必须高于客户端 `package.json` 版本才提示更新 |
| `url` | 否 | 新 EXE 的完整下载地址；**省略或非 http(s) 开头时，客户端自动用 `<服务器origin>/downloads/asset-mgmt-client.exe`** |
| `notes` | 否 | 更新说明，显示在询问弹窗中（`\n` 换行） |
| `sha256` | 强烈建议 | 下载文件的 SHA256（小写）。不一致则拒绝替换并提示"校验失败"；**留空则跳过校验（不推荐）** |
| `publishedAt` | 否 | 发布时间（ISO 8601），仅作记录 |

同目录放新 EXE，**文件名固定为 `asset-mgmt-client.exe`**（每次发版覆盖同名文件；客户端不依赖文件名识别版本）。

### 2.2 客户端处理流程

```
启动 → C/S 窗口加载成功 → 6 秒后静默 GET client-update.json（5 秒超时）
      → 版本比较：远端 > 本地(app.getVersion()，取 package.json)？
           否 → 结束，无任何弹窗
           是 → 弹「发现新版本」对话框
                  ├─ 暂不更新 → 结束（下次启动再问）
                  └─ 立即更新 → 下载到 %TEMP%（任务栏进度条）
                                → SHA256 校验（不匹配则中止，旧版照常用）
                                → 写 wscript 辅助脚本，经 explorer.exe 代启
                                → 应用退出 → 辅助脚本等原 EXE 释放
                                    → 旧 EXE 改名 .old → 移入新 EXE（失败自动回滚）
                                    → 拉起新版 EXE
```

### 2.3 便携版自替换的两个关键坑（已在代码中解决）

1. **原 EXE 路径不能用 `app.getPath('exe')`**——便携版运行时它指向 %TEMP% 解压目录里的内部 EXE，替换它会被下次启动重新解压覆盖。正确路径取 stub 注入的环境变量 **`PORTABLE_EXECUTABLE_FILE`**（分发到用户手里的那个 EXE 完整路径）。
2. **stub 运行期间锁住自身 EXE 文件（EBUSY），且应用自己启动的辅助进程会被 stub 退出时连带杀掉**——即使用 `detached` 也不行。最终方案：写一个 UTF-16LE+BOM 的 `.vbs` 辅助脚本，通过 **explorer.exe 代启 wscript**（由系统外部进程创建，彻底脱离应用进程树），脚本轮询等待文件可写后完成替换与重启。

辅助脚本逻辑：旧 EXE 改名 `<exe>.old` → 新文件移入原路径；移入失败立即把 `.old` 改回（回滚，旧版可用）。新版**下次启动时自动删除** `.old` 与下载临时文件。

### 2.4 失败安全保证

以下任一情况，**旧版 EXE 原样保留，用户可继续使用**，仅可能看到错误提示：

- 服务器不可达 / JSON 格式错误 / 请求超时（静默检查时完全无提示）
- 下载失败、下载超时（120 秒无数据）
- SHA256 不匹配
- 应用退出后 30 秒内原 EXE 仍被占用（目录不可写、杀软拦截等）

全过程诊断日志：客户端电脑 **`%TEMP%\asset-update.log`**。

---

## 3. 服务器端准备（仅首次，一次性）

更新源是纯静态文件，服务端程序**零改动**，只需 nginx 提供下载目录。

### 3.1 目录与文件

```
/opt/asset-server/downloads/                 # Linux 当前生产路径（Windows 部署包为 deploy\downloads\）
├── client-update.json                       # 版本描述文件（644，属主 asset:asset）
└── asset-mgmt-client.exe                    # 最新客户端 EXE，固定文件名（644，属主 asset:asset）
```

### 3.2 nginx 配置（Linux）

在站点 `server { ... }` 中、`location /` **之前**加：

```nginx
location /downloads/ {
    alias /opt/asset-server/downloads/;
    autoindex on;
}
```

生效：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 3.3 当前生产环境（已配置完成，备查）

| 项 | 值 |
|---|---|
| 服务器 | `192.168.40.247`（Ubuntu 22.04，systemd + nginx） |
| 下载目录 | `/opt/asset-server/downloads/`（属主 `asset:asset`） |
| 版本源 | `http://192.168.40.247/downloads/client-update.json` |
| EXE 直链 | `http://192.168.40.247/downloads/asset-mgmt-client.exe` |
| pscp / plink | `D:\Program Files\PuTTY\pscp.exe`、`plink.exe`（开发机已安装） |

验证（服务器本机或开发机均可）：

```bash
curl -sI http://192.168.40.247/downloads/asset-mgmt-client.exe | head -1   # 期望 HTTP/1.1 200 OK
curl -s  http://192.168.40.247/downloads/client-update.json                 # 期望输出 JSON
```

---

## 4. 标准发版流程（每次发新版照此执行）

> 全程在**开发机**（本机项目目录）用 PowerShell 5.1+ 操作。
> 把下面的 `x.y.z` 换成新版本号；服务器登录/sudo 密码见工作区 `rn-apk-deploy` 技能的固定环境表（同机同账号）。

### 步骤 1：改版本号

编辑 [package.json](../package.json)：

```json
"version": "x.y.z"
```

版本号就是客户端比较更新的依据（EXE 内 `app.getVersion()` 读取它）。

### 步骤 2：构建便携版 EXE

```powershell
npm run build:portable
```

首次会弹 UAC（rcedit 写 PE 版本资源需要管理员，脚本自动提权，确认即可）。
产物：`dist_build_<时间戳>\固定资产管理系统-便携版-x.y.z.exe`（约 78 MB）。取该目录下体积最大的那个便携 EXE。

### 步骤 3：复制产物到暂存目录并计算 SHA256

```powershell
$ver   = 'x.y.z'
$build = Get-ChildItem -Directory -Filter 'dist_build_*' | Sort-Object Name -Descending | Select-Object -First 1
$src   = Join-Path $build.FullName "固定资产管理系统-便携版-$ver.exe"
$stage = 'C:\asset-release'                       # 暂存目录（没有就先 New-Item -ItemType Directory）
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$exeDst = Join-Path $stage 'asset-mgmt-client.exe'
Copy-Item $src $exeDst -Force
$sha = (Get-FileHash $exeDst -Algorithm SHA256).Hash.ToLower()
"$($src)  =>  sha256 = $sha"
```

### 步骤 4：生成 client-update.json（**必须无 BOM**）

```powershell
$json = @{
    version     = $ver
    url         = 'http://192.168.40.247/downloads/asset-mgmt-client.exe'
    notes       = "1. 修复了……`n2. 新增了……"     # 弹窗里给用户看的更新说明
    sha256      = $sha
    publishedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
} | ConvertTo-Json -Compress
# ★ 必须用 .NET 写无 BOM UTF-8；PowerShell 的 Set-Content -Encoding UTF8 会带 BOM，客户端 JSON.parse 直接失败
[System.IO.File]::WriteAllText((Join-Path $stage 'client-update.json'), $json + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false)))
Get-Content (Join-Path $stage 'client-update.json')
```

### 步骤 5：上传到服务器 /tmp

```powershell
$pscp = 'D:\Program Files\PuTTY\pscp.exe'
$pw   = '<服务器密码>'                              # 见 rn-apk-deploy 技能固定环境表
& $pscp -batch -pw $pw (Join-Path $stage 'asset-mgmt-client.exe') 'hmt@192.168.40.247:/tmp/asset-mgmt-client.exe'
& $pscp -batch -pw $pw (Join-Path $stage 'client-update.json')      'hmt@192.168.40.247:/tmp/client-update.json'
```

78 MB 内网约 2~60 秒，耐心等待返回码 0。

### 步骤 6：sudo 就位到下载目录

```powershell
$plink = 'D:\Program Files\PuTTY\plink.exe'
& $plink -ssh -batch -pw $pw hmt@192.168.40.247 "echo <sudo密码> | sudo -S cp /tmp/asset-mgmt-client.exe /opt/asset-server/downloads/asset-mgmt-client.exe && echo <sudo密码> | sudo -S cp /tmp/client-update.json /opt/asset-server/downloads/client-update.json && echo <sudo密码> | sudo -S chown asset:asset /opt/asset-server/downloads/asset-mgmt-client.exe /opt/asset-server/downloads/client-update.json && echo <sudo密码> | sudo -S chmod 644 /opt/asset-server/downloads/asset-mgmt-client.exe /opt/asset-server/downloads/client-update.json && rm -f /tmp/asset-mgmt-client.exe /tmp/client-update.json && ls -lh /opt/asset-server/downloads/ && echo DEPLOY_DONE"
```

看到 `DEPLOY_DONE` 即就位。

### 步骤 7：发布后验证（必做）

```powershell
# ① HTTP 可达性
curl.exe -sI http://192.168.40.247/downloads/asset-mgmt-client.exe | Select-Object -First 1   # HTTP/1.1 200 OK
# ② JSON 内容正确（version/sha256）
curl.exe -s  http://192.168.40.247/downloads/client-update.json
# ③ 服务器侧文件哈希与步骤 3 一致（防上传损坏）
& $plink -ssh -batch -pw $pw hmt@192.168.40.247 'sha256sum /opt/asset-server/downloads/asset-mgmt-client.exe'
```

### 步骤 8：找一台已分发的 v3.7.1+ 客户端实测

- 直接重启客户端：约 6 秒后应弹「发现新版本 x.y.z」；或按 **Alt → 设置 → 检查更新**
- 点「立即更新」，观察下载进度条 → 应用自动重启
- 重启后菜单「检查更新」应提示"已是最新版本 x.y.z"
- 如有异常，取该机 `%TEMP%\asset-update.log` 对照第 6 节排查

### 步骤 9：提交代码并记录

```powershell
git add package.json main.js
git commit -m 'feat(vX.Y.Z): <一句话变更说明>'
git push
```

并在本文档第 8 节「发布记录」追加一行。

---

## 5. 紧急回滚 / 撤回版本

更新器**只升不降**（远端版本必须高于本地才提示），因此：

| 情形 | 处理 |
|---|---|
| 新版本刚发布、**大部分客户端还没点更新** | 用上一个**好版本**的 EXE 与 `client-update.json`（version 填旧版本号）重新执行步骤 5~7 覆盖服务器文件。未更新的客户端检查到的仍是旧版，不会升级；可在旧版基础上修复后发**更高的新版本号** |
| **已有客户端升级到坏版本** | 它们不会被自动降级。二选一：① 修复后发一个**版本号更高**的新版本（推荐，客户端自动拉到修复版）；② 逐台手动用上版 EXE 替换（此时 `%TEMP%\asset-update.log` 与 `.old` 文件可作为排查依据） |
| 只想先暂停推送 | 把 `client-update.json` 的 `version` 改成与当前线上相同（或临时移走该文件——客户端取不到即静默跳过，等同关闭更新） |

> 建议每次发版后、确认新版本正常前，暂存目录 `C:\asset-release\` 保留**上一版** EXE 与 JSON，便于 5 分钟内回切。

---

## 6. 故障排查

客户端侧统一日志：**`%TEMP%\asset-update.log`**（更新器独立日志）；主进程日志 `%TEMP%\asset-main.log`。

| 现象 | 根因 | 处理 |
|---|---|---|
| 所有客户端都不提示更新 | ① 客户端是 v3.7.1 之前的旧 EXE（无更新器）；② 客户端运行在单机模式；③ JSON 不可达 | ① v3.7.1 这版必须手动分发一次；② 检查连接设置；③ 开发机 `curl http://<IP>/downloads/client-update.json`；看 nginx 是否配了 `location /downloads/` |
| 手动检查提示"无法获取更新信息" | JSON 返回非 200 / 内容不是合法 JSON | 重点查 **BOM**：用 [System.IO.File]::WriteAllText 无 BOM 重写；查文件属主/权限 644 |
| 日志 `SHA256 不匹配` 并中止 | JSON 里 sha256 与实际 EXE 不一致（上传了错误文件或漏改哈希） | 服务器 `sha256sum` 与本地 `Get-FileHash` 比对，用正确哈希重写 JSON 重新上传（EXE 不用重传） |
| 日志 `替换失败: 30秒内原文件仍被占用` | EXE 所在目录用户无写权限（如放在 `Program Files`），或杀毒软件锁文件 | 便携版应放在用户可写目录；将 EXE 加入杀软白名单；用户从菜单再次「检查更新」重试 |
| 更新后版本号没变 | 自替换实际命中了 %TEMP% 解压目录（极旧构建的 bug） | 确认客户端 EXE 是 v3.7.1 正式构建；`%TEMP%\asset-update.log` 中"启动替换辅助脚本"路径应指向**分发位置**而非 %TEMP% |
| 客户端能开但下载很慢/失败 | 内网带宽或 nginx 超时；文件不完整 | 重新点「检查更新」即可重新下载（临时文件每次覆盖）；必要时分发时段避开网络高峰 |
| 发布后浏览器访问旧链接缓存 | 与 EXE 更新无关；EXE 下载请求固定 URL 覆盖同名文件 | 如用浏览器直链测试遇缓存，URL 后加 `?v=时间戳`；客户端更新器自带无缓存策略不受影响 |

服务端 nginx 排查：

```bash
sudo tail -f /var/log/nginx/access.log | grep downloads
sudo nginx -t
```

---

## 7. 限制与注意事项

1. **仅 C/S 客户端模式生效**；单机模式不检查更新（单机版如内置 asset-server.exe 需要升级，仍走整包重新分发）。
2. **仅验证了便携版（portable）**；NSIS 安装版虽有路径回退逻辑但未实测，建议统一分发便携版。
3. 更新只替换客户端 EXE 本身，**不触碰** `%APPDATA%\asset-management-system\` 下的连接设置与数据（C/S 模式数据本来就在服务器）。
4. 服务端程序、前端网页的更新是**另一条独立流程**（见 [CS架构部署文档.md](CS架构部署文档.md) 11.14 节"前端热更新"），与客户端自更新互不依赖，可分别发布。
5. `version` 必须是数字点分格式；同版本号不会重复提示。
6. 服务器 EXE 文件名**永远是** `asset-mgmt-client.exe`（覆盖更新），不要用带版本号的文件名替换，否则要同步改 JSON 的 `url`。
7. JSON 与 EXE 上传后建议保持"先传 EXE、确认哈希无误，再传 JSON"的顺序，避免客户端在极短窗口内拉到新 JSON + 旧 EXE（SHA256 不匹配会安全中止，但下次才会成功）。
8. 开发模式（`npm start`，未打包）不执行自替换，菜单检查会提示"开发环境不支持在线更新"。

---

## 8. 发布记录

| 日期 | 版本 | EXE SHA256（前 12 位） | 主要内容 | 发布/验证人 |
|---|---|---|---|---|
| 2026-09-13 | 3.7.1 | `5bf4a6c63a62` | 首个带在线更新器的版本；同步含数据管理服务端化、恢复出厂设置 | 开发机自动部署，mock E2E + 线上 curl 验证通过 |
