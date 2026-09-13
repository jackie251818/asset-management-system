# React Native 手机 App 重建方案

> 固定资产管理系统 — 原生移动应用技术方案
>
> 目标：用 React Native 替代当前 Capacitor WebView 套壳，提供真正的原生交互体验
>
> 平台：Android + iOS | 技术栈：React Native 0.75 + TypeScript

---

## 一、当前方案问题分析

| 问题 | 原因 |
|---|---|
| 启动慢，白屏 | 引导页 fetch `/api/info` 验证后才跳转 |
| 页面加载卡 | 每个页面（login/index/assets）都从服务器下载 HTML/JS/CSS |
| 交互不流畅 | WebView 内的 DOM 交互，非原生组件 |
| 无离线能力 | 依赖网络加载 UI 框架本身 |
| 无下拉刷新 | WebView 内的伪下拉体验差 |
| 过渡动画生硬 | CSS transition vs 原生导航动画 |

---

## 二、技术选型

### 2.1 核心框架

| 项 | 选择 | 理由 |
|---|---|---|
| 框架 | React Native 0.75 (CLI) | 非 Expo（需原生模块控制） |
| 语言 | TypeScript | 类型安全，复用现有 API 类型 |
| 导航 | React Navigation 6 | 原生 Stack + Tab + Drawer |
| 状态管理 | Zustand | 轻量，API 友好 |
| 数据获取 | React Query 5 | 缓存/重试/下拉刷新开箱即用 |
| 存储 | react-native-mmkv | 比 AsyncStorage 快 30 倍，同步读写 |
| UI 库 | 自建组件 + react-native-paper | Material Design 基础组件 |
| 图标 | react-native-vector-icons | FontAwesome + Material Icons |

### 2.2 原生插件

| 功能 | 插件 | 说明 |
|---|---|---|
| 扫码 | react-native-vision-camera | MLKit 扫码，帧识别极快 |
| 拍照 | react-native-vision-camera | 同一库，拍照 + 录屏 |
| 权限 | react-native-permissions | 统一权限管理 |
| 网络 | 内置 fetch | 无需额外插件 |
| 安全区 | react-native-safe-area-context | 刘海屏适配 |
| SVG | react-native-svg | 图表/图标 |
| 手势 | react-native-gesture-handler | 原生手势（滑动返回等） |
| 动画 | react-native-reanimated 3 | 60fps 原生动画 |

### 2.3 项目结构

```
mobile-app-rn/
├── package.json
├── tsconfig.json
├── app.json                       # RN 应用配置
├── babel.config.js
├── metro.config.js
├── android/                       # Android 原生工程
├── ios/                           # iOS 原生工程
└── src/
    ├── App.tsx                    # 入口：导航容器
    ├── navigation/
    │   ├── RootNavigator.tsx      # 根导航（登录/主界面分支）
    │   ├── MainTabBar.tsx         # 底部 Tab（首页/资产/盘点/我的）
    │   └── AssetStack.tsx         # 资产模块导航栈
    ├── screens/
    │   ├── LoginScreen.tsx        # 登录
    │   ├── HomeScreen.tsx        # 首页仪表盘
    │   ├── AssetListScreen.tsx   # 资产列表
    │   ├── AssetDetailScreen.tsx # 资产详情
    │   ├── AddAssetScreen.tsx    # 新增资产
    │   ├── InventoryListScreen.tsx  # 盘点批次列表
    │   ├── InventoryDetailScreen.tsx # 盘点明细
    │   ├── ScanScreen.tsx        # 扫码全屏页
    │   └── SettingsScreen.tsx    # 设置（服务器地址）
    ├── components/
    │   ├── AssetCard.tsx          # 资产卡片
    │   ├── StatCard.tsx           # 统计卡片
    │   ├── StatusBadge.tsx        # 状态徽章
    │   ├── SearchBar.tsx           # 搜索栏
    │   ├── FilterSheet.tsx        # 底部筛选抽屉
    │   ├── EmptyState.tsx         # 空状态
    │   ├── LoadingSpinner.tsx     # 加载中
    │   └── PhotoPreview.tsx       # 照片预览
    ├── api/
    │   ├── client.ts              # fetch 封装（baseURL + 认证 + 错误处理）
    │   ├── auth.ts                # 登录/登出 API
    │   ├── assets.ts              # 资产 CRUD API
    │   └── inventory.ts           # 盘点 API（kv_store）
    ├── store/
    │   ├── authStore.ts           # 登录状态（Zustand + MMKV 持久化）
    │   ├── settingsStore.ts       # 服务器地址配置
    │   └── assetStore.ts          # 资产缓存
    ├── hooks/
    │   ├── useAssets.ts           # 资产列表 React Query hook
    │   ├── useAsset.ts            # 单条资产
    │   ├── useInventory.ts        # 盘点批次
    │   └── useScanner.ts          # 扫码逻辑
    ├── theme/
    │   ├── colors.ts              # 色彩（浅色/深色/纯黑/科技）
    │   ├── spacing.ts             # 间距
    │   └── ThemeProvider.tsx      # 主题上下文
    ├── utils/
    │   ├── qrParser.ts            # 二维码纯文本解析
    │   └── format.ts              # 日期/数字格式化
    └── types/
        └── api.ts                 # API 类型定义
```

