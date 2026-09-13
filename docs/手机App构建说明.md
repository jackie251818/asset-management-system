# 手机 App 构建说明（React Native 版）

> 固定资产管理系统原生 Android App 构建文档
> 2026-09-12 重写：旧 Capacitor WebView 套壳方案（`mobile-app/`）已废弃并删除，现行为 **React Native 原生应用**（`mobile-app-rn/`）。
> 重建背景与选型见同目录《ReactNative重建方案.md》。

---

## 一、项目概述

| 项 | 值 |
|---|---|
| App 名称 | 固定资产管理（原生移动版） |
| 包名 | com.assetmanagement.mobile |
| 框架 | React Native 0.75.4（旧架构 Paper + Hermes，`newArchEnabled=false`） |
| 语言 | TypeScript 5.5 + Kotlin（原生壳） |
| 最低 Android 版本 | Android 7.0（minSdk 24） |
| 目标/编译 SDK | compileSdk/targetSdk 34，AGP 8.7.2，Kotlin 1.9.24 |
| 服务器 | `http://192.168.40.247`（内网，HTTP 明文已放行） |
| 项目路径 | `d:\Users\Administrator\Desktop\固定资产管理系统exe离线便携版v1.1\mobile-app-rn\` |
| 发布产物 | `android\app\build\outputs\apk\debug\app-debug.apk`（约 200 MB，含四架构 + MLKit 扫码模型，内置 JS bundle 可离线运行） |
| 下载地址 | `http://192.168.40.247/downloads/asset-mgmt-rn-debug.apk` |
| 当前版本 | **versionCode 2 / versionName 1.1.0**（2026-09-13，新增应用内自更新） |
| 自更新 | v1.1.0 起支持：启动自动检查 + "我的→检查更新"，版本源 `http://192.168.40.247/downloads/apk-update.json`（见第五章） |

### 与旧 Capacitor 方案的本质区别

| 维度 | 旧 Capacitor（已废弃） | 现 React Native |
|---|---|---|
| 页面 | WebView 加载服务器网页 | 原生 RN 组件，JS bundle 打包进 APK |
| 改 JS 后 | 热上传服务器即可 | **必须重新构建 APK** |
| 扫码 | @capacitor-community/barcode-scanner | react-native-vision-camera v4 原生 MLKit |
| 存储 | Capacitor Preferences | MMKV（Zustand 持久化） |
| 导航 | 网页路由 | React Navigation（底部 4 Tab + Stack） |

App 功能页：登录、首页统计、资产列表/详情/新增、盘点列表/明细、扫码盘点、我的/设置（四套主题）。
**不含**飞书同步配置页（该功能仅 Web 管理后台提供）。

---

## 二、环境依赖（Windows 构建机）

