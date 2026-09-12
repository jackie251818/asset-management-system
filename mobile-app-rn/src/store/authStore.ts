import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';
import { User } from '../types/api';

const mmkv = new MMKV();

interface AuthState {
  token: string | null;
  user: User | null;
  isLoggedIn: boolean;
  login: (token: string, user: User) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: mmkv.getString('auth_token') || null,
  user: mmkv.contains('auth_user') ? JSON.parse(mmkv.getString('auth_user') || 'null') : null,
  isLoggedIn: mmkv.contains('auth_token'),

  login: (token, user) => {
    if (typeof token !== 'string' || !token) {
      throw new Error('登录响应异常：缺少 token');
    }
    mmkv.set('auth_token', token);
    mmkv.set('auth_user', JSON.stringify(user ?? null));
    set({ token, user: user ?? null, isLoggedIn: true });
  },

  logout: () => {
    mmkv.delete('auth_token');
    mmkv.delete('auth_user');
    set({ token: null, user: null, isLoggedIn: false });
  },
}));
