# 手机 App 发布更新流程

> 适用范围：React Native 原生 App（`mobile-app-rn/`）**v1.1.0（versionCode 2）及以后**的应用内自更新发版。机制细节见 [手机App构建说明.md](手机App构建说明.md) 第五章；测试验收用 [App自更新测试报告模板.md](App自更新测试报告模板.md)。
>
> 电脑端 EXE 的对应手册见 [EXE客户端发布更新流程.md](EXE客户端发布更新流程.md)，两者模式一致：**服务器零改动，版本源 = nginx `/downloads/` 下的静态 JSON 文件**。
>
> 敏感信息（SSH/sudo 密码）见工作区 `rn-apk-deploy` 技能固定环境表，本文用 `<密码>` 占位。
>
> 最后更新：2026-09-13

---

## 一、更新机制速览

**版本源**：`http://192.168.40.247/downloads/apk-update.json`（UTF-8 **无 BOM**）

| 字段 | 必填 | 说明 |
|---|---|---|
| `versionCode` | ✅ | **唯一更新判定依据**：整数，必须严格大于客户端当前值（当前生产值见下表） |
| `versionName` | ✅ | 仅展示（如 1.1.0） |
| `url` | ✅ | APK 地址：绝对 URL，或相对文件名（按 App 内配置的服务器地址拼接） |
| `notes` | | 更新说明，`\n` 分行，弹窗逐行显示 |
| `sha256` | | APK 的小写十六进制哈希；提供则强制校验，不匹配中止 |
| `publishedAt` | | 发布时间，仅展示 |

**客户端行为**：启动 6 秒静默检查（10 秒超时，失败忽略）→ 弹窗（版本号+说明）→「立即更新」→ 应用内下载（进度条）→ SHA-256 流式校验 → Android 8+ "安装未知应用"授权（跳系统设置，**返回 App 自动继续**）→ FileProvider 调起系统安装器覆盖安装。任何失败保留旧版可用。

**与 Web 前端的区别（重要）**：RN App 是**整包更新**——改了任何 App 代码（包括纯 JS）都必须重新构建 APK 并发新版，不存在"pscp 热上传"捷径；只有业务网页端（index.html/js）才支持热上传。

## 二、覆盖安装两个硬性前提

1. **包名不变**：`com.assetmanagement.mobile`
2. **签名一致**：始终用 `mobile-app-rn/android/app/debug.keystore`（**勿删勿换**；一旦换签名，已装客户端无法应用内更新，只能卸载重装）

每次发版前验证签名连续（build-tools 的 aapt/apksigner **不支持中文路径**，先把 APK 复制到 `C:\Windows\Temp\` 再验）：

```powershell
$env:JAVA_HOME = "C:\jdk17\PFiles64\Microsoft\jdk-17.0.20.101-hotspot"
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
Copy-Item "<APK路径>" C:\Windows\Temp\check.apk -Force
& "C:\Android\Sdk\build-tools\34.0.0\apksigner.bat" verify --print-certs C:\Windows\Temp\check.apk   # 应为 CN=Android Debug
& "C:\Android\Sdk\build-tools\34.0.0\aapt.exe" dump badging C:\Windows\Temp\check.apk | findstr package   # 核对 versionCode/versionName
Remove-Item C:\Windows\Temp\check.apk -Force
```

## 三、标准发版流程

### 第 1 步：改版本号（两处）

| 文件 | 字段 | 规则 |
|---|---|---|
| `mobile-app-rn/android/app/build.gradle` | `versionCode` | **必须 +1**（整数，唯一判定依据） |
| `mobile-app-rn/android/app/build.gradle` | `versionName` | 语义化版本，如 1.1.0 → 1.2.0 |
| `mobile-app-rn/package.json` | `version` | 与 versionName 保持一致 |

### 第 2 步：subst R 盘 + 打 JS bundle（真实路径）

```powershell
subst R: "d:\Users\Administrator\Desktop\固定资产管理系统exe离线便携版v1.1\mobile-app-rn"
cd "d:\Users\Administrator\Desktop\固定资产管理系统exe离线便携版v1.1\mobile-app-rn"
npx react-native bundle --platform android --dev false --entry-file index.js `
  --bundle-output android/app/src/main/assets/index.android.bundle `
  --assets-dest android/app/src/main/res