---

## 三、API 层设计

### 3.1 API Client 封装（src/api/client.ts）

```typescript
import { useSettingsStore } from '../store/settingsStore';
import { useAuthStore } from '../store/authStore';

const TOKEN_KEY = 'auth_token';

export class ApiClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = useSettingsStore.getState().serverUrl || 'http://192.168.40.247';
  }

  private getHeaders(): Record<string, string> {
    const token = useAuthStore.getState().token;
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const resp = await fetch(url, {
      ...options,
      headers: { ...this.getHeaders(), ...options.headers },
    });

    if (resp.status === 401) {
      useAuthStore.getState().logout();
      throw new Error('登录已过期，请重新登录');
    }

    const data = await resp.json();

    if (!resp.ok || data.success === false) {
      throw new Error(data.message || data.error || `HTTP ${resp.status}`);
    }

    return data.data !== undefined ? data.data : data;
  }

  get<T>(path: string) { return this.request<T>(path); }
  post<T>(path: string, body?: any) {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }
  put<T>(path: string, body?: any) {
    return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
  }
  delete<T>(path: string) {
    return this.request<T>(path, { method: 'DELETE' });
  }
}

export const api = new ApiClient();
```

### 3.2 认证 API（src/api/auth.ts）

```typescript
import { api } from './client';

export interface LoginResponse {
  token: string;
  user: { id: string; username: string; role: string; displayName?: string };
}

export const authApi = {
  login: (username: string, password: string) =>
    api.post<LoginResponse>('/api/auth/login', { username, password }),

  logout: () => api.post('/api/auth/logout'),

  ping: () => api.get<{ cs: boolean; version: string }>('/api/info'),
};
```

### 3.3 资产 API（src/api/assets.ts）

```typescript
import { api } from './client';

export interface Asset {
  id: string;
  type: string;
  brandModel: string;
  owner: string;
  manager: string;
  user: string;
  department: string;
  location: string;
  status: 'active' | 'repair' | 'scrap' | 'lost';
  value: number;
  quantity: number;
  purchaseDate: string;
  damageReason?: string;
  attachments?: Array<{ url: string; name: string; type: string }>;
}

export const assetsApi = {
  // 全量资产（用于本地缓存和列表）
  getAll: () => api.get<Asset[]>('/api/load?key=assetManagementData'),

  // 分页筛选
  search: (params: { page?: number; keyword?: string; department?: string; status?: string }) => {
    const qs = new URLSearchParams(params as any).toString();
    return api.get<{ items: Asset[]; total: number }>(`/api/assets?${qs}`);
  },

  // 单条资产
  getById: (id: string) => api.get<Asset>(`/api/assets/${encodeURIComponent(id)}`),

  // 新增
  create: (asset: Partial<Asset>) => api.post<Asset>('/api/assets', asset),

  // 更新
  update: (id: string, asset: Partial<Asset>) =>
    api.put<Asset>(`/api/assets/${encodeURIComponent(id)}`, asset),

  // 删除
  remove: (id: string) => api.delete(`/api/assets/${encodeURIComponent(id)}`),
};
```