| 组件 | 版本/路径 |
|---|---|
| JDK | Microsoft OpenJDK 17.0.20.1，`C:\jdk17\PFiles64\Microsoft\jdk-17.0.20.101-hotspot` |
| Android SDK | `C:\Android\Sdk`（platforms;android-34、build-tools;34.0.0、platform-tools） |
| Gradle | 8.10.2，解压于 `C:\gradle-8.10.2`（**不要用 wrapper 在线下载**，直接调本地 gradle） |
| Node | ≥ 18（项目开发机使用 Node 22） |
| 上传工具 | PuTTY 的 `pscp.exe` / `plink.exe`（`D:\Program Files\PuTTY\`） |

构建时环境变量：

```powershell
$env:JAVA_HOME = "C:\jdk17\PFiles64\Microsoft\jdk-17.0.20.101-hotspot"
$env:ANDROID_HOME = "C:\Android\Sdk"
$env:GRADLE_HOME = "C:\gradle-8.10.2"
$env:PATH = "$env:JAVA_HOME\bin;$env:GRADLE_HOME\bin;$env:PATH"
```

---

## 三、项目结构

```
mobile-app-rn/
├── package.json                 # 依赖清单（版本锁定见下表）
├── babel.config.js              # 含 reanimated/plugin + worklets-core/plugin
├── metro.config.js
├── tsconfig.json
├── index.js                     # 入口
├── src/
│   ├── api/                     # client.ts(fetch封装/401登出/响应解包) auth/assets/inventory
│   ├── store/                   # zustand + MMKV：authStore/settingsStore/assetStore/updateStore(自更新)
│   ├── theme/                   # colors(light/dark/black/tech) spacing ThemeProvider
│   ├── navigation/              # RootNavigator + MainTabBar（首页/资产/盘点/我的）
│   ├── screens/                 # Login/Home/AssetList/AssetDetail/AddAsset/
│   │                            # InventoryList/InventoryDetail/Scan/Settings
│   ├── components/              # AssetCard/StatCard/StatusBadge/SearchBar/FilterSheet/
│   │                            # UpdateGate(启动检查+挂载弹窗)/UpdateModal(更新弹窗)
│   ├── hooks/                   # useAssets/useAsset/useInventory/useScanner
│   ├── utils/                   # qrParser/format/apkUpdate(自更新原生桥接)
│   └── types/api.ts
└── android/
    ├── build.gradle              # root：apply com.facebook.react.rootproject，ext SDK/扫码开关
    ├── settings.gradle           # buildscript 引本地 gradle 插件 jar + apply com.facebook.react.settings
    ├── gradle.properties         # overridePathCheck/newArchEnabled=false/hermesEnabled=true
    ├── gradle-plugins/           # 预构建的 RN gradle 插件（3 个 jar，见 4.2）
    └── app/
        ├── build.gradle          # 手动 implementation project() 各原生模块；versionCode/versionName
        ├── build/generated/autolinking/autolinking.json   # 手动生成
        └── src/main/
            ├── AndroidManifest.xml                    # 含 REQUEST_INSTALL_PACKAGES + FileProvider
            ├── java/com/assetmanagement/mobile/
            │   ├── MainApplication.kt                 # 注册 ApkUpdatePackage
            │   ├── ApkUpdateModule.kt                 # 自更新原生模块（下载/SHA256/安装）
            │   └── ApkUpdatePackage.kt                # 原生模块包
            ├── res/xml/file_paths.xml                 # FileProvider 共享路径（缓存 updates/）
            ├── assets/index.android.bundle               # Metro 产物（离线 JS）
            └── assets/fonts/MaterialCommunityIcons.ttf   # 图标字体（必须打包！）
```

### 3.1 依赖版本锁定（勿随手升级）

| 包 | 锁定版本 | 原因 |
|---|---|---|
| react-native | 0.75.4 | 基础版本 |
| react-native-reanimated | 3.16.7 | ≥3.17 对旧架构/当前 Babel 组合有兼容问题 |
| react-native-gesture-handler | 2.18.1 | 配套 RN 0.75 |
| react-native-mmkv | **2.12.2** | 3.x 的 codegen 仅支持新架构，旧架构编译失败 |
| react-native-vision-camera | 4.7.3 | 扫码用 v4 原生 `useCodeScanner` |
| react-native-worklets-core | 1.6.3 | vision-camera 原生模块构建依赖 |
| react-native-vector-icons | 10.2.0 | 仅用 MaterialCommunityIcons 一个图标集 |
| @react-navigation/* | 6.x | Stack + Bottom Tabs |

### 3.2 RN Gradle 插件的特殊接法

RN 0.75 的 `com.facebook.react` 插件不发布到 Maven，官方方式是 `includeBuild('../node_modules/@react-native/gradle-plugin')`，但本机构建在该方式下卡死。现采用：

1. 预先在 `node_modules/@react-native/gradle-plugin` 执行 `gradle assemble` 构建出插件 jar；
2. 三个 jar 复制到 `android/gradle-plugins/`（`react-native-gradle-plugin.jar`、`settings-plugin.jar`、`shared.jar`）；
3. `settings.gradle` 的 buildscript classpath 引入 `settings-plugin.jar` + `gson`，apply `com.facebook.react.settings`；
4. root `build.gradle` 的 buildscript classpath 引入其余 jar，apply `com.facebook.react.rootproject`；
5. 不使用 `applyNativeModulesAppBuildGradle`，改为在 `app/build.gradle` **手动** `implementation project(':react-native-reanimated')` 等全部模块（避免与 autolinking 生成的 PackageList 重复注册）。

---

## 四、标准构建与发布流程

> 该流程已固化为 TRAE 技能 **`rn-apk-deploy`**（工作区 `.trae/skills/rn-apk-deploy/SKILL.md`）。对 AI 说"发布/热上传/更新 APK"即自动执行；以下为手工步骤。

### 4.1 四步出包

```powershell
# ① subst 映射：中文路径必须绕开（ninja/CMake 在中文路径下必失败）
subst R: "d:\Users\Administrator\Desktop\固定资产管理系统exe离线便携版v1.1\mobile-app-rn"

