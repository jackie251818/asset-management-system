import { api } from './client';
import { Asset } from '../types/api';

export const assetsApi = {
  // 全量资产（用于本地缓存和列表）
  getAll: () => api.get<Asset[]>('/api/load?key=assetManagementData'),

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