### 3.4 盘点 API（src/api/inventory.ts）

```typescript
import { api } from './client';

export interface InventorySession {
  id: string;
  name: string;
  creator: string;
  createdAt: string;
  updatedAt: string;
  status: 'in_progress' | 'completed';
  scope: { mode: 'all' | 'department' | 'location'; department?: string; location?: string };
  totalAssets: number;
  countedAssets: number;
  exceptionCount: number;
  version: number;
}

export interface InventoryDetail extends InventorySession {
  items: Array<{
    assetId: string;
    snapshot: Partial<Asset>;
    status: 'pending' | 'counted' | 'exception';
    countedBy: string;
    countedAt: string;
    exceptionNote: string;
  }>;
}

export const inventoryApi = {
  listSessions: () => api.get<InventorySession[]>('/api/load?key=inventory_sessions'),

  getSession: (id: string) =>
    api.get<InventoryDetail>(`/api/load?key=inventory_session_${id}`),

  saveSession: (id: string, detail: InventoryDetail) =>
    api.post('/api/save', { key: `inventory_session_${id}`, value: detail }),

  saveList: (sessions: InventorySession[]) =>
    api.post('/api/save', { key: 'inventory_sessions', value: sessions }),
};
```

---

## 四、状态管理

### 4.1 认证状态（src/store/authStore.ts）

```typescript
import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();

interface AuthState {
  token: string | null;
  user: { username: string; role: string } | null;
  isLoggedIn: boolean;
  login: (token: string, user: any) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: mmkv.getString('auth_token') || null,
  user: mmkv.contains('auth_user') ? JSON.parse(mmkv.getString('auth_user')!) : null,
  isLoggedIn: mmkv.contains('auth_token'),

  login: (token, user) => {
    mmkv.set('auth_token', token);
    mmkv.set('auth_user', JSON.stringify(user));
    set({ token, user, isLoggedIn: true });
  },

  logout: () => {
    mmkv.delete('auth_token');
    mmkv.delete('auth_user');
    set({ token: null, user: null, isLoggedIn: false });
  },
}));
```

### 4.2 设置状态（src/store/settingsStore.ts）

```typescript
import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();

interface SettingsState {
  serverUrl: string;
  setServerUrl: (url: string) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  serverUrl: mmkv.getString('server_url') || 'http://192.168.40.247',
  setServerUrl: (url) => {
    mmkv.set('server_url', url);
    set({ serverUrl: url });
  },
}));
```

---

## 五、导航结构

```
RootNavigator
├── (未登录) → LoginStack
│   └── LoginScreen
│       └── SettingsScreen (配置服务器地址)
│
└── (已登录) → MainTabs
    ├── Tab 1: 首页 (HomeStack)
    │   └── HomeScreen (统计仪表盘)
    │       └── AssetDetailScreen
    │
    ├── Tab 2: 资产 (AssetStack)
    │   └── AssetListScreen (列表 + 搜索 + 筛选)
    │       ├── AssetDetailScreen (详情)
    │       └── AddAssetScreen (新增 + 拍照)
    │
    ├── Tab 3: 盘点 (InventoryStack)
    │   └── InventoryListScreen (批次列表)
    │       └── InventoryDetailScreen (明细 + 扫码 + 勾选)
    │
    └── Tab 4: 我的 (SettingsStack)
        └── SettingsScreen (服务器地址 + 主题 + 退出)
```

