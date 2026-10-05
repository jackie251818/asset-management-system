# iOS 构建交接文档

> 本文档面向 **macOS 环境下的 AI/开发者**，用于在已有 React Native（仅 Android）工程基础上，从零生成 iOS 工程并完成首次构建、签名、TestFlight 分发。
>
> 创建时间：2026-09-15
> 现有 Android 版本：v1.1.0（versionCode 2）
> React Native：0.75.4（旧架构 Paper + Hermes，`newArchEnabled=false`）

---

## 一、项目背景速读

| 项 | 值 |
|---|---|
| 产品名 | 固定资产管理（原生移动版） |
| 仓库根目录 | `d:\Users\Administrator\Desktop\固定资产管理系统exe离线便携版v1.1\`（Windows 路径，macOS 上对应克隆后的路径） |
| RN 工程目录 | `mobile-app-rn/` |
| 当前已支持平台 | 仅 Android（`mobile-app-rn/android/`） |
| iOS 工程状态 | **不存在**，需用 `npx react-native expunge --platforms ios` 从零生成 |
| 服务器 | `http://192.168.40.247`（内网 HTTP 明文，iOS 需 ATS 例外） |
| 数据形态 | 远程 HTTP API（React Native fetch），本地零业务数据 |
| 现有发版机制 | Android 应用内自更新（`/downloads/apk-update.json` + `ApkUpdateModule.kt`） |
| iOS 发版目标 | TestFlight 测试分发 + 服务器侧 `ios-update.json` 跳转 TestFlight |

### 架构要点（避免 AI 误改）

1. **App 内不含任何业务 HTML**：纯 React Native 原生组件，JS bundle 打包进 .app/.ipa。改 JS 后必须重新构建，无 WebView 热更新。
2. **服务器是唯一数据源**：API 走 `useSettingsStore.serverUrl` + JWT Bearer；App 内仅在"设置"页切换服务器地址，无内置地址硬编码。
3. **应用内自更新必须平台分支**：iOS 沙箱禁止应用内安装 .ipa，当前 `ApkUpdateModule.kt` 仅 Android 原生实现，iOS 需替换为 TestFlight 跳转。

---

## 二、macOS 构建环境清单

### 2.1 必装组件

| 组件 | 版本 | 安装命令 |
|---|---|---|
| macOS | 13.6+（Ventura/Sonoma） | — |
| Xcode | 15.4+ | App Store 安装，含 iOS 17.4+ Simulator |
| Command Line Tools | 15.4+ | `xcode-select --install` |
| CocoaPods | 1.15+ | `sudo gem install cocoapods` 或 `brew install cocoapods` |
| Node | ≥ 18（推荐 20 LTS） | `brew install node@20` |
| Watchman | 2024.01+ | `brew install watchman` |
| Yarn（可选） | 1.22+ | `brew install yarn` |

### 2.2 Apple Developer 账号

| 项 | 说明 |
|---|---|
| 账号类型 | 个人 / 公司（$99/年） |
| 用途 | 开发签名（Debug 真机）+ TestFlight 分发 |
| Team ID | 在 `developer.apple.com → Membership` 查看（格式如 `ABCD1234XY`） |
| Bundle ID | `com.assetmanagement.mobile`（与 Android applicationId 对齐，确保跨平台身份一致） |
| TestFlight | 需在 App Store Connect 创建 App 后上传构建 |

### 2.3 环境校验命令

```bash
xcodebuild -version          # 应输出 Xcode 15.4+
pod --version                # 应输出 1.15+
node --version               # 应输出 v18+
npx react-native --version   # 应输出 0.75.4
xcrun simctl list devices    # 列出可用模拟器
```

---

## 三、依赖版本锁定（与 Android 对齐，勿随意升级）

