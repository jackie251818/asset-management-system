import { useQuery } from '@tanstack/react-query';
import { assetsApi, Asset } from '../api/assets';

export function useAsset(id?: string) {
  return useQuery<Asset>({
    queryKey: ['asset', id],
    queryFn: () => assetsApi.getById(id!),
    enabled: !!id,
    staleTime: 5 * 60 * 1000,
  });
}