### 导航代码（src/navigation/RootNavigator.tsx）

```tsx
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { useAuthStore } from '../store/authStore';
import MainTabs from './MainTabBar';
import LoginScreen from '../screens/LoginScreen';

const Stack = createStackNavigator();

export default function RootNavigator() {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {isLoggedIn ? (
          <Stack.Screen name="Main" component={MainTabs} />
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
```

---

## 六、核心页面设计

### 6.1 登录页（LoginScreen）

```
┌─────────────────────────┐
│                         │
│    📱 固定资产管理       │
│                         │
│  ┌─────────────────┐    │
│  │ 用户名          │    │
│  └─────────────────┘    │
│  ┌─────────────────┐    │
│  │ 密码             │    │
│  └─────────────────┘    │
│                         │
│  ┌─────────────────┐    │
│  │     登 录        │    │
│  └─────────────────┘    │
│                         │
│  服务器: 192.168.40.247 │
│              [修改地址]  │
└─────────────────────────┘
```

- 原生 TextInput（键盘弹出自动避让）
- 登录按钮 loading 状态
- 服务器地址点击弹出底部 Sheet 修改
- 错误提示 Toast

### 6.2 首页仪表盘（HomeScreen）

```
┌─────────────────────────┐
│  固定资产管理     👤 admin│
├─────────────────────────┤
│ ┌─────┐ ┌─────┐        │
│ │ 156 │ │  3  │        │
│ │总资产│ │损坏  │        │
│ └─────┘ └─────┘        │
│ ┌─────┐ ┌─────┐        │
│ │¥89万│ │ 98% │        │
│ │总价值│ │完好率│        │
│ └─────┘ └─────┘        │
├─────────────────────────┤
│  最近变更                │
│ ┌─────────────────────┐│
│ │ FYM-001 ThinkPad    ││
│ │ 张三 · 2小时前       ││
│ └─────────────────────┘│
│ ┌─────────────────────┐│
│ │ FYM-002 显示器      ││
│ │ 李四 · 昨天          ││
│ └─────────────────────┘│
└─────────────────────────┘
```

- FlatList 渲染统计卡 + 最近变更
- 下拉刷新重新拉取数据
- 统计卡用 View + Animated 实现数字动画

### 6.3 资产列表（AssetListScreen）

```
┌─────────────────────────┐
│ 🔍 搜索编号/型号/使用人  │
├─────────────────────────┤
│ 全部 ▼  状态 ▼  排序 ▼  │
├─────────────────────────┤
│ ┌─────────────────────┐│
│ │FYM-001              ││
│ │ThinkPad X1 Carbon   ││
│ │张三 · 技术部 · 北京  ││
│ │               ● 在用 ││
│ └─────────────────────┘│
│ ┌─────────────────────┐│
│ │FYM-002              ││
│ │Dell U2720Q          ││
│ │李四 · 财务部 · 上海  ││
│ │               ● 在用 ││
│ └─────────────────────┘│
│          ...            │
│    上拉加载更多          │
└─────────────────────────┘
         ⊕ 悬浮按钮
```

- FlatList + 虚拟化列表（性能优化）
- 搜索框防抖（300ms）
- 筛选用底部 ModalSheet（BottomSheetModal）
- 下拉刷新 + 上拉加载
- 右下角悬浮「新增」按钮

### 6.4 资产详情（AssetDetailScreen）

```
┌─────────────────────────┐
│ ← 返回    资产详情   ⋯   │
├─────────────────────────┤
│  ┌───────────────────┐  │
│  │                   │  │
│  │   📷 资产照片      │  │
│  │   (可滑动多张)     │  │
│  │                   │  │
│  └───────────────────┘  │
├─────────────────────────┤
│ 编号    FYM-001          │
│ 类型    笔记本电脑        │
│ 品牌型号 ThinkPad X1     │
│ 主体    花满堂            │
│ 使用人  张三              │
│ 责任人  张三              │
│ 部门    技术部            │
│ 地点    北京机房          │
│ 状态    ● 在用            │
│ 购入日期 2025-03-15       │
│ 价值    ¥8,000           │
│ 数量    1                │
├─────────────────────────┤
│  维护记录                 │
│  ┌─────────────────┐     │
│  │ 2025-06-01      │     │
│  │ 更换硬盘         │     │
│  └─────────────────┘     │
├─────────────────────────┤
│  [编辑]  [打印标签]      │
└─────────────────────────┘
```