| 包 | 锁定版本 | 原因 |
|---|---|---|
| react-native | 0.75.4 | 基础版本，旧架构 Paper |
| react | 18.3.1 | 配套 RN 0.75 |
| react-native-reanimated | 3.16.7 | ≥3.17 对旧架构有兼容问题 |
| react-native-gesture-handler | 2.18.1 | 配套 RN 0.75 |
| react-native-mmkv | **2.12.2** | 3.x 仅支持新架构 |
| react-native-vision-camera | 4.6.1 | iOS 走 AVFoundation，无需 MLKit |
| react-native-worklets-core | 1.6.3 | VisionCamera 依赖 |
| react-native-vector-icons | 10.2.0 | 仅用 MaterialCommunityIcons 一个图标集 |
| react-native-permissions | 4.1.5 | iOS 需在 Podfile 启用子模块 |
| react-native-screens | 3.34.0 | — |
| react-native-safe-area-context | 4.11.0 | — |
| react-native-svg | 15.7.1 | — |
| @react-navigation/* | 6.x | Stack + Bottom Tabs |
| @tanstack/react-query | 5.56.2 | — |
| zustand | 4.5.5 | — |

完整版本见 [mobile-app-rn/package.json](../mobile-app-rn/package.json)。

---

## 四、iOS 工程从零生成（标准流程）

### 4.1 准备 RN 工程

```bash
# 假设项目克隆到 ~/Projects/asset-mgmt/
cd ~/Projects/asset-mgmt/mobile-app-rn

# 安装依赖（与 Windows 端使用同一份 package-lock.json，保证版本一致）
npm ci
```

### 4.2 生成 ios/ 目录

RN 0.75 官方方式，`--platforms ios` 限定仅生成 iOS 不动 android：

```bash
npx react-native expunge --platforms ios
```

**产物**：
```
mobile-app-rn/
└── ios/
    ├── Podfile                   # CocoaPods 依赖配置
    ├── AssetMgmtRn.xcworkspace   # Xcode 工作区
    ├── AssetMgmtRn/              # 主工程目录
    │   ├── Info.plist
    │   ├── main.m                # 入口
    │   ├── AppDelegate.h / .mm
    │   └── LaunchScreen.storyboard
    └── AssetMgmtRnTests/
```

### 4.3 修改 Bundle ID 与 App 名

在 Xcode 打开 `ios/AssetMgmtRn.xcworkspace`：

1. 左侧选 `AssetMgmtRn` 项目 → `TARGETS → AssetMgmtRn → General`
2. **Bundle Identifier**：`com.assetmanagement.mobile`
3. **Display Name**：`固定资产管理`
4. **Version**（CFBundleShortVersionString）：`1.1.0`
5. **Build**（CFBundleVersion）：`2`（与 Android versionCode 对齐，后续每次发版递增）

### 4.4 配置证书与描述文件（签名）

iOS 签名链由三要素组成：**Certificate（证书）+ App ID（Bundle ID）+ Provisioning Profile（描述文件）**。下面分别给出自动签名（推荐）与手动签名（备选）两条路径。

#### 4.4.1 Apple Developer 账号准备

| 项 | 说明 |
|---|---|
| 账号类型 | 个人 / 公司（$99/年） |
| 登录入口 | `https://developer.apple.com/account`（用 Apple ID 登录） |
| 后台入口 | `https://developer.apple.com/account/resources/certificates/list`（Certificates, Identifiers & Profiles） |
| Team ID | 在 `Membership → Membership Details` 查看（格式如 `ABCD1234XY`） |

> 个人账号与公司账号区别：个人账号的 App Store 上架显示个人姓名；公司账号需提交 D-U-N-S 编号审核后才能用于公司主体上架。**本项目内网分发用个人账号即可**。

#### 4.4.2 生成 CSR（证书签名请求）

每个证书都需要一份 CSR 文件。Mac 上两种方式：

**方式 A：钥匙串访问 GUI（推荐）**

1. 打开"钥匙串访问"（Launchpad → 其他 → 钥匙串访问）
2. 菜单栏：钥匙串访问 → 证书助理 → 从证书颁发机构请求证书…
3. 填写：
   - **用户电子邮件**：你的 Apple ID
   - **常用名称**：`AssetMgmt CSR`（任意，便于识别）
   - **CA 电子邮件**：留空或填 Apple ID
   - **存储到磁盘**：✅
4. 保存为 `AssetMgmtCSR.certSigningRequest`（路径如 `~/Desktop/`）

**方式 B：命令行 openssl**

```bash
# 1. 生成私钥
openssl genrsa -out assetmgmt.key 2048

# 2. 用私钥生成 CSR
openssl req -new -key assetmgmt.key -out AssetMgmtCSR.certSigningRequest \
  -subj "/emailAddress=your-apple-id@example.com/CN=AssetMgmt CSR/C=CN"

# 私钥妥善保存，后续导出 .p12 时需要
```

> **CSR 与私钥是后续所有证书的根**，丢失则无法续期同名证书，需重新生成全套。

#### 4.4.3 创建开发证书（iOS Development）

用于 Debug 真机调试，**仅开发期需要**。

1. 浏览器登录 `https://developer.apple.com/account/resources/certificates/add`
2. 选 **iOS App Development** → Continue
3. 上传 4.4.2 生成的 `AssetMgmtCSR.certSigningRequest` → Continue
4. 下载 `ios_development.cer` → 双击文件 → 自动导入"钥匙串访问"的"登录"钥匙串

> 同一 CSR 可签发多个证书，但建议一个项目一份证书便于管理。

#### 4.4.4 创建分发证书（App Store Distribution）

用于 Archive → TestFlight / App Store 上传，**正式发版必需**。

1. 同上入口 → 选 **App Store and Ad Hoc** → Continue
2. 上传**同一份** `AssetMgmtCSR.certSigningRequest` → Continue
3. 下载 `ios_distribution.cer` → 双击导入钥匙串

> 开发证书与分发证书可共存于同一钥匙串，Xcode 会按构建类型（Debug/Release）自动选择。

#### 4.4.5 注册 App ID（Bundle ID）

1. 浏览器登录 `https://developer.apple.com/account/resources/identifiers/add`
2. 选 **App IDs** → Continue
3. 填写：
   - **Description**：`Asset Management Mobile`
   - **Bundle ID**：Explicit（非 Wildcard）→ `com.assetmanagement.mobile`
4. Capabilities 勾选（本项目仅需）：
   - ✅ 不需要额外勾选任何 Capability（无 Push/In-App Purchase/Sign in with Apple 等需求）
5. Continue → Register

> Bundle ID 一旦注册不可改名，必须与 Android applicationId 完全一致（`com.assetmanagement.mobile`）。

#### 4.4.6 注册测试设备（仅开发期）

**真机调试前必须把 iPhone 的 UDID 注册到 Apple 后台**。TestFlight 分发不需要此步骤。

1. iPhone 连 Mac → 打开 Xcode → Window → Devices and Simulators → 选设备 → 复制 **Identifier**（即 UDID，40 位十六进制）
2. 浏览器 `https://developer.apple.com/account/resources/devices/add`
3. 选 **iOS App Development (Development)** → Continue
4. 填写：
   - **Name**：`iPhone-001`（任意易识别名）
   - **Device ID (UDID)**：粘贴刚复制的
5. Continue → Register

> 个人账号最多注册 100 台设备/年。

#### 4.4.7 创建描述文件（Provisioning Profile）

描述文件把"证书 + App ID + 设备"绑定为一个文件，Xcode 构建时读取。

**开发描述文件（Development Provisioning）**：

1. 浏览器 `https://developer.apple.com/account/resources/profiles/add`
2. 选 **iOS App Development** → Continue
3. **App ID**：选 `com.assetmanagement.mobile` → Continue
4. **Certificate**：勾选 4.4.3 的开发证书 → Continue
5. **Devices**：勾选 4.4.6 注册的 iPhone → Continue
6. **Profile Name**：`AssetMgmt_Dev_Profile` → Generate
7. 下载 `AssetMgmt_Dev_Profile.mobileprovision` → 双击导入 Xcode

**分发描述文件（App Store Provisioning）**：

1. 同入口 → 选 **App Store** → Continue
2. **App ID**：选 `com.assetmanagement.mobile` → Continue
3. **Certificate**：勾选 4.4.4 的分发证书 → Continue
4. **Profile Name**：`AssetMgmt_Dist_Profile` → Generate
5. 下载 `AssetMgmt_Dist_Profile.mobileprovision` → 双击导入 Xcode

> 分发 Profile 不需要选设备（App Store / TestFlight 分发给任意用户）。

#### 4.4.8 在 Xcode 中配置签名

打开 `ios/AssetMgmtRn.xcworkspace`，左侧选 `AssetMgmtRn` 项目 → `TARGETS → AssetMgmtRn → Signing & Capabilities`：

**推荐：自动签名（开发期最省事）**

```text
Automatically manage signing  ✅
Team                          [你的 Apple Developer Team]
Bundle Identifier             com.assetmanagement.mobile
Provisioning Profile          Xcode Managed Profile
```

自动签名下，Xcode 会自动创建/续期证书与 Profile，无需手工维护。首次构建真机会自动注册设备 UDID 到 Apple 后台。

**备选：手动签名（CI/CD 或自动签名失败时）**

```text
Automatically manage signing  ☐
Debug      →  Signing Certificate:  iOS Developer
              Provisioning Profile:  AssetMgmt_Dev_Profile
Release    →  Signing Certificate:  iOS Distribution
              Provisioning Profile:  AssetMgmt_Dist_Profile
```

手动模式下，每次证书过期需重新生成 .cer + .mobileprovision 并重新导入。

#### 4.4.9 导出 .p12 备份（用于多 Mac 共用签名）

私钥只存在于生成 CSR 的那台 Mac 上。若要在第二台 Mac（如 CI 服务器）上签名，必须导出 .p12：

1. 钥匙串访问 → "登录"钥匙串 → 证书分类
2. 找到 **iOS Development: 你的名字**（开发证书）→ 展开 → 选中私钥（小三角下方）
3. 右键 → 导出"你的私钥"
4. 保存为 `AssetMgmt_Dev.p12`，设置密码（导入时需要）
5. 分发证书同理导出 `AssetMgmt_Dist.p12`

第二台 Mac：双击 .p12 → 输密码 → 私钥+证书一起导入"登录"钥匙串 → 再双击 .mobileprovision 导入 Profile。

> **.p12 + .mobileprovision 是完整的签名身份**，等同于代码签名权。**严禁提交到 git 仓库**，建议存放在 1Password / 加密 USB。

#### 4.4.10 证书有效期与续期

| 证书类型 | 有效期 | 到期处理 |
|---|---|---|
| 开发证书（Development） | 1 年 | 自动签名下 Xcode 自动续期；手动需重复 4.4.3 + 4.4.7 重新生成 |
| 分发证书（Distribution） | 1 年 | 同上 |
| 开发 Profile | 1 年（或证书到期日，取早） | 自动续期或手工重生成 |
| 分发 Profile | 1 年 | 同上 |
| App ID | 永久（除非主动删除） | — |
| 设备注册 | 1 年内不可移除 | 每年续费日重置额度 |

> 证书到期后已发布的 App **不影响继续运行**，仅无法再构建新版本。

#### 4.4.11 故障速查

| 现象 | 原因/处理 |
|---|---|
| "iPhone is not available" / "Developer mode disabled" | iOS 16+ 真机需在"设置 → 隐私与安全性 → 开发者模式"启用 |
| "Could not launch app, You have not agreed to the user agreement" | Apple 后台待接受协议，登录 `developer.apple.com → Agreements` 接受 |
| "Failed to register bundle identifier ... is not available" | Bundle ID 已被他人占用；或被你账号其他 App 占用，换名或删除冲突 App |
| 签名红错 "Provisioning profile doesn't include device" | 4.4.6 设备未注册；或 Profile 未勾选该设备 → 编辑 Profile 重新勾选设备 |
| "No profiles for com.assetmanagement.mobile were found" | 4.4.7 Profile 未创建/未导入 → 双击 .mobileprovision 重新导入 |
| "Code Sign error: Provisioning profile has expired" | Profile 过期，重生成并导入 |
| "The certificate used to sign the application has been revoked" | 证书被吊销（可能账号欠费），登录 Apple 后台查看 |
| 真机安装后闪退 "Untrusted Developer" | 设置 → 通用 → VPN与设备管理 → 信任你的开发者证书 |
| 上传 TestFlight 报 "No suitable application record found" | App Store Connect 未创建 App；先在 `appstoreconnect.apple.com → 我的 App → + 新 App` |
| 上传报 "Bundle Identifier differs from reserved" | App Store Connect 里的 Bundle ID 与 Xcode 不一致，核对两处都为 `com.assetmanagement.mobile` |

### 4.5 安装 Pods

```bash
cd ios
pod install
cd ..
```

> `pod install` 后**必须用 .xcworkspace 打开**，不要用 .xcodeproj。

### 4.6 首次跑通 Debug（模拟器）

```bash
# 方式一：命令行
npx react-native run-ios

# 方式二：指定模拟器
npx react-native run-ios --simulator="iPhone 15"

# 方式三：Xcode 直接 Run
open ios/AssetMgmtRn.xcworkspace
# 选模拟器 → Cmd+R
```

**预期**：App 启动 → 显示登录页 → 输入服务器地址 `http://192.168.40.247` + 账号 `admin/admin123` → 进入首页。

---

## 五、iOS 必改的配置项（Info.plist）

打开 `ios/AssetMgmtRn/Info.plist`，源码视图修改：

### 5.1 相机权限（扫码必需，缺则扫码时闪退）

```xml
<key>NSCameraUsageDescription</key>
<string>扫描资产二维码进行盘点</string>
```

### 5.2 App Transport Security（连内网 HTTP 必需）

iOS 默认禁止 HTTP 明文。**开发期**用全开例外，**正式发版**建议改白名单：

```xml
<!-- 方式 A：全开（仅开发期） -->
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsArbitraryLoads</key>
  <true/>
</dict>

<!-- 方式 B：白名单（正式发版推荐，避免 App Store 审核风险） -->
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSExceptionDomains</key>
  <dict>
    <key>192.168.40.247</key>
    <dict>
      <key>NSExceptionAllowsInsecureHTTPLoads</key><true/>
      <key>NSIncludesSubdomains</key><true/>
    </dict>
  </dict>
</dict>
```

> **App Store 审核注意**：全开 `NSAllowsArbitraryLoads` 在审核可能被拒，需在审核备注解释"内网部署，无 HTTPS 能力"。**长期建议服务器加 HTTPS**。

### 5.3 字体注册（MaterialCommunityIcons 必需）

```xml
<key>UIAppFonts</key>
<array>
  <string>MaterialCommunityIcons.ttf</string>
</array>
```

字体文件需放置到 iOS 资源目录：

```bash
cp node_modules/react-native-vector-icons/Fonts/MaterialCommunityIcons.ttf ios/AssetMgmtRn/
```

然后在 Xcode 中：`File → Add Files to "AssetMgmtRn"` → 选 `MaterialCommunityIcons.ttf` → 勾选 **Add to target: AssetMgmtRn**。

### 5.4 LaunchScreen 配置（避免黑屏）

打开 `ios/AssetMgmtRn/LaunchScreen.storyboard`，加一个居中文本"固定资产管理"或 Logo 图片，确保启动不黑屏。

---

## 六、iOS 必改的代码点（平台分支）

### 6.1 自更新模块（必须改，否则 iOS 无更新入口）

**当前 Android 实现**（`mobile-app-rn/src/utils/apkUpdate.ts`）通过 `NativeModules.ApkUpdate` 调用 `ApkUpdateModule.kt` 下载并安装 APK，iOS 无对应原生模块。

**改造方案**：新建 `src/utils/appUpdate.ts`，平台分支：

```typescript
// src/utils/appUpdate.ts（重命名，去掉 Apk 前缀，统一入口）
import { NativeModules, Platform, Linking, Alert } from 'react-native';

export interface UpdateInfo {
  versionName: string;
  versionCode: number;       // Android 用
  bundleVersion: number;    // iOS 用（CFBundleVersion）
  url: string;              // Android: APK URL；iOS: TestFlight 链接
  notes?: string;
  sha256?: string;          // 仅 Android 校验
  publishedAt?: string;
}

export const appUpdateSupported = true; // 两端都支持

function serverOrigin(): string {
  // 复用 settingsStore
  const { useSettingsStore } = require('../store/settingsStore');
  return (useSettingsStore.getState().serverUrl || 'http://192.168.40.247').replace(/\/+$/, '');
}

export async function fetchUpdateInfo(signal?: AbortSignal): Promise<UpdateInfo | null> {
  const file = Platform.OS === 'ios' ? 'ios-update.json' : 'apk-update.json';
  const resp = await fetch(`${serverOrigin()}/downloads/${file}?ts=${Date.now()}`, { method: 'GET', signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const j = await resp.json();
  if (!j || typeof j.versionName !== 'string') return null;
  return j as UpdateInfo;
}

export async function getCurrentVersion(): Promise<{ versionName: string; versionCode: number }> {
  if (Platform.OS === 'ios') {
    // iOS: 读 Info.plist
    const { PlatformConstants } = NativeModules;
    const ver = PlatformConstants?.InfoDictionaryVersion || '1.1.0';
    const build = PlatformConstants?.CFBundleVersion || 2;
    return { versionName: String(ver), versionCode: Number(build) };
  }
  // Android: 原生模块
  return await NativeModules.ApkUpdate.getVersion();
}

export function hasUpdate(current: number, info: UpdateInfo): boolean {
  const target = Platform.OS === 'ios' ? info.bundleVersion : info.versionCode;
  return target > current;
}

/** 触发更新：iOS 跳 TestFlight，Android 调起安装器 */
export async function startUpdate(info: UpdateInfo): Promise<void> {
  if (Platform.OS === 'ios') {
    // info.url 存 TestFlight 公开邀请链接
    const ok = await Linking.canOpenURL(info.url);
    if (ok) {
      await Linking.openURL(info.url);
    } else {
      Alert.alert('无法打开', '请手动在 TestFlight App 中输入邀请码');
    }
    return;
  }
  // Android 走原有 downloadApk + installApk 逻辑（见现有 apkUpdate.ts）
  // 此处保留对旧 NativeModules.ApkUpdate 的调用
}
```

### 6.2 引用更新点（全局搜索替换）

| 文件 | 当前引用 | 改为 |
|---|---|---|
| `src/components/UpdateGate.tsx` | `import { apkUpdateSupported } from '../utils/apkUpdate'` | `import { appUpdateSupported } from '../utils/appUpdate'` |
| `src/components/UpdateModal.tsx` | 全部 `apkUpdate.*` 函数 | 改为 `appUpdate.ts` 的统一 API；iOS 分支跳 TestFlight |
| `src/store/updateStore.ts` | `import { apkUpdateSupported, ... } from '../utils/apkUpdate'` | 改为 `appUpdate`；`check()` 内部用 `getCurrentVersion()` 统一接口 |
| `src/screens/SettingsScreen.tsx` | `import { apkUpdateSupported, getCurrentVersion } from '../utils/apkUpdate'` | 改为 `appUpdate` |

### 6.3 UpdateModal UI 平台分支

`src/components/UpdateModal.tsx` 的"立即更新"按钮：
- Android：现有下载 + 进度条 + 安装流程
- iOS：直接调 `Linking.openURL(info.url)` 跳 TestFlight，显示"在 TestFlight 中打开 → 安装更新"

### 6.4 权限请求（iOS 配置）

`react-native-permissions` 在 iOS 需在 `ios/Podfile` 启用子模块：

```ruby
permissions_path = '../node_modules/react-native-permissions/ios/react-native-permissions.podspec'

