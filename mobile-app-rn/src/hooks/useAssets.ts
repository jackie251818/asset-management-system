import { useQuery } from '@tanstack/react-query';
import { assetsApi, Asset } from '../api/assets';
import { useAssetStore } from '../store/assetStore';

export function useAssets(keyword?: string, department?: string, status?: string) {
  const setAssets = useAssetStore((s) => s.setAssets);

  return useQuery<Asset[]>({
    queryKey: ['assets'],
    queryFn: async () => {
      const data = await assetsApi.getAll();
      setAssets(data);
      return data;
    },
    staleTime: 5 * 60 * 1000,
    select: (data) => {
      let filtered = data || [];
      if (keyword) {
        const kw = keyword.toLowerCase();
        filtered = filtered.filter(
          (a) =>
            a.id?.toLowerCase().includes(kw) ||
            a.brandModel?.toLowerCase().includes(kw) ||
            a.user?.toLowerCase().includes(kw) ||
            a.type?.toLowerCase().includes(kw),
        );
      }
      if (department && department !== 'all') {
        filtered = filtered.filter((a) => a.department === department);
      }
      if (status && status !== 'all') {
        filtered = filtered.filter((a) => a.status === status);
      }
      return filtered;
    },
  });
}