- ScrollView 内嵌 FlatList（维护记录）
- 照片轮播用 react-native-reanimated
- 状态徽章颜色映射

### 6.5 新增资产（AddAssetScreen）

```
┌─────────────────────────┐
│ ← 返回    新增资产       │
├─────────────────────────┤
│ 编号*   ┌──────────┐    │
│         │FYM-      │    │
│         └──────────┘    │
│ 类型*   [选择类型 ▼]    │
│ 品牌型号 ┌──────────┐   │
│         │          │    │
│         └──────────┘    │
│ 主体*   [选择主体 ▼]    │
│ 使用人  ┌──────────┐    │
│         └──────────┘    │
│ 部门*   [选择部门 ▼]    │
│ 地点    ┌──────────┐    │
│         └──────────┘    │
│ 状态    ●在用 ○维修 ○报废│
│ 购入日期 2025-09-08 📅  │
│ 价值    ┌──────────┐    │
│         └──────────┘    │
├─────────────────────────┤
│  附件                     │
│  ┌────┐ ┌────┐ ┌────┐  │
│  │📷│ │📷│ │ ➕ │  │
│  │📷│ │📷│ │    │  │
│  └────┘ └────┘ └────┘  │
├─────────────────────────┤
│      [保存资产]          │
└─────────────────────────┘
```

- 原生 TextInput + Picker
- 照片用 vision-camera 拍照 → base64 → 显示缩略图
- 长按缩略图删除
- 保存时 loading + 成功后 pop 返回

### 6.6 盘点列表（InventoryListScreen）

```
┌─────────────────────────┐
│  资产盘点    + 发起盘点   │
├─────────────────────────┤
│ ┌─────────────────────┐│
│ │ 2026年9月例行盘点    ││
│ │ admin · 09-08 15:30  ││
│ │ 已盘 89/156 · 57%   ││
│ │ ████░░░░  进行中     ││
│ └─────────────────────┘│
│ ┌─────────────────────┐│
│ │ 2026年8月例行盘点    ││
│ │ admin · 08-01 10:00  ││
│ │ 已盘 150/150 · 100% ││
│ │ ████████  已完成     ││
│ └─────────────────────┘│
└─────────────────────────┘
```

### 6.7 盘点明细（InventoryDetailScreen）

```
┌─────────────────────────┐
│ ← 返回  2026年9月盘点   │
├─────────────────────────┤
│ ┌───┐┌───┐┌───┐┌───┐  │
│ │156││ 89││ 64││ 3 │  │
│ │应盘││已盘││未盘││异常│  │
│ └───┘└───┘└───┘└───┘  │
│ ████████░░░░  57%      │
├─────────────────────────┤
│ 全部▼  🔍搜索           │
├─────────────────────────┤
│ │FYM-001 ThinkPad  ✓已盘│
│ │FYM-002 显示器    ⏳未盘│
│ │FYM-003 打印机    ⚠异常│
│     └ 备注：卡纸         │
│ │FYM-004 路由器    ⏳未盘│
├─────────────────────────┤
│  [📷扫码盘点] [导出] [完成]│
└─────────────────────────┘
```

### 6.8 扫码全屏页（ScanScreen）

```
┌─────────────────────────┐
│                     ✕   │
│                         │
│    ┌─────────────┐     │
│    │             │     │
│    │  扫描框      │     │
│    │             │     │
│    └─────────────┘     │
│                         │
│   将二维码对准框内       │
│                         │
│  已扫到 3 条             │
│                         │
│      [结束扫码]          │
└─────────────────────────┘
```

