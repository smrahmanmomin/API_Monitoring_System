import type { AnomalyType, EvidenceValue, Finding, MonitoringEvent, RecordsIssue, Severity } from '../monitoring/types.js';

/**
 * Structured evidence stored with every alert. It contains only monitoring metadata —
 * never response bodies or patient data — and is the sole input to the LLM prompt.
 */
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
    recordsIssue: RecordsIssue | null;
    expectedMinRecords: number | null;
    latencyThresholdMs: number;
  };
  /** Other anomalies detected in the same API check. */
  relatedFindings: Array<{ type: AnomalyType; severity: Severity; message: string }>;
  escalation?: { fromSeverity: Severity; toSeverity: Severity; occurrenceCount: number };
}

export interface CheckExpectations {
  expectedMinRecords: number | undefined;
  latencyThresholdMs: number;
}

export function buildEvidence(event: MonitoringEvent, finding: Finding, allFindings: Finding[], expectations: CheckExpectations): AlertEvidence {
  return {
    finding: {
      type: finding.type,
      severity: finding.severity,
      message: finding.message,
      observed: finding.observed,
      expected: finding.expected,
      checkedAt: finding.checkedAt,
      detectedAt: finding.detectedAt,
    },
    check: {
      statusCode: event.statusCode,
      responseTimeMs: event.responseTimeMs,
      recordsReturned: event.recordsReturned,
      recordsIssue: event.recordsIssue,
      expectedMinRecords: expectations.expectedMinRecords ?? null,
      latencyThresholdMs: expectations.latencyThresholdMs,
    },
    relatedFindings: allFindings
      .filter((f) => f.type !== finding.type)
      .map((f) => ({ type: f.type, severity: f.severity, message: f.message })),
  };
}

export function fingerprintFor(apiName: string, type: AnomalyType): string {
  return `${apiName}:${type}`;
}
