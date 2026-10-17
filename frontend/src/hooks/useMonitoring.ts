import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AlertFilters, AlertStatus } from '../api/types';

const DEFAULT_POLL_MS = 10_000;
export const POLL_INTERVAL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS) || DEFAULT_POLL_MS;

export const queryKeys = {
  stats: ['stats'] as const,
  health: ['health'] as const,
  alerts: (filters: AlertFilters) => ['alerts', filters] as const,
  alert: (id: string) => ['alert', id] as const,
};

export function useStats() {
  return useQuery({ queryKey: queryKeys.stats, queryFn: api.stats, refetchInterval: POLL_INTERVAL_MS });
}

export function useHealth() {
  return useQuery({ queryKey: queryKeys.health, queryFn: api.health, refetchInterval: POLL_INTERVAL_MS, retry: false });
}

export function useAlerts(filters: AlertFilters) {
  return useQuery({
    queryKey: queryKeys.alerts(filters),
    queryFn: () => api.alerts(filters),
    refetchInterval: POLL_INTERVAL_MS,
    placeholderData: keepPreviousData,
  });
}

export function useAlert(id: string | null) {
  return useQuery({
    queryKey: queryKeys.alert(id ?? ''),
    queryFn: () => api.alert(id!),
    enabled: Boolean(id),
    refetchInterval: POLL_INTERVAL_MS,
    retry: false,
  });
}

/** Refresh everything that an ingestion or status change can affect. */
function useInvalidateAll() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ predicate: (q) => ['alerts', 'alert', 'stats', 'health'].includes(String(q.queryKey[0])) });
}

export function useUpdateStatus() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: Extract<AlertStatus, 'ACKNOWLEDGED' | 'RESOLVED'> }) => api.updateStatus(id, status),
    onSettled: invalidate,
  });
}

export function useRegenerate() {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: (id: string) => api.regenerate(id), onSettled: invalidate });
}

export function useIngest() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: ({ events, source }: { events: unknown; source: 'demo' | 'api' }) => api.ingest(events, source),
    onSettled: () => {
      invalidate();
      // AI enrichment runs in the background on the server; refresh again once it has had time to finish.
      window.setTimeout(invalidate, 4000);
    },
  });
}