- 全屏相机预览（vision-camera）
- 实时帧识别（MLKit）
- 扫到后震动反馈 + Toast
- 自动连续扫码模式

---

## 七、扫码逻辑（src/hooks/useScanner.ts）

```typescript
import { useEffect, useRef, useState, useCallback } from 'react';
import { Camera, useCameraDevices, useFrameProcessor } from 'react-native-vision-camera';
import { scanBarcodes, BarcodeFormat } from 'react-native-vision-camera-v3';
import { runOnJS } from 'react-native-reanimated';

export function useScanner(onScan: (code: string) => void) {
  const [hasPermission, setHasPermission] = useState(false);
  const [isScanning, setIsScanning] = useState(true);
  const devices = useCameraDevices();
  const device = devices.back;
  const lastCode = useRef('');

  useEffect(() => {
    (async () => {
      const status = await Camera.requestCameraPermission();
      setHasPermission(status === 'granted');
    })();
  }, []);

  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';
    const barcodes = scanBarcodes(frame, [BarcodeFormat.QR_CODE]);
    if (barcodes.length > 0 && barcodes[0].rawValue) {
      const code = barcodes[0].rawValue;
      if (code !== lastCode.value) {
        lastCode.value = code;
        runOnJS(onScan)(code);
      }
    }
  }, []);

  return { hasPermission, device, frameProcessor, isScanning, setIsScanning };
}
```

### 二维码解析（src/utils/qrParser.ts）

```typescript
export function parseAssetQR(content: string): string | null {
  // 匹配 "编码：FYM-001" 或 "编码:FYM-001"
  const match = content.match(/编码[：:]\s*(.+)/);
  if (match) return match[1].trim();
  // 兜底：尝试匹配纯编号格式
  const idMatch = content.match(/([A-Z]+-\d+)/);
  if (idMatch) return idMatch[1];
  return null;
}
```

---

## 八、数据获取 Hooks（React Query）

### useAssets.ts

```typescript
import { useQuery } from '@tanstack/react-query';
import { assetsApi, Asset } from '../api/assets';

export function useAssets(keyword?: string, department?: string) {
  return useQuery<Asset[]>({
    queryKey: ['assets', keyword, department],
    queryFn: () => assetsApi.getAll(),
    staleTime: 5 * 60 * 1000,  // 5 分钟缓存
    select: (data) => {
      let filtered = data;
      if (keyword) {
        const kw = keyword.toLowerCase();
        filtered = filtered.filter(a =>
          a.id?.toLowerCase().includes(kw) ||
          a.brandModel?.toLowerCase().includes(kw) ||
          a.user?.toLowerCase().includes(kw)
        );
      }
      if (department && department !== 'all') {
        filtered = filtered.filter(a => a.department === department);
      }
      return filtered;
    },
  });
}
```

---

## 九、主题系统

### theme/colors.ts

```typescript
const themes = {
  light: {
    background: '#f5f7fa',
    surface: '#ffffff',
    text: '#1a202c',
    textSecondary: '#718096',
    border: '#e2e8f0',
    primary: '#3182ce',
    success: '#52c41a',
    warning: '#faad14',
    danger: '#f5222d',
  },
  dark: {
    background: '#1a202c',
    surface: '#2d3748',
    text: '#f7fafc',
    textSecondary: '#a0aec0',
    border: '#4a5568',
    primary: '#4299e1',
    success: '#48bb78',
    warning: '#ecc94b',
    danger: '#fc8181',
  },
  // 纯黑 / 科技 主题同理
};

export type Theme = keyof typeof themes;
```

### ThemeProvider

```tsx
import { createContext, useContext } from 'react';
import { useMMKVString } from 'react-native-mmkv';

const ThemeContext = createContext(themes.light);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeName] = useMMKVString('theme');
  const theme = themes[(themeName as keyof typeof themes) || 'light'];
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
```

