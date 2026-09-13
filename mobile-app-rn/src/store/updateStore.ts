/**
 * 应用自更新全局状态
 * - 启动后由 UpdateGate 延迟 6 秒静默检查（失败不打扰）
 * - "我的"页可手动检查（manual=true，成功无更新/失败均给提示）
 */
import { create } from 'zustand';
import { Alert } from 'react-native';
import {
  apkUpdateSupported,
  fetchUpdateInfo,
  getCurrentVersion,
  hasUpdate,
  UpdateInfo,
} from '../utils/apkUpdate';

interface UpdateState {
  visible: boolean;
  info: UpdateInfo | null;
  checking: boolean;
  /** 发现更新后弹窗；关闭仅隐藏弹窗，不清除 info（供同会话内重新打开） */
  showModal: () => void;
  closeModal: () => void;
  check: (manual: boolean) => Promise<void>;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  visible: false,
  info: null,
  checking: false,

  showModal: () => {
    if (get().info) set({ visible: true });
  },
  closeModal: () => set({ visible: false }),

  check: async (manual: boolean) => {
    if (!apkUpdateSupported) {
      if (manual) Alert.alert('提示', '当前平台不支持应用内更新');
      return;
    }
    if (get().checking) return;
    set({ checking: true });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let info: UpdateInfo | null = null;
      try {
        info = await fetchUpdateInfo(controller.signal);
      } finally {
        clearTimeout(timer);
      }

      if (!info) {
        if (manual) Alert.alert('检查更新', '未获取到有效的版本信息');
        return;
      }

      const current = await getCurrentVersion();
      if (hasUpdate(current.versionCode, info)) {
        // 已经有更新弹窗信息时不重复打扰
        set({ info, visible: true });
      } else if (manual) {
        Alert.alert(
          '已是最新版本',
          `当前版本 v${current.versionName}（版本号 ${current.versionCode}）\n最新版本 v${info.versionName}（版本号 ${info.versionCode}），无需更新。`,
        );
      }
    } catch (e: any) {
      if (manual) {
        const msg = e?.name === 'AbortError' ? '连接服务器超时' : e?.message || '无法连接服务器';
        Alert.alert('检查更新失败', msg);
      }
      // 静默检查：任何失败直接忽略
    } finally {
      set({ checking: false });
    }
  },
}));