# ② 打 JS bundle —— 必须在【真实路径】执行（subst 盘上 Metro 无法计算 SHA-1）
cd "d:\Users\Administrator\Desktop\固定资产管理系统exe离线便携版v1.1\mobile-app-rn"
npx react-native bundle --platform android --dev false --entry-file index.js `
  --bundle-output android/app/src/main/assets/index.android.bundle `
  --assets-dest android/app/src/main/res
# 成功标志: info Done writing bundle output（bundle 约 2.2 MB）

# ③ Gradle 构建 —— 必须在 R: 盘执行
$env:JAVA_HOME = "C:\jdk17\PFiles64\Microsoft\jdk-17.0.20.101-hotspot"
$env:ANDROID_HOME = "C:\Android\Sdk"
$env:GRADLE_HOME = "C:\gradle-8.10.2"
$env:PATH = "$env:JAVA_HOME\bin;$env:GRADLE_HOME\bin;$env:PATH"
cd R:\android
gradle assembleDebug --no-daemon --console=plain
# 纯 JS 改动增量约 20~30 秒；动了原生配置/依赖全量 3~8 分钟

# ④ 上传部署
$pscp = "D:\Program Files\PuTTY\pscp.exe"; $plink = "D:\Program Files\PuTTY\plink.exe"; $pw = "<SSH密码>"
& $pscp -batch -pw $pw "R:\app\build\outputs\apk\debug\app-debug.apk" "hmt@192.168.40.247:/tmp/app-debug.apk"
& $plink -ssh -batch -pw $pw hmt@192.168.40.247 "echo <sudo密码> | sudo -S cp /tmp/app-debug.apk /opt/asset-server/downloads/asset-mgmt-rn-debug.apk && echo <sudo密码> | sudo -S chown asset:asset /opt/asset-server/downloads/asset-mgmt-rn-debug.apk && echo <sudo密码> | sudo -S chmod 644 /opt/asset-server/downloads/asset-mgmt-rn-debug.apk && rm /tmp/app-debug.apk"

# ⑤ 收尾：卸载 R 盘
subst R: /D
```

下载/安装：手机浏览器访问 `http://192.168.40.247/downloads/asset-mgmt-rn-debug.apk?v=N`（`?v=N` 递增以绕过浏览器缓存）。

> **v1.1.0 起**：发布新版还需同步上传 `apk-update.json`（versionCode 必须 +1），完整步骤见 **5.4 节**；仅替换 APK 不更新 JSON 时，已装新版的客户端不会收到更新提示。

### 4.2 新增/变更原生 npm 依赖后

```powershell
# 重新生成 autolinking 数据（settings 插件不会自动生成）
New-Item -ItemType Force -Directory android\build\generated\autolinking | Out-Null
npx react-native config --platform android > android/build/generated/autolinking/autolinking.json
# 若新模块未被自动 include：android/settings.gradle 手动 include，app/build.gradle 手动加 implementation project(':xxx')
```

### 4.3 重新 `npm install` 后必查的两个补丁（会被覆盖）

| 文件 | 补丁内容 |
|---|---|
| `node_modules/@react-native-community/cli-platform-android/native_modules.gradle` | `getCommandOutput()` 中先读 `process.inputStream.text` 再 `process.waitFor()`，否则 `node config` 输出撑满管道缓冲区时配置阶段**死锁** |
| `node_modules/@react-native/gradle-plugin/settings.gradle.kts` | 注释掉 `foojay-resolver-convention` 插件，否则 settings 阶段尝试联网下载 JDK toolchain 卡死 |