---

## 十、初始化和构建

### 10.1 创建项目

```bash
# 方式一：React Native CLI（推荐，需原生模块控制）
npx react-native@latest init AssetManagementApp --typescript

# 方式二：如果已有项目，直接在 mobile-app-rn/ 初始化
```

### 10.2 安装依赖

```bash
cd mobile-app-rn

# 核心依赖
npm install @react-navigation/native @react-navigation/stack @react-navigation/bottom-tabs
npm install react-native-screens react-native-safe-area-context
npm install react-native-reanimated react-native-gesture-handler
npm install react-native-mmkv
npm install zustand @tanstack/react-query
npm install react-native-vector-icons
npm install react-native-paper

# 原生插件
npm install react-native-vision-camera
npm install react-native-permissions

# iOS 额外
cd ios && pod install && cd ..
```

### 10.3 Android 配置

**android/app/src/main/AndroidManifest.xml:**
```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.CAMERA" />
<application
    android:usesCleartextTraffic="true"
    ...>
```

**android/gradle.properties:**
```properties
android.useAndroidX=true
```

### 10.4 构建 Debug APK

```bash
cd mobile-app-rn/android

# Debug APK
./gradlew assembleDebug
# 产出: app/build/outputs/apk/debug/app-debug.apk

# iOS
cd ../ios
pod install
# 用 Xcode 打开 .xcworkspace 构建
```

### 10.5 构建 Release APK

```bash
# 生成 keystore
keytool -genkey -v -keystore asset-mgmt.keystore -alias asset-mgmt \
  -keyalg RSA -keysize 2048 -validity 36500

# 配置 android/app/build.gradle
# signingConfigs { release { ... } }
# buildTypes { release { signingConfig signingConfigs.release } }

cd mobile-app-rn/android
./gradlew assembleRelease
# 产出: app/build/outputs/apk/release/app-release.apk
```

---

## 十一、与现有系统的对接

### 11.1 服务器 API 端点清单

| 方法 | 路径 | 认证 | 用途 |
|---|---|---|---|
| POST | /api/auth/login | 否 | 登录 → {token, user} |
| POST | /api/auth/logout | 是 | 登出 |
| GET | /api/info | 否 | 探测服务器 → {cs, version} |
| GET | /api/load?key=assetManagementData | 是* | 全量资产 |
| GET | /api/assets | 是 | 分页筛选 |
| GET | /api/assets/all | 是 | 全量（REST 版） |
| GET | /api/assets/:id | 是 | 单条详情 |
| POST | /api/assets | 是 | 新增 |
| PUT | /api/assets/:id | 是 | 更新 |
| DELETE | /api/assets/:id | 是 | 删除 |
| POST | /api/save | 是 | 写 kv_store（盘点数据） |
| GET | /api/load?key=inventory_sessions | 是 | 读盘点批次列表 |
| GET | /api/load?key=inventory_session_xxx | 是 | 读单批次明细 |

> *GET /api/load?key=assetManagementData 需要认证，但 systemSettings 和 custom_options_* 免认证

### 11.2 认证方式

```
Authorization: Bearer <JWT token>
```

登录成功后保存 token 到 MMKV，每次请求自动带 Authorization 头。401 时自动登出跳登录页。

### 11.3 照片上传格式

现有资产新增 API 接收 `attachments` 数组：
```json
{
  "attachments": [
    { "url": "data:image/jpeg;base64,/9j/4AAQ...", "name": "photo1.jpg", "type": "image/jpeg" }
  ]
}
```

React Native 拍照后获取 base64 字符串，构造相同格式提交。

### 11.4 二维码格式

资产标签二维码是纯文本，格式：
```
资产信息
名称：电脑
型号：ThinkPad X1
编码：FYM-001
机构：花满堂
责任人：张三
地点：办公室
```

