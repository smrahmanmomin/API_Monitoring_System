import type { MonitoringThresholds } from '../../config/thresholds.js';
import { monitorEventSchema, toMonitoringEvent } from '../../schemas/monitorEvent.schema.js';
import { formatZodIssues, type ValidationIssue } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import type { AlertService, RecordedAlert } from '../alerts/alertService.js';
import type { EnrichmentQueue } from '../ai/enrichmentQueue.js';
import { evaluateEvent } from './ruleEngine.js';
import type { CheckSource, Finding } from './types.js';

export type ItemResult =
  | { index: number; status: 'accepted'; check_id: string; api_name: string; anomalies: FindingDto[]; alerts: AlertRefDto[] }
  | { index: number; status: 'rejected'; errors: ValidationIssue[] }
  | { index: number; status: 'failed'; api_name: string; error: { code: string; message: string } };

export interface FindingDto {
  type: Finding['type'];
  severity: Finding['severity'];
  message: string;
  observed: Finding['observed'];
  expected: Finding['expected'];
}

export interface AlertRefDto {
  alert_id: string;
  type: RecordedAlert['type'];
  severity: RecordedAlert['severity'];
  outcome: RecordedAlert['outcome'];
}

export interface IngestSummary {
  received: number;
  accepted: number;
  rejected: number;
  failed: number;
  with_anomalies: number;
  anomalies_detected: number;
  alerts_created: number;
  alerts_updated: number;
}

export interface IngestResult {
  summary: IngestSummary;
  results: ItemResult[];
}

/**
 * Orchestrates ingestion: validate → detect → persist → schedule AI enrichment.
 * Each item is processed independently so one bad item never discards the rest of a batch.
 * Items are processed sequentially to keep dedup/grouping deterministic within a batch.
 */
export class MonitoringService {
  constructor(
    private readonly thresholds: MonitoringThresholds,
    private readonly alertService: AlertService,
    private readonly enrichmentQueue: EnrichmentQueue,
    private readonly logger: Logger,
  ) {}

  async ingest(items: unknown[], source: CheckSource, log: Logger = this.logger): Promise<IngestResult> {
    const results: ItemResult[] = [];
    const toEnrich = new Map<string, 'created' | 'escalated'>();

    for (const [index, item] of items.entries()) {
      const parsed = monitorEventSchema.safeParse(item);
      if (!parsed.success) {
        results.push({ index, status: 'rejected', errors: formatZodIssues(parsed.error.issues) });
        continue;
      }

      const event = toMonitoringEvent(parsed.data);
      const findings = evaluateEvent(event, this.thresholds);

      try {
        const recorded = await this.alertService.recordCheck(event, findings, source);
        for (const alert of recorded.alerts) {
          if (alert.outcome !== 'updated') toEnrich.set(alert.alertId, toEnrich.get(alert.alertId) === 'created' ? 'created' : alert.outcome);
        }
        if (findings.length > 0) {
          log.info(
            { apiName: event.apiName, checkId: recorded.checkId, anomalies: findings.map((f) => `${f.type}:${f.severity}`) },
            'anomalies detected',
          );
        }
        results.push({
          index,
          status: 'accepted',
          check_id: recorded.checkId,
          api_name: event.apiName,
          anomalies: findings.map((f) => ({ type: f.type, severity: f.severity, message: f.message, observed: f.observed, expected: f.expected })),
          alerts: recorded.alerts.map((a) => ({ alert_id: a.alertId, type: a.type, severity: a.severity, outcome: a.outcome })),
        });
      } catch (error) {
        log.error({ err: error, apiName: event.apiName, index }, 'failed to persist monitoring event');
        results.push({ index, status: 'failed', api_name: event.apiName, error: { code: 'PERSISTENCE_FAILED', message: 'The event could not be stored; retry later' } });
      }
    }

    // Schedule AI enrichment only after persistence has committed.
    for (const [alertId, reason] of toEnrich) this.enrichmentQueue.enqueue({ alertId, reason });

    const summary = summarise(results);
    log.info({ source, ...summary }, 'monitoring batch processed');
    return { summary, results };
  }
}

function summarise(results: ItemResult[]): IngestSummary {
  const summary: IngestSummary = {
    received: results.length,
    accepted: 0,
    rejected: 0,
    failed: 0,
    with_anomalies: 0,
    anomalies_detected: 0,
    alerts_created: 0,
    alerts_updated: 0,
  };
  for (const r of results) {
    if (r.status === 'accepted') {
      summary.accepted += 1;
      if (r.anomalies.length > 0) summary.with_anomalies += 1;
      summary.anomalies_detected += r.anomalies.length;
      for (const a of r.alerts) {
        if (a.outcome === 'created') summary.alerts_created += 1;
        else summary.alerts_updated += 1;
      }
    } else if (r.status === 'rejected') summary.rejected += 1;
    else summary.failed += 1;
  }
  return summary;
}