### 4.4 图标字体（极易漏）

`react-native-vector-icons/MaterialCommunityIcons` 的 ttf **不会自动进 APK**，必须手工放置：

```
node_modules/react-native-vector-icons/Fonts/MaterialCommunityIcons.ttf
  → android/app/src/main/assets/fonts/MaterialCommunityIcons.ttf
```

漏了的症状：所有图标显示为方框 □（豆腐块）。全项目 14 处图标引用均使用这一个图标集，一个文件全覆盖。

---

## 五、应用内自更新（v1.1.0 起）

> 与电脑端 EXE 自更新（见《EXE客户端发布更新流程.md》）对应的安卓实现：服务器零改动，复用 nginx 的 `/downloads/` 静态目录。

### 5.1 版本源文件

`http://192.168.40.247/downloads/apk-update.json`（**UTF-8 无 BOM**）：

```json
{
  "versionCode": 2,
  "versionName": "1.1.0",
  "url": "http://192.168.40.247/downloads/asset-mgmt-rn-debug.apk",
  "notes": "更新说明，支持 \\n 多行",
  "sha256": "APK 的 SHA-256（小写十六进制）",
  "publishedAt": "2026-09-13T14:50:00+08:00"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `versionCode` | ✅ | **唯一更新判定依据**：整数，严格大于客户端当前值才提示更新 |
| `versionName` | ✅ | 仅用于弹窗展示（如 1.1.0） |
| `url` | ✅ | APK 下载地址；绝对 URL，或 `/downloads/` 下的相对文件名（会按 App 内配置的服务器地址拼接） |
| `notes` |  | 更新说明，`\n` 分行，弹窗内逐行显示 |
| `sha256` |  | 小写十六进制；提供则下载后强制校验，不匹配则删除安装包并中止 |
| `publishedAt` |  | 发布时间，仅展示 |

### 5.2 客户端行为

- **静默检查**：App 启动 6 秒后自动请求一次 JSON（10 秒超时，任何失败直接忽略，不打扰用户）
- **手动检查**：「我的」→ 关于 →「检查更新」；无更新弹"已是最新版本"（显示双方 versionName/versionCode），失败弹错误原因
- **更新链路**：弹窗显示版本号与更新说明 →「立即更新」→ 原生线程下载（App 内进度条，事件约 5fps；先写 `updates/update.apk.download`，完成后 rename）→ SHA-256 流式校验 → Android 8+ 检查"安装未知应用"授权，未授权则跳系统设置页、**授权后返回 App 自动继续** → FileProvider（`com.assetmanagement.mobile.fileprovider`）+ `ACTION_VIEW` 调起系统安装器覆盖安装
- 下载文件存应用专属外部缓存（`外部缓存/updates/update.apk`），无需存储权限
- **失败安全**：网络失败/校验失败均保留旧版正常使用，弹窗可重试；临时文件自动清理

### 5.3 覆盖安装的两个硬性前提

1. **包名不变**：`com.assetmanagement.mobile`
2. **签名一致**：当前全部用 `android/app/debug.keystore`（同一文件，勿删勿换）。换签名会导致安装器拒绝更新，只能卸载重装。验证：
   ```powershell
   $env:JAVA_HOME = "C:\jdk17\PFiles64\Microsoft\jdk-17.0.20.101-hotspot"
   # aapt/apksigner 不支持中文路径，先把 APK 复制到 C:\Windows\Temp\ 再验
   apksigner verify --print-certs C:\Windows\Temp\xxx.apk   # 历次应为 CN=Android Debug
   aapt dump badging C:\Windows\Temp\xxx.apk | findstr package
   ```

### 5.4 发布新版本 App 的标准流程（以后照做）

```powershell
# ① 改版本号（两处）
#   android/app/build.gradle → versionCode 必须 +1（整数）、versionName 按语义化版本改
#   package.json → "version" 同步
# ② 出包：bundle（真实路径）→ gradle assembleDebug（R 盘），见 4.1 ①~③
# ③ 计算哈希（中文路径不影响 Get-FileHash）
(Get-FileHash "d:\...\android\app\build\outputs\apk\debug\app-debug.apk" -Algorithm SHA256).Hash.ToLower()
# ④ 用无 BOM UTF-8 写 C:\Windows\Temp\apk-update.json（内容按 5.1 模板，versionCode/versionName/sha256/notes 换新值）
[System.IO.File]::WriteAllText('C:\Windows\Temp\apk-update.json', $json, [System.Text.UTF8Encoding]::new($false))
# ⑤ 上传 + sudo 就位（APK 固定文件名 asset-mgmt-rn-debug.apk，JSON 固定名 apk-update.json）
$pscp = "D:\Program Files\PuTTY\pscp.exe"; $plink = "D:\Program Files\PuTTY\plink.exe"; $pw = "<SSH密码>"
$apk = "d:\Users\Administrator\Desktop\固定资产管理系统exe离线便携版v1.1\mobile-app-rn\android\app\build\outputs\apk\debug\app-debug.apk"
& $pscp -batch -pw $pw $apk "hmt@192.168.40.247:/tmp/app-debug.apk"
& $pscp -batch -pw $pw C:\Windows\Temp\apk-update.json "hmt@192.168.40.247:/tmp/apk-update.json"
& $plink -ssh -batch -pw $pw hmt@192.168.40.247 "echo <sudo密码> | sudo -S sh -c 'cp /tmp/app-debug.apk /opt/asset-server/downloads/asset-mgmt-rn-debug.apk && cp /tmp/apk-update.json /opt/asset-server/downloads/apk-update.json && chown asset:asset /opt/asset-server/downloads/asset-mgmt-rn-debug.apk /opt/asset-server/downloads/apk-update.json && chmod 644 /opt/asset-server/downloads/asset-mgmt-rn-debug.apk /opt/asset-server/downloads/apk-update.json && rm -f /tmp/app-debug.apk /tmp/apk-update.json'"
# ⑥ 验证：HTTP 200 + 服务器哈希与本地一致
#    注意 PowerShell 的 Invoke-WebRequest .Content 可能按非 UTF-8 解码显示中文乱码（假乱码），
#    要用 RawContentStream 取字节再 [System.Text.Encoding]::UTF8.GetString 验证
& $plink -ssh -batch -pw $pw hmt@192.168.40.247 "sha256sum /opt/asset-server/downloads/asset-mgmt-rn-debug.apk"
Invoke-WebRequest -Method Head "http://192.168.40.247/downloads/asset-mgmt-rn-debug.apk" -UseBasicParsing
# ⑦ 手机验证：旧版 App 启动 6 秒自动弹更新（或"我的→检查更新"）→ 下载 → 授权未知来源 → 安装 → 打开确认版本号
# ⑧ subst R: /D；git 提交
```

> 紧急撤回：JSON 改回当前线上版本号即可阻止尚未升级的客户端更新；**已升级的无法降级**，只能发更高 versionCode 的新版本。

### 5.5 故障排查

| 现象 | 原因/处理 |
|---|---|
| 启动不弹窗、手动检查报网络错 | 手机与服务器网络不通；App 内"服务器"地址是否正确；浏览器能否打开 `http://192.168.40.247/downloads/apk-update.json` |
| 手动检查提示"已是最新"但确有新版 | JSON 的 `versionCode` 没有大于客户端（判定只认 versionCode，与 versionName 无关） |
| 更新说明中文乱码 | JSON 被写成带 BOM 或非 UTF-8；用 `[System.IO.File]::WriteAllText` + `UTF8Encoding($false)` 重写 |
| 下载到一半失败 | 内网不稳/锁屏断网；弹窗点「重试」会重新下载（当前不支持断点续传），临时文件自动覆盖 |
| 弹"需要授权"后跳设置 | Android 8+ 正常首装流程；在系统设置允许本应用"安装未知应用"，**返回 App 自动调起安装器**（小米/华为等入口文案略有差异） |
| 安装器提示"无法安装/软件包无效" | versionCode 未递增、签名不一致（换过 keystore）、或 APK 上传损坏（核对 sha256） |
| SHA256 不匹配 | 先传 APK 后传 JSON 或两者不配套；重新 `Get-FileHash` 并更新 JSON 后重传 |

