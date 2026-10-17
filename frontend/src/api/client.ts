import type { AlertDetail, AlertFilters, AlertList, AlertStatus, Health, IngestResult, Stats } from './types';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '');

/** Error carrying the backend's structured error payload. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    /** Present for 400/207-style responses that still carry a useful body. */
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the monitoring API. Check that the backend is running on port 4000.');
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(response.status, error?.code ?? 'HTTP_ERROR', error?.message ?? `Request failed with HTTP ${response.status}`, error?.details, body);
  }
  return body as T;
}

/** Build the GET /alerts query string from UI filters. */
export function alertsQuery(filters: AlertFilters): string {
  const params = new URLSearchParams();
  params.set('status', filters.status);
  if (filters.severity.length > 0) params.set('severity', filters.severity.join(','));
  if (filters.apiName.trim()) params.set('api_name', filters.apiName.trim());
  params.set('limit', String(filters.limit));
  params.set('offset', String(filters.offset));
  return params.toString();
}

export const api = {
  health: () => request<Health>('/health'),
  stats: () => request<{ data: Stats }>('/stats').then((r) => r.data),
  alerts: (filters: AlertFilters) => request<AlertList>(`/alerts?${alertsQuery(filters)}`),
  alert: (id: string) => request<{ data: AlertDetail }>(`/alerts/${encodeURIComponent(id)}`).then((r) => r.data),
  updateStatus: (id: string, status: Extract<AlertStatus, 'ACKNOWLEDGED' | 'RESOLVED'>) =>
    request<{ data: AlertDetail }>(`/alerts/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }).then((r) => r.data),
  regenerate: (id: string) =>
    request<{ data: AlertDetail; generation_result: 'ai' | 'fallback' | 'skipped' }>(`/alerts/${encodeURIComponent(id)}/regenerate`, { method: 'POST' }),
  /** POST /monitor. 207 (partial success) is returned as a normal result. */
  ingest: (events: unknown, source: 'demo' | 'api' = 'demo') =>
    request<IngestResult>('/monitor', { method: 'POST', body: JSON.stringify(events), headers: { 'X-Monitor-Source': source } }),
};
