/** Mirrors the backend's public (snake_case) response contract. */

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AlertStatus = 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';
export type CheckSource = 'API' | 'FILE' | 'DEMO';
export type AnomalyType =
  | 'HIGH_LATENCY'
  | 'SERVER_ERROR'
  | 'RATE_LIMITED'
  | 'AUTH_FAILURE'
  | 'CLIENT_ERROR'
  | 'UNEXPECTED_STATUS'
  | 'MISSING_RECORD_COUNT'
  | 'INVALID_RECORD_COUNT'
  | 'ZERO_RECORDS'
  | 'LOW_RECORD_COUNT';

export const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
export const STATUSES: AlertStatus[] = ['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED'];

export interface ApiCheck {
  id: string;
  api_name: string;
  response_time_ms: number;
  status_code: number;
  records_returned: number | null;
  records_issue: string | null;
  expected_min_records: number | null;
  anomaly_count: number;
  source: CheckSource;
  checked_at: string;
  created_at: string;
}

type EvidenceValue = string | number | boolean | null;

export interface AlertEvidence {
  finding: {
    type: AnomalyType;
    severity: Severity;
    message: string;
    observed: Record<string, EvidenceValue>;
    expected: Record<string, EvidenceValue>;
    checkedAt: string;
    detectedAt: string;
  };
  check: {
    statusCode: number;
    responseTimeMs: number;
    recordsReturned: number | null;
    recordsIssue: string | null;
    expectedMinRecords: number | null;
    latencyThresholdMs?: number;
  };
  relatedFindings: Array<{ type: AnomalyType; severity: Severity; message: string }>;
  escalation?: { fromSeverity: Severity; toSeverity: Severity; occurrenceCount: number };
}

export interface Alert {
  id: string;
  api_name: string;
  anomaly_type: AnomalyType;
  severity: Severity;
  base_severity: Severity;
  status: AlertStatus;
  title: string;
  summary: string;
  possible_causes: string[];
  recommended_actions: string[];
  evidence: AlertEvidence;
  generation: { source: 'AI' | 'FALLBACK'; model: string | null; prompt_version: string | null; generated_at: string | null };
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  latest_check: ApiCheck | null;
}

export interface AlertDetail extends Alert {
  recent_occurrences: Array<{ detected_at: string; check: ApiCheck }>;
}

export interface AlertList {
  data: Alert[];
  pagination: { total: number; limit: number; offset: number; has_more: boolean };
}

export interface Stats {
  total_checks: number;
  checks_last_24h: number;
  anomalous_checks: number;
  alerts: { active: number; acknowledged: number; resolved: number; critical_or_high_active: number };
  monitored_apis: number;
  affected_apis: Array<{ api_name: string; open_alerts: number; highest_severity: Severity }>;
  api_health: ApiCheck[];
  config: { latency_threshold_ms: number; escalation_occurrences: number; llm_mode: 'ai' | 'fallback_only'; llm_model: string | null };
}

export interface Health {
  status: 'ok' | 'degraded';
  dependencies: { database: 'up' | 'down'; llm: 'configured' | 'fallback_only'; email: 'configured' | 'disabled' };
  ai_queue_pending: number;
}

export interface IngestResult {
  summary: {
    received: number;
    accepted: number;
    rejected: number;
    failed: number;
    with_anomalies: number;
    anomalies_detected: number;
    alerts_created: number;
    alerts_updated: number;
  };
  results: Array<
    | { index: number; status: 'accepted'; api_name: string; anomalies: Array<{ type: AnomalyType; severity: Severity; message: string }> }
    | { index: number; status: 'rejected'; errors: Array<{ path: string; message: string }> }
    | { index: number; status: 'failed'; api_name: string; error: { code: string; message: string } }
  >;
}

export interface AlertFilters {
  status: AlertStatus | 'ALL';
  severity: Severity[];
  apiName: string;
  limit: number;
  offset: number;
}
