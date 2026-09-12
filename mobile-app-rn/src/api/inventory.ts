import { api } from './client';
import { InventorySession, InventoryDetail } from '../types/api';

// 键不存在（首次使用，服务端返回 404）时按空数据处理
function isNotFound(e: any): boolean {
  const msg = String(e?.message || '');
  return msg.includes('404') || msg.includes('不存在');
}

export const inventoryApi = {
  listSessions: async (): Promise<InventorySession[]> => {
    try {
      return (await api.get<InventorySession[]>('/api/load?key=inventory_sessions')) || [];
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
  },

  getSession: async (id: string): Promise<InventoryDetail | null> => {
    try {
      return await api.get<InventoryDetail>(`/api/load?key=inventory_session_${id}`);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  },

  saveSession: (id: string, detail: InventoryDetail) =>
    api.post('/api/save', { key: `inventory_session_${id}`, value: detail }),

  saveList: (sessions: InventorySession[]) =>
    api.post('/api/save', { key: 'inventory_sessions', value: sessions }),

  deleteSession: (id: string) =>
    api.post('/api/delete', { key: `inventory_session_${id}` }),
};