解析逻辑：`content.match(/编码[：:]\s*(.+)/)` 提取资产 ID。

---

## 十二、与 Capacitor 方案的对比

| 维度 | Capacitor（旧） | React Native（新） |
|---|---|---|
| 渲染 | WebView + DOM | 原生 UI 组件 |
| 启动速度 | 慢（加载远程页） | 快（本地 bundle） |
| 离线能力 | 无（UI 依赖网络） | 有（UI 本地，数据可缓存） |
| 下拉刷新 | 伪 DOM | 原生 FlatList |
| 导航动画 | CSS transition | 原生 Stack 动画 |
| 滚动性能 | WebView 滚动卡顿 | 原生虚拟化列表 |
| 手势 | 受限 | 原生手势系统 |
| 扫码 | 插件 + 全屏遮罩 | 原生相机 + 实时帧识别 |
| 拍照 | 插件 → base64 → 伪 File → DOM | 原生相机 → 直接显示 |
| 维护 | 前端改动热上传即生效 | 前端改动需重新打包 APK |
| 代码复用 | 复用 100% 现有前端 | 仅复用 API 接口和数据模型 |
| iOS 支持 | 需额外配置 | 原生支持 |

---

## 十三、踩坑预警

| 风险 | 缓解 |
|---|---|
| 项目路径含中文 | Android Gradle 非 ASCII 检查 → `android.overridePathCheck=true` |
| 明文 HTTP 被拦截 | `usesCleartextTraffic=true` + `server.cleartext` |
| vision-camera 版本兼容 | RN 0.75 用 vision-camera v4+，需 Metro config 配置 |
| MMKV 线程安全 | Zustand 的 set 是同步的，MMKV 也是同步的，无竞态 |
| iOS CocoaPods | 需 Apple Silicon Mac，`pod install` 可能需 `--repo-update` |
| APK 体积 | RN 基础包约 8-12 MB，比 Capacitor 略大但可接受 |
| 资产数据量大（5000+） | React Query + MMKV 本地缓存 + FlatList 虚拟化，无需全量渲染 |

---

## 十四、实施步骤

| 步骤 | 内容 | 依赖 |
|---|---|---|
| 1 | `npx react-native init` + 安装依赖 | JDK 17 + Android SDK |
| 2 | 配置 Android（cleartext + 权限 + 路径绕过） | 步骤 1 |
| 3 | 搭建导航骨架（RootNavigator + MainTabs） | 步骤 1 |
| 4 | 实现 API 层（client + auth + assets + inventory） | 步骤 1 |
| 5 | 实现状态管理（authStore + settingsStore） | 步骤 4 |
| 6 | 实现登录页 | 步骤 3,4,5 |
| 7 | 实现首页仪表盘 | 步骤 3,4 |
| 8 | 实现资产列表（搜索+筛选+下拉刷新） | 步骤 3,4 |
| 9 | 实现资产详情 | 步骤 8 |
| 10 | 实现新增资产（拍照+表单） | 步骤 4,8 |
| 11 | 实现扫码全屏页（vision-camera） | 步骤 3 |
| 12 | 实现盘点列表 + 明细 | 步骤 4,8,11 |
| 13 | 主题系统（浅色/深色/纯黑/科技） | 步骤 3 |
| 14 | 构建 debug APK → 联调 | 全部 |
| 15 | 签名 + release APK 分发 | 步骤 14 |

---

## 十五、环境要求速查

```
JDK           = 17 (C:\jdk17\PFiles64\Microsoft\jdk-17.0.20.101-hotspot)
Android SDK   = C:\Android\Sdk (Platform 34 + Build-Tools 34.0.0)
Node.js       = 18+
项目路径       = mobile-app-rn/
APK 产出       = mobile-app-rn/android/app/build/outputs/apk/debug/app-debug.apk
服务器         = http://192.168.40.247 (内网 LAN)
SSH           = hmt（密码由内部运维保管，勿写入仓库）
```
