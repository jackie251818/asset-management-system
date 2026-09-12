// API 类型定义

export interface User {
  id: string;
  username: string;
  role: string;
  displayName?: string;
}

export type AssetStatus = 'active' | 'repair' | 'scrap' | 'lost';

export interface AssetAttachment {
  url: string;
  name: string;
  type: string;
}

export interface Asset {
  id: string;
  type: string;
  brandModel: string;
  owner: string;
  manager: string;
  user: string;
  department: string;
  location: string;
  status: AssetStatus;
  value: number;
  quantity: number;
  purchaseDate: string;
  damageReason?: string;
  attachments?: AssetAttachment[];
  remark?: string;
  createTime?: string;
  updateTime?: string;
}

export interface InventoryScope {
  mode: 'all' | 'department' | 'location';
  department?: string;
  location?: string;
}

export interface InventoryItem {
  assetId: string;
  snapshot: Partial<Asset>;
  status: 'pending' | 'counted' | 'exception';
  countedBy: string;
  countedAt: string;
  exceptionNote: string;
}

export interface InventorySession {
  id: string;
  name: string;
  creator: string;
  createdAt: string;
  updatedAt: string;
  status: 'in_progress' | 'completed';
  scope: InventoryScope;
  totalAssets: number;
  countedAssets: number;
  exceptionCount: number;
  version: number;
}

export interface InventoryDetail extends InventorySession {
  items: InventoryItem[];
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}
