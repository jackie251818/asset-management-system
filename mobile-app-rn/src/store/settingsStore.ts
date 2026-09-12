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
    // 规范化：移除末尾斜杠
    const normalized = url.replace(/\/+$/, '');
    mmkv.set('server_url', normalized);
    set({ serverUrl: normalized });
  },
}));