```

> Metro 无法在 subst 盘上算 SHA-1，bundle 必须在真实路径执行；成功标志 `Done writing bundle output`，约 2 MB。

### 第 3 步：gradle 构建（R 盘）

```powershell
$env:JAVA_HOME = "C:\jdk17\PFiles64\Microsoft\jdk-17.0.20.101-hotspot"
$env:ANDROID_HOME = "C:\Android\Sdk"
$env:GRADLE_HOME = "C:\gradle-8.10.2"
$env:PATH = "$env:JAVA_HOME\bin;$env:GRADLE_HOME\bin;$env:PATH"
Get-Process java -ErrorAction SilentlyContinue | Stop-Process -Force   # 清理守护防锁
Set-Location R:\android
gradle assembleDebug --no-daemon --console=plain
```

成功标志 `BUILD SUCCESSFUL`；产物 `android\app\build\outputs\apk\debug\app-debug.apk`（约 200 MB）。

### 第 4 步：计算哈希

```powershell
(Get-FileHash "d:\Users\Administrator\Desktop\固定资产管理系统exe离线便携版v1.1\mobile-app-rn\android\app\build\outputs\apk\debug\app-debug.apk" -Algorithm SHA256).Hash.ToLower()
```

### 第 5 步：生成 apk-update.json（UTF-8 无 BOM）

```powershell
$json = @'
{
  "versionCode": 3,
  "versionName": "1.2.0",
  "url": "http://192.168.40.247/downloads/asset-mgmt-rn-debug.apk",
  "notes": "【变更】一行一个要点，支持多行",
  "sha256": "<第4步的哈希>",
  "publishedAt": "2026-XX-XXTXX:XX:00+08:00"
}
'@
[System.IO.File]::WriteAllText('C:\Windows\Temp\apk-update.json', $json, [System.Text.UTF8Encoding]::new($false))
# 自检：首字节应为 123（'{'）；239 = 带 BOM，错误
[System.IO.File]::ReadAllBytes('C:\Windows\Temp\apk-update.json')[0]
Get-Content C:\Windows\Temp\apk-update.json -Raw | ConvertFrom-Json | Select-Object versionCode, versionName
```

### 第 6 步：上传并就位（pscp → /tmp → sudo 拷贝）

```powershell
$pscp = "D:\Program Files\PuTTY\pscp.exe"; $plink = "D:\Program Files\PuTTY\plink.exe"; $pw = "<密码>"
$apk = "d:\Users\Administrator\Desktop\固定资产管理系统exe离线便携版v1.1\mobile-app-rn\android\app\build\outputs\apk\debug\app-debug.apk"
& $pscp -batch -pw $pw $apk "hmt@192.168.40.247:/tmp/app-debug.apk"          # 约 200MB，内网约 20-60 秒
& $pscp -batch -pw $pw C:\Windows\Temp\apk-update.json "hmt@192.168.40.247:/tmp/apk-update.json"
& $plink -ssh -batch -pw $pw hmt@192.168.40.247 "echo <sudo密码> | sudo -S sh -c 'cp /tmp/app-debug.apk /opt/asset-server/downloads/asset-mgmt-rn-debug.apk && cp /tmp/apk-update.json /opt/asset-server/downloads/apk-update.json && chown asset:asset /opt/asset-server/downloads/asset-mgmt-rn-debug.apk /opt/asset-server/downloads/apk-update.json && chmod 644 /opt/asset-server/downloads/asset-mgmt-rn-debug.apk /opt/asset-server/downloads/apk-update.json && rm -f /tmp/app-debug.apk /tmp/apk-update.json' && sha256sum /opt/asset-server/downloads/asset-mgmt-rn-debug.apk && echo DEPLOY_DONE"
```

**文件名固定不换**：`asset-mgmt-rn-debug.apk` + `apk-update.json`（客户端按固定名请求）。

### 第 7 步：验证（三重）

```powershell
# ① 服务器哈希 = 第 4 步本地哈希（上一命令输出中已含）
# ② HTTP 可达
Invoke-WebRequest -Method Head "http://192.168.40.247/downloads/asset-mgmt-rn-debug.apk" -UseBasicParsing   # 期望 200
# ③ JSON 中文正常（PowerShell 的 .Content 会假乱码，必须按原始字节验）
$b = (Invoke-WebRequest "http://192.168.40.247/downloads/apk-update.json" -UseBasicParsing).RawContentStream.ToArray()
[System.Text.Encoding]::UTF8.GetString($b)   # $b[0] 应为 123
```

### 第 8 步：手机实测 + 收尾

1. 手机（装着旧版）启动 App → 6 秒自动弹更新；或「我的 → 关于 → 检查更新」
2. 完整走一遍：下载 → 授权 → 安装 → 打开核对「关于 → 当前版本」
3. 按 [App自更新测试报告模板.md](App自更新测试报告模板.md) 填写测试报告（复制一份）
4. `subst R: /D`（必须卸载）；git 提交（本次改动 + 构建说明的发布记录行）

## 四、紧急回滚

| 场景 | 操作 |
|---|---|
| JSON 发错（版本号/说明写错），尚有用户未升级 | 直接改服务器上的 `apk-update.json`（重走第 5~7 步，只传 JSON），改回正确内容即可；JSON 未更新前客户端不会弹窗 |
| 新版 APK 有严重问题，需阻止用户升级 | 把 `apk-update.json` 的 `versionCode` 改回**当前线上已装版本**的值——未升级客户端立即不再提示；**已升级的用户无法降级**（Android 覆盖安装不支持 versionCode 回退），只能尽快发更高 versionCode 的修复版 |
| 新 APK 文件本身有问题但 JSON 还没传 | 只传修正后的 APK 即可（JSON 未变则客户端无感知） |

## 五、故障排查速查

| 现象 | 处理 |
|---|---|
| 手机不弹更新提示 | ① 确认客户端 ≥ v1.1.0（v1.0.0 无更新器，需浏览器手动装一次）② 手机浏览器能打开 apk-update.json？③ JSON `versionCode` 是否 > 客户端（判定只认 versionCode）④ App「设置 → 服务器」地址是否正确 |
| 更新说明中文乱码 | JSON 带 BOM 或非 UTF-8，用第 5 步命令重写（首字节 123） |
| 安装器报"无法安装/软件包无效" | versionCode 未递增、签名换了（核对 debug.keystore）、APK 上传损坏（哈希不一致） |
| SHA256 校验失败弹窗 | APK 与 JSON 不配套（传了新 APK 忘传 JSON 等）；重新计算并同步两者 |
| 弹"需要授权"后没反应 | 授权后需**返回 App**（不能停在系统设置页），返回后自动继续；仍不行则到「我的 → 检查更新」重来 |
| gradle 在中文路径报 `No such file or directory` | 没用 R 盘构建，回第 3 步用 subst |
| Metro 报 `SHA-1 ... not computed` | bundle 在 R 盘打了，回第 2 步在真实路径打 |

完整排查表见 [手机App构建说明.md](手机App构建说明.md) 5.5 节。

## 六、限制说明

- 仅 **Debug 签名**；正式分发需专属 keystore（换签名 = 已装用户全部卸载重装，慎做）
- 下载不支持断点续传，失败后「重试」为重新下载；下载中建议保持 App 前台
- 仅 Android；未做 iOS
- `apk-update.json` 必须与 APK **成对同步更新**：只换 APK 不换 JSON，客户端收不到提示；只换 JSON 不换 APK，会下载到旧包但哈希校验会拦下（若 JSON 带了新 sha256）

## 七、发布记录

| 日期 | versionName | versionCode | SHA256（前 12 位） | 备注 |
|---|---|---|---|---|
| 2026-09-13 | 1.1.0 | 2 | 375abd497b37 | 首个内置更新器版本；v1.0.0 客户端需最后一次手动覆盖安装 |
