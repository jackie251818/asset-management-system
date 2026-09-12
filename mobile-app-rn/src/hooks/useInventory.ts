import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { inventoryApi, InventorySession, InventoryDetail } from '../api/inventory';

export function useInventorySessions() {
  return useQuery<InventorySession[]>({
    queryKey: ['inventory_sessions'],
    queryFn: () => inventoryApi.listSessions(),
    staleTime: 30 * 1000,
  });
}

export function useInventorySession(id?: string) {
  return useQuery<InventoryDetail>({
    queryKey: ['inventory_session', id],
    queryFn: () => inventoryApi.getSession(id!),
    enabled: !!id,
    staleTime: 10 * 1000,
  });
}

export function useSaveInventorySession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, detail }: { id: string; detail: InventoryDetail }) =>
      inventoryApi.saveSession(id, detail),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['inventory_session', id] });
      qc.invalidateQueries({ queryKey: ['inventory_sessions'] });
    },
  });
}

export function useSaveInventoryList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessions: InventorySession[]) => inventoryApi.saveList(sessions),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory_sessions'] }),
  });
}
