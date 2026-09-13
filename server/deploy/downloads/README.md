# downloads/ — 客户端在线更新文件目录（模板）

生产服务器上此目录对应 `/opt/asset-server/downloads/`（nginx `/downloads/` 别名指向），存放 **EXE 客户端** 与 **手机 App** 的自更新文件。二进制文件（APK/EXE）不进 git，本目录只放 JSON 模板与说明。

## 文件清单（生产环境）

| 文件 | 用途 | 固定文件名？ |
|---|---|---|
| `asset-mgmt-client.exe` | EXE 客户端自更新下载包 | ✅ 固定名，客户端按名请求 |
| `client-update.json` | EXE 客户端版本源 | ✅ 固定名 |
| `asset-mgmt-rn-debug.apk` | 手机 App 自更新下载包 | ✅ 固定名 |
| `apk-update.json` | 手机 App 版本源 | ✅ 固定名 |

## 重要：新服务器初始状态

新部署的服务器 **不要** 预置任何 `client-update.json` / `apk-update.json`（本目录两个模板文件都带 `.template` 后缀，不会被客户端识别）。原因：

- 旧版客户端（无更新器）不受影响；但**已启用更新器的客户端**启动时会检查版本源，若 JSON 里 versionCode/version 大于客户端当前值，会弹更新提示，而新服务器上没有对应安装包 → 下载 404 报错。
- 首次正式发版时，按流程手册生成真实 JSON 上传后再启用。

## 发版流程（照做即可）

- EXE 客户端：见 [docs/EXE客户端发布更新流程.md](../../../docs/EXE客户端发布更新流程.md)（9 步，含 PowerShell 命令模板）
- 手机 App：见 [docs/手机App发布更新流程.md](../../../docs/手机App发布更新流程.md)（8 步）

两份手册共同要求：JSON 必须 **UTF-8 无 BOM**（PowerShell 用 `[System.IO.File]::WriteAllText(..., [System.Text.UTF8Encoding]::new($false))`），上传后属主 `asset:asset`、权限 644。

## 模板字段说明

- `client-update.json.template`：`version`（语义化版本，大于客户端当前值才触发）、`url`（可省略，默认 `<服务器地址>/downloads/asset-mgmt-client.exe`）、`notes`、`sha256`（提供则强制校验）、`publishedAt`
- `apk-update.json.template`：`versionCode`（整数，**唯一更新判定依据**，必须 +1）、`versionName`（仅展示）、`url`、`notes`（`\n` 分行）、`sha256`、`publishedAt`