---

## 六、何时需要重新构建 APK

| 改动内容 | 要重新构建？ |
|---|---|
| `mobile-app-rn/src/**` 任意 TS/TSX、`index.js`、babel/metro 配置 | **要**（重新 bundle + 增量构建，说"发布"即可） |
| 新增/升级 RN 原生依赖、`android/**` 原生配置、权限 | **要**（可能全量构建） |
| 服务端 `server/src/**`、Web 端 `index.html`/`js/**`（如飞书配置页） | **不要**，App 内不含这些页面 |
| 只改服务器地址/端口 | 不要（App 内可在"设置"页切换服务器） |

---

## 七、踩坑记录（2026-09 构建过程全部问题）

| # | 现象 | 根因 | 解决 |
|---|---|---|---|
| 1 | Gradle wrapper 下载 dist 卡死 | services.gradle.org 国内不可达 | 手动下载 gradle-8.10.2 解压 `C:\gradle-8.10.2`，直接调本地 gradle |
| 2 | `includeBuild(gradle-plugin)` 构建卡死 | includeBuild 组合 + foojay 联网 | 预构建插件 jar 放 `android/gradle-plugins/`，buildscript classpath 引入；注释 foojay |
| 3 | 配置阶段死锁（无输出挂起） | native_modules.gradle 先 waitFor 后读管道，管道缓冲满 | 交换为先读 inputStream 再 waitFor（见 4.3） |
| 4 | `:react-native-mmkv` 报 compileSdkVersion 未指定 | 插件未通过 settings 插件统一配置 | settings.gradle apply `com.facebook.react.settings` + root build.gradle ext 声明 SDK |
| 5 | settings.gradle 报 `Unexpected character: '?'` | PowerShell 写文件带 BOM | `[System.IO.File]::WriteAllText(path, text, UTF8Encoding($false))` 无 BOM 写入 |
| 6 | mmkv 3.x 编译失败（codegen 相关） | 3.x 仅支持新架构 | 降到 mmkv 2.12.2 |
| 7 | ninja/CMake `No such file or directory`（路径乱码） | reanimated/worklets C++ 构建不支持中文路径 | `subst R:` 映射后在 R 盘构建 |
| 8 | Metro 报 `SHA-1 for file R:\index.js is not computed` | bundle 在 subst 盘执行 | bundle 回真实路径执行 |
| 9 | 登录报 `MMKV::set: 'value' argument is not of type...` | 后端响应为 `{code:0,data:{...}}`，client 只识别 `success` 未剥 `data.data`，token 为 undefined 写入 MMKV | client.ts 兼容 `success` 与 `code:0/200` 两种包装统一解包；authStore 加 token 类型防御 |
| 10 | 登录成功后崩 `Property 'MainTabs' doesn't exist` | RootNavigator 把 MainTabBar 错写成 MainTabs | 改为 `component={MainTabBar}` |
| 11 | 盘点列表首次打开报错 | 本地无盘点数据时接口 404 | inventory.ts 对 404 容错为空数组 |
| 12 | 相机页显示"未找到后置摄像头" | vision-camera v4 的 `useCameraDevices()` 返回数组而非 `{back}` | 改用 `useCameraDevice('back')` |
| 13 | `Frame Processor Error: Cannot read property 'QR_CODE' of undefined` | v4 已移除 frame processor 式 scanBarcodes/BarcodeFormat | 改用 `useCodeScanner({codeTypes, onCodeScanned})` + Camera 的 `codeScanner` 属性；root build.gradle ext 设 `VisionCamera_enableCodeScanner=true`（自动打包 MLKit 模型）；babel 注册 worklets-core/plugin |
| 14 | 所有图标显示方框 □ | MaterialCommunityIcons.ttf 未打包 | 字体放入 `android/app/src/main/assets/fonts/`（见 4.4） |
| 15 | 扫码对准后连续重复计数 | MLKit 持续回调，旧防抖方案体验差 | 交互改为：扫到一个码立即暂停相机 → 底部弹资产信息卡 → 人工点「确认盘点」才标记已盘并恢复；useScanner 移除防抖 |
| 16 | aapt/apksigner 报 `Unable to open ... Illegal byte sequence` | Android build-tools 的 ANSI 路径处理不支持中文路径 | 把 APK 复制到 `C:\Windows\Temp\xxx.apk` 等纯 ASCII 路径再验版/验签 |
| 17 | `Invoke-WebRequest` 读 apk-update.json 中文全乱码 | PowerShell 按响应默认编码解码，控制台显示为 Latin-1 假乱码，文件本身是好的 | 用 `.RawContentStream.ToArray()` 取字节后 `[System.Text.Encoding]::UTF8.GetString()` 验证；Android `Response.json()` 按 UTF-8 解析不受影响 |
| 18 | 自更新版本比较口径易错 | 以 versionCode（整数）为唯一判定，versionName 只展示 | JSON `versionCode` 必须是 number 且严格递增；排查"不提示更新"先查它，别查 versionName |

