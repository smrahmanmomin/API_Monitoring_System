/**
 * Domain types shared by the rule engine, alert lifecycle and AI layers.
 * Values mirror the Prisma enums so they can be persisted directly.
 */

export const ANOMALY_TYPES = [
  'HIGH_LATENCY',
  'SERVER_ERROR',
  'RATE_LIMITED',
  'AUTH_FAILURE',
  'CLIENT_ERROR',
  'UNEXPECTED_STATUS',
  'MISSING_RECORD_COUNT',
  'INVALID_RECORD_COUNT',
  'ZERO_RECORDS',
  'LOW_RECORD_COUNT',
] as const;
export type AnomalyType = (typeof ANOMALY_TYPES)[number];

export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ALERT_STATUSES = ['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const CHECK_SOURCES = ['API', 'FILE', 'DEMO'] as const;
export type CheckSource = (typeof CHECK_SOURCES)[number];

/** Why a record count could not be used. `null` means the count is valid. */
export type RecordsIssue = 'missing' | 'null' | 'negative' | 'non_integer' | 'not_a_number';

/** A validated, normalised monitoring event as consumed by the rule engine. */
export interface MonitoringEvent {
  apiName: string;
  responseTimeMs: number;
  statusCode: number;
  /** Valid non-negative integer record count, otherwise null (see recordsIssue). */
  recordsReturned: number | null;
  recordsIssue: RecordsIssue | null;
  /** The raw reported value when it was present but unusable (for evidence only). */
  rawRecordsValue?: number | string | null;
  expectedMinRecords?: number;
  checkedAt: Date;
}

export type EvidenceValue = string | number | boolean | null;

/** Deterministic output of the rule engine for a single anomaly. */
export interface Finding {
  type: AnomalyType;
  severity: Severity;
  apiName: string;
  /** What was measured. */
  observed: Record<string, EvidenceValue>;
  /** Configured threshold / expectation the observation was compared to. */
  expected: Record<string, EvidenceValue>;
  /** Event timestamp (when the API was checked), ISO-8601. */
  checkedAt: string;
  /** When the rule engine produced the finding, ISO-8601. */
  detectedAt: string;
  /** Short, factual, deterministic description of the rule violation. */
  message: string;
}

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

/** One level up, capped at CRITICAL. */
export function escalate(severity: Severity): Severity {
  return SEVERITIES[Math.min(severityRank(severity) + 1, SEVERITIES.length - 1)] ?? severity;
}