target 'AssetMgmtRn' do
  # ... 其他 Pod 配置

  permissions_path = '../node_modules/react-native-permissions/ios'
  pod 'Permission-Camera', :path => "#{permissions_path}/Camera"
end
```

### 6.5 VisionCamera iOS 扫码

iOS 上 `react-native-vision-camera@4` 走 AVFoundation，API 与 Android 一致（`useCodeScanner`），无需改 JS 代码。但需在 `ios/Podfile` 确保：

```ruby
# 根 build.gradle 的 VisionCamera_enableCodeScanner=true 对应的 iOS 配置
# VisionCamera v4 在 iOS 自动启用 codeScanner，无需额外开关
```

---

## 七、服务器端配置（新增 ios-update.json）

### 7.1 nginx 配置

生产服务器 `192.168.40.247` 的 nginx 已有 `/downloads/` 别名（指向 `/opt/asset-server/downloads/`），iOS 版本源文件直接放此目录，无需改 nginx 配置。

### 7.2 ios-update.json 模板

新建 `server/deploy/downloads/ios-update.json.template`：

```json
{
  "versionName": "1.1.0",
  "bundleVersion": 2,
  "url": "https://testflight.apple.com/join/XXXXX",
  "notes": "【新增】一行一个要点，支持 \\n 分行",
  "publishedAt": "2026-09-15T15:00:00+08:00"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `versionName` | ✅ | 语义化版本，弹窗展示用 |
| `bundleVersion` | ✅ | **唯一更新判定依据**：整数，对应 Info.plist 的 CFBundleVersion，必须严格大于客户端当前值才提示 |
| `url` | ✅ | TestFlight 公开邀请链接（`https://testflight.apple.com/join/XXXXX`） |
| `notes` |  | 更新说明，`\n` 分行 |
| `publishedAt` |  | 发布时间，仅展示 |

### 7.3 更新 server/deploy/downloads/README.md

在"文件清单"表中追加两行：

| 文件 | 用途 | 固定文件名？ |
|---|---|---|
| `ios-update.json` | iOS App 版本源 | ✅ 固定名 |

---

## 八、iOS 发布流程（TestFlight）

### 8.1 改版本号

每次发版必须递增 `Build`（CFBundleVersion）：
- `ios/AssetMgmtRn/Info.plist` → `CFBundleVersion`（整数，+1）
- `CFBundleShortVersionString` 按语义化版本改（如 1.2.0）
- `mobile-app-rn/package.json` 的 `"version"` 同步

### 8.2 打 JS Bundle

```bash
cd ~/Projects/asset-mgmt/mobile-app-rn

npx react-native bundle --platform ios --dev false \
  --entry-file index.js \
  --bundle-output ios/main.jsbundle \
  --assets-dest ios
```

> iOS 不存在 Android 的中文路径问题，无需 subst 映射。

### 8.3 Xcode Archive

```bash
# 命令行
xcodebuild -workspace ios/AssetMgmtRn.xcworkspace \
  -scheme AssetMgmtRn \
  -configuration Release \
  -archivePath build/AssetMgmtRn.xcarchive \
  -destination "generic/platform=iOS" \
  archive

# 或 Xcode 内：Product → Archive
```

### 8.4 导出 IPA + 上传 TestFlight

```bash
# 1. 导出 IPA（需 ExportOptions.plist）
xcodebuild -exportArchive \
  -archivePath build/AssetMgmtRn.xcarchive \
  -exportOptionsPlist ios/ExportOptions.plist \
  -exportPath build/ipa

# 2. 上传（用 Transporter.app 或 xcrun altool）
xcrun altool --upload-app \
  -f build/ipa/AssetMgmtRn.ipa \
  -t ios \
  -u "your-apple-id@example.com" \
  -p "app-specific-password"  # 在 appleid.apple.com 生成
```

`ios/ExportOptions.plist` 模板：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store</string>
  <key>teamID</key>
  <string>YOUR_TEAM_ID</string>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
```

### 8.5 在 App Store Connect 启用 TestFlight

1. 登录 `appstoreconnect.apple.com`
2. 我的 App → 选 AssetMgmtRn → TestFlight
3. 等待 Apple 处理（10 分钟~1 小时）
4. **获取公开邀请链接**：TestFlight → 公开链接 → 启用 → 复制 `https://testflight.apple.com/join/XXXXX`

### 8.6 更新服务器 ios-update.json

把 TestFlight 链接写入 `ios-update.json`，上传到服务器：

```bash
# macOS 端上传（与 Windows pscp 等价）
scp ios-update.json hmt@192.168.40.247:/tmp/
ssh hmt@192.168.40.247 "echo <sudo密码> | sudo -S sh -c 'cp /tmp/ios-update.json /opt/asset-server/downloads/ && chown asset:asset /opt/asset-server/downloads/ios-update.json && chmod 644 /opt/asset-server/downloads/ios-update.json && rm /tmp/ios-update.json'"
```

### 8.7 验证

```bash
# iOS 客户端启动 6 秒后自动检查
# 或"我的"页 → 关于 → 检查更新
# 应弹窗 → 点"立即更新" → 跳 TestFlight → 安装新版

# curl 验证 JSON 可达
curl http://192.168.40.247/downloads/ios-update.json | jq .
```

---

## 九、验证清单（首次构建后逐项确认）

- [ ] **环境**：`xcodebuild -version`、`pod --version`、`node --version` 均符合要求
- [ ] **Pod 安装**：`cd ios && pod install` 成功无错误
- [ ] **Bundle ID**：`com.assetmanagement.mobile`（与 Android 对齐）
- [ ] **签名**：Xcode Signing & Capabilities 显示绿色"Apple Development"证书
- [ ] **Debug 模拟器**：`npx react-native run-ios` 能启动到登录页
- [ ] **Debug 真机**：连 iPhone 选 device → Cmd+R 能跑通
- [ ] **登录**：输入 `http://192.168.40.247` + `admin/admin123` 能进首页
- [ ] **扫码**：开相机权限 → 扫资产二维码能弹资产卡片
- [ ] **图标**：底部 Tab 与"我的"页图标正常显示（非方框 □）
- [ ] **HTTP**：能连内网 `192.168.40.247`（ATS 例外已配置）
- [ ] **应用内更新**：iOS 端 `appUpdateSupported=true`，弹窗后点更新能跳 TestFlight
- [ ] **Archive**：Release 构建 .xcarchive 成功
- [ ] **TestFlight**：上传后 10 分钟内可在 TestFlight 看到新构建
- [ ] **ios-update.json**：服务器 `http://192.168.40.247/downloads/ios-update.json` 返回 200 + 正确 JSON

---

## 十、故障排查速查

| 现象 | 原因/处理 |
|---|---|
| `pod install` 报 `vision-camera` 找不到 | 检查 `node_modules/react-native-vision-camera/ios/` 是否存在；必要时 `npm install` 重装 |
| Xcode 签名红错 "Failed to register bundle identifier" | Bundle ID 已被其他账号占用；改用 `com.assetmanagement.mobile.ios` 或换账号 |
| 跑 Debug 黑屏 | LaunchScreen.storyboard 未配置；检查 Info.plist 的 `UILaunchStoryboardName` |
| 启动闪退 `*** Terminating app due to uncaught exception 'RCTBridgeModule'` | 原生模块未在 Podfile 启用子模块（如 react-native-permissions 的 Camera） |
| 扫码闪退 "This app has crashed because it doesn't include NSCameraUsageDescription" | Info.plist 缺 `NSCameraUsageDescription`（见 5.1） |
| 图标显示方框 □ | `MaterialCommunityIcons.ttf` 未加到 Xcode target（见 5.3） |
| 连接 `192.168.40.247` 报 "The resource could not be loaded" | ATS 阻断 HTTP；检查 `NSAppTransportSecurity` 配置（见 5.2） |
| `xcrun altool --upload-app` 报 "You are not allowed to create records" | Apple ID 未加入 App Store Connect 用户；或 App-Specific Password 过期，需重新生成 |
| TestFlight 显示"缺少合规出口文档" | 出口合规：Info.plist 加 `ITSAppUsesNonExemptEncryption=false` |
| `ios-update.json` 拉到但弹"已是最新版本" | `bundleVersion` 没大于客户端 CFBundleVersion（判定只认整数，不认 versionName） |
| 更新弹窗点"立即更新"后 TestFlight 打不开 | `info.url` 不是 TestFlight 邀请链接；或 iOS 未安装 TestFlight App |

---

## 十一、与 Android 端的对齐对照表

| 维度 | Android | iOS |
|---|---|---|
| 包名 | `com.assetmanagement.mobile`（applicationId） | `com.assetmanagement.mobile`（Bundle ID） |
| 版本号 | versionCode=2 + versionName=1.1.0 | CFBundleVersion=2 + CFBundleShortVersionString=1.1.0 |
| 业务代码 | 共用 `mobile-app-rn/src/**` | 共用 `mobile-app-rn/src/**` |
| 扫码 | MLKit + useCodeScanner | AVFoundation + useCodeScanner（同 API） |
| 存储 | MMKV（AndroidKeystore） | MMKV（iOS Keychain） |
| 权限 | AndroidManifest.xml + 运行时请求 | Info.plist + 运行时请求 |
| 分发 | APK 直接下载安装 | TestFlight / App Store |
| 自更新 | `ApkUpdateModule.kt` 下载+SHA256+安装 | 跳 TestFlight 公开链接 |
| 版本源 | `/downloads/apk-update.json` | `/downloads/ios-update.json` |
| 版本判定字段 | `versionCode`（整数） | `bundleVersion`（整数，即 CFBundleVersion） |
| HTTP 例外 | 无（Android 默认允许 HTTP） | Info.plist `NSAppTransportSecurity` |
| 构建机 | Windows + JDK 17 + Gradle 8.10.2 | macOS + Xcode 15.4 + CocoaPods |
| 中文路径 | 必须 `subst R:` 映射（ninja 不支持） | 无此问题（macOS 路径 UTF-8 友好） |

---

## 十二、工作流建议（Mac AI 接手后的第一步）

1. **克隆项目**：从 Windows 端 git 仓库拉到 macOS
2. **核对版本**：`cat mobile-app-rn/package.json` 确认 RN 0.75.4 + react 18.3.1
3. **环境校验**：执行第 2.3 节命令，全部通过后再继续
4. **生成 iOS 工程**：第 4 节
5. **改配置**：第 5 节 Info.plist + 第 6 节代码平台分支
6. **跑通 Debug**：第 4.6 节，至少模拟器跑通登录+扫码
7. **首次 Archive**：第 8.3 节
8. **TestFlight 上传**：第 8.4~8.5 节
9. **服务器配置**：第 7 节新增 ios-update.json
10. **端到端验证**：第 9 节清单逐项勾选

---

## 十三、待办与已知限制

- 当前 `ios/` 目录不存在，首次生成需执行第 4 节
- `src/utils/apkUpdate.ts` 与 `src/utils/appUpdate.ts` 在过渡期可并存，Android 走旧模块，iOS 走新模块；长期建议统一为 `appUpdate.ts` 内部 `Platform.OS` 分支
- iOS 应用大小预计 80~120 MB（单架构，小于 Android 四架构 200 MB）
- TestFlight 测试员上限 10000；超出需走 App Store 正式分发
- App Store 审核 1~3 天；TestFlight 审核约 30 分钟
- `ITSAppUsesNonExemptEncryption=false` 必须加（否则每次构建都要手动填出口合规表）

---

## 参考文档

- [手机App构建说明.md](手机App构建说明.md)：Android 现行构建流程（环境、bundle、gradle、pscp、自更新机制）
- [手机App发布更新流程.md](手机App发布更新流程.md)：Android 发版 8 步照做手册
- [ReactNative重建方案.md](ReactNative重建方案.md)：Capacitor → RN 选型依据
- [发布同步规范.md](发布同步规范.md)：仓库=唯一事实源，AI 交接必读