### 扫码交互约定（ScanScreen）

扫码盘点为"**一码一确认**"模式：扫到二维码 → 震动 + 暂停相机 → 弹出资产卡片（编号/型号/类别/使用人/部门/地点/备注）→「确认盘点」写入状态（二次震动）并继续，或「继续扫码」跳过；无效码/不在盘点范围/已盘点均有对应弹窗（已盘点不显示确认按钮）。

---

## 八、构建发布记录

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-09-12 | v1 | RN 工程首包：四 Tab、登录、资产、盘点、设置；解决插件/死锁/中文路径等构建链问题（约 179 MB） |
| 2026-09-12 | v2 | 修复登录响应解包（MMKV 类型错误）、盘点 404 容错 |
| 2026-09-12 | v3 | 修复 MainTabs 导航崩溃 |
| 2026-09-12 | v4 | 修复后置摄像头找不到（useCameraDevice v4 API）+ worklets babel 插件 |
| 2026-09-12 | v5 | 改用 v4 原生 MLKit 扫码（useCodeScanner + enableCodeScanner），APK 增至约 200 MB |
| 2026-09-12 | v6 | 扫码改"一码一确认"弹窗模式 |
| 2026-09-12 | v7 | 无代码变更，全流程重出包（验证发布技能） |
| 2026-09-12 | v8 | 打包 MaterialCommunityIcons.ttf，修复全部图标方框 |
| 2026-09-13 | **v1.1.0**（versionCode 2） | **新增应用内自更新**：原生 `ApkUpdateModule`（下载进度事件/SHA-256 校验/未知来源授权/FileProvider 安装）；JS 端 `apkUpdate.ts`+`updateStore`+`UpdateModal/UpdateGate`；启动 6 秒静默检查 + "我的→检查更新"；版本源 `/downloads/apk-update.json`；APK 199.8 MB，SHA256 `375abd497b37…`。**v1.0.0 旧客户端无更新器，需手动覆盖安装这一次，之后版本均应用内更新** |

> 服务器 nginx 需配置 `/downloads/` 静态目录（`alias /opt/asset-server/downloads/; autoindex on;`），否则访问目录 404（直链不受影响）。

---

## 九、待办/已知限制

- 当前仅 **Debug 签名**（`android/app/debug.keystore`）；正式分发需生成专属 keystore 并配置 release signingConfig + ProGuard（**注意：一旦换签名，已分发客户端将无法应用内更新，只能卸载重装**）
- 未做 iOS 工程
- 服务器地址在"设置"页手动切换；首次默认 `http://192.168.40.247`
- v1.0.0（versionCode 1）之前的安装不含更新器，须手动安装一次 v1.1.0+；自更新下载不支持断点续传（失败重新下载），下载时建议保持 App 在前台
- 盘点明细依赖接口分页与本地合并；大批量资产下的性能优化待验证
