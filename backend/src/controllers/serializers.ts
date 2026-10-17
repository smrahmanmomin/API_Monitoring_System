import type { Alert, AlertOccurrence, ApiCheck } from '@prisma/client';
import type { DashboardStats } from '../repositories/statsRepository.js';

/** Public (snake_case) response shapes — consistent with the snake_case ingestion contract. */

export function serializeCheck(check: ApiCheck) {
  return {
    id: check.id,
    api_name: check.apiName,
    response_time_ms: check.responseTimeMs,
    status_code: check.statusCode,
    records_returned: check.recordsReturned,
    records_issue: check.recordsIssue,
    expected_min_records: check.expectedMinRecords,
    anomaly_count: check.anomalyCount,
    source: check.source,
    checked_at: check.checkedAt.toISOString(),
    created_at: check.createdAt.toISOString(),
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function serializeAlert(alert: Alert & { latestCheck?: ApiCheck | null }) {
  return {
    id: alert.id,
    api_name: alert.apiName,
    anomaly_type: alert.anomalyType,
    severity: alert.severity,
    base_severity: alert.baseSeverity,
    status: alert.status,
    title: alert.title,
    summary: alert.summary,
    possible_causes: alert.possibleCauses,
    recommended_actions: alert.recommendedActions,
    evidence: alert.evidence,
    generation: {
      source: alert.generationSource,
      model: alert.aiModel,
      prompt_version: alert.promptVersion,
      generated_at: iso(alert.generatedAt),
    },
    occurrence_count: alert.occurrenceCount,
    first_seen_at: alert.firstSeenAt.toISOString(),
    last_seen_at: alert.lastSeenAt.toISOString(),
    acknowledged_at: iso(alert.acknowledgedAt),
    resolved_at: iso(alert.resolvedAt),
    created_at: alert.createdAt.toISOString(),
    updated_at: alert.updatedAt.toISOString(),
    latest_check: alert.latestCheck ? serializeCheck(alert.latestCheck) : null,
  };
}

export function serializeAlertDetail(alert: Alert & { latestCheck: ApiCheck | null; occurrences: Array<AlertOccurrence & { check: ApiCheck }> }) {
  return {
    ...serializeAlert(alert),
    recent_occurrences: alert.occurrences.map((o) => ({ detected_at: o.detectedAt.toISOString(), check: serializeCheck(o.check) })),
  };
}

export function serializeStats(stats: DashboardStats) {
  return {
    total_checks: stats.totalChecks,
    checks_last_24h: stats.checksLast24h,
    anomalous_checks: stats.anomalousChecks,
    alerts: {
      active: stats.activeAlerts,
      acknowledged: stats.acknowledgedAlerts,
      resolved: stats.resolvedAlerts,
      critical_or_high_active: stats.criticalOrHighActive,
    },
    monitored_apis: stats.monitoredApis,
    affected_apis: stats.affectedApis.map((a) => ({ api_name: a.apiName, open_alerts: a.openAlerts, highest_severity: a.highestSeverity })),
    api_health: stats.apiHealth.map(serializeCheck),
  };
}
