import type { AnomalyType, ApiCheck } from '../api/types';

const ANOMALY_LABELS: Record<AnomalyType, string> = {
  HIGH_LATENCY: 'High latency',
  SERVER_ERROR: 'Server error',
  RATE_LIMITED: 'Rate limited',
  AUTH_FAILURE: 'Auth failure',
  CLIENT_ERROR: 'Client error',
  UNEXPECTED_STATUS: 'Unexpected status',
  MISSING_RECORD_COUNT: 'Missing record count',
  INVALID_RECORD_COUNT: 'Invalid record count',
  ZERO_RECORDS: 'Zero records',
  LOW_RECORD_COUNT: 'Low record count',
};

export function anomalyLabel(type: AnomalyType): string {
  return ANOMALY_LABELS[type] ?? type;
}

export function formatMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toLocaleString('en-US')} ms`;
}

/** "3m ago", "2h ago", "4d ago" — relative to `now`. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

export function recordsLabel(check: Pick<ApiCheck, 'records_returned' | 'records_issue'>): string {
  if (check.records_returned !== null) return check.records_returned.toLocaleString('en-US');
  if (check.records_issue === 'missing' || check.records_issue === 'null') return 'not reported';
  return 'invalid';
}

export type StatusTone = 'ok' | 'warn' | 'fail';

export function statusTone(code: number): StatusTone {
  if (code >= 500 || code === 401 || code === 403) return 'fail';
  if (code >= 200 && code < 300) return 'ok';
  return 'warn';
}

/** Width of a latency bar where the threshold sits at `thresholdAt` (0–1) of the track. */
export function latencyFill(ms: number, threshold: number, thresholdAt = 0.6): number {
  if (threshold <= 0) return 1;
  return Math.min(1, (ms / threshold) * thresholdAt);
}
