import { api } from './client';
import { User } from '../types/api';

export interface LoginResponse {
  token: string;
  user: User;
}

export const authApi = {
  login: (username: string, password: string) =>
    api.post<LoginResponse>('/api/auth/login', { username, password }),

  logout: () => api.post('/api/auth/logout', {}),

  ping: () => api.get<{ cs: boolean; version: string }>('/api/info'),
};
