import { create } from 'zustand';
import { Asset } from '../types/api';

interface AssetStore {
  cachedAssets: Asset[];
  lastFetchedAt: number;
  setAssets: (assets: Asset[]) => void;
  clear: () => void;
}

export const useAssetStore = create<AssetStore>((set) => ({
  cachedAssets: [],
  lastFetchedAt: 0,
  setAssets: (assets) => set({ cachedAssets: assets, lastFetchedAt: Date.now() }),
  clear: () => set({ cachedAssets: [], lastFetchedAt: 0 }),
}));
