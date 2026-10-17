import { Prisma, type Alert, type PrismaClient } from '@prisma/client';
import type { MonitoringThresholds } from '../../config/thresholds.js';
import { AppError, isUniqueViolation } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { generateFallbackAlert } from '../ai/fallbackGenerator.js';
import type { AlertContext } from '../ai/types.js';
import type { AlertStatus, CheckSource, Finding, MonitoringEvent } from '../monitoring/types.js';
import { buildEvidence, fingerprintFor, type AlertEvidence } from './evidence.js';
import { canTransition, computeGroupedSeverity } from './lifecycle.js';

export type AlertOutcome = 'created' | 'updated' | 'escalated';

export interface RecordedAlert {
  alertId: string;
  type: Finding['type'];
  severity: Alert['severity'];
  outcome: AlertOutcome;
}

export interface RecordCheckResult {
  checkId: string;
  alerts: RecordedAlert[];
}

/** Build the generator context from a persisted alert row. */
export function alertToContext(
  alert: Pick<Alert, 'apiName' | 'anomalyType' | 'severity' | 'occurrenceCount' | 'firstSeenAt' | 'lastSeenAt'> & { evidence: unknown },
): AlertContext {
  return {
    apiName: alert.apiName,
    anomalyType: alert.anomalyType,
    severity: alert.severity,
    occurrenceCount: alert.occurrenceCount,
    firstSeenAt: alert.firstSeenAt.toISOString(),
    lastSeenAt: alert.lastSeenAt.toISOString(),
    evidence: alert.evidence as AlertEvidence,
  };
}

function fallbackFields(ctx: AlertContext) {
  const content = generateFallbackAlert(ctx);
  return {
    title: content.title,
    summary: content.summary,
    possibleCauses: content.possibleCauses,
    recommendedActions: content.recommendedActions,
    generationSource: 'FALLBACK' as const,
    aiModel: null,
    promptVersion: null,
    generatedAt: new Date(),
  };
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

export class AlertService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly thresholds: MonitoringThresholds,
    private readonly logger: Logger,
  ) {}

  /**
   * Persist one API check and create or update (deduplicate) an alert per finding,
   * atomically. New alerts get deterministic fallback content immediately so nothing
   * depends on the LLM being available.
   */
  async recordCheck(event: MonitoringEvent, findings: Finding[], source: CheckSource): Promise<RecordCheckResult> {
    try {
      return await this.recordCheckOnce(event, findings, source);
    } catch (error) {
      // A concurrent request opened the same alert between our read and insert: retry once,
      // which will now take the "update existing alert" path.
      if (isUniqueViolation(error)) {
        this.logger.debug({ apiName: event.apiName }, 'open-alert race detected, retrying check persistence');
        return this.recordCheckOnce(event, findings, source);
      }
      throw error;
    }
  }

  private recordCheckOnce(event: MonitoringEvent, findings: Finding[], source: CheckSource): Promise<RecordCheckResult> {
    const override = this.thresholds.perApi[event.apiName];
    const expectedMin = event.expectedMinRecords ?? override?.expectedMinRecords;
    const expectations = { expectedMinRecords: expectedMin, latencyThresholdMs: override?.latencyThresholdMs ?? this.thresholds.latencyThresholdMs };

    return this.prisma.$transaction(async (tx) => {
      const check = await tx.apiCheck.create({
        data: {
          apiName: event.apiName,
          responseTimeMs: event.responseTimeMs,
          statusCode: event.statusCode,
          recordsReturned: event.recordsReturned,
          recordsIssue: event.recordsIssue,
          expectedMinRecords: expectedMin ?? null,
          checkedAt: event.checkedAt,
          anomalyCount: findings.length,
          source,
        },
      });

      const alerts: RecordedAlert[] = [];
      for (const finding of findings) {
        const evidence = buildEvidence(event, finding, findings, expectations);
        const fingerprint = fingerprintFor(event.apiName, finding.type);
        const open = await tx.alert.findFirst({ where: { fingerprint, status: { not: 'RESOLVED' } } });

        let alert: Alert;
        let outcome: AlertOutcome;

        if (!open) {
          const base = {
            apiName: event.apiName,
            anomalyType: finding.type,
            severity: finding.severity,
            occurrenceCount: 1,
            firstSeenAt: event.checkedAt,
            lastSeenAt: event.checkedAt,
            evidence,
          };
          alert = await tx.alert.create({
            data: {
              ...base,
              fingerprint,
              baseSeverity: finding.severity,
              status: 'ACTIVE',
              evidence: json(evidence),
              latestCheckId: check.id,
              ...fallbackFields(alertToContext(base)),
            },
          });
          outcome = 'created';
        } else {
          const occurrenceCount = open.occurrenceCount + 1;
          const grouped = computeGroupedSeverity({
            currentSeverity: open.severity,
            currentBaseSeverity: open.baseSeverity,
            findingSeverity: finding.severity,
            occurrenceCount,
            escalationOccurrences: this.thresholds.escalationOccurrences,
          });
          if (grouped.escalated) {
            evidence.escalation = { fromSeverity: open.severity, toSeverity: grouped.severity, occurrenceCount };
          }
          const firstSeenAt = event.checkedAt < open.firstSeenAt ? event.checkedAt : open.firstSeenAt;
          const lastSeenAt = event.checkedAt > open.lastSeenAt ? event.checkedAt : open.lastSeenAt;
          const updated = { severity: grouped.severity, occurrenceCount, firstSeenAt, lastSeenAt };

          alert = await tx.alert.update({
            where: { id: open.id },
            data: {
              ...updated,
              evidence: json(evidence),
              baseSeverity: grouped.baseSeverity,
              latestCheckId: check.id,
              // Fallback text is cheap and deterministic, so keep it in sync with the latest evidence.
              // AI text is regenerated asynchronously only when severity increases.
              ...(open.generationSource === 'FALLBACK' || grouped.increased
                ? fallbackFields(alertToContext({ apiName: open.apiName, anomalyType: open.anomalyType, ...updated, evidence }))
                : {}),
            },
          });
          outcome = grouped.increased ? 'escalated' : 'updated';
        }

        await tx.alertOccurrence.create({ data: { alertId: alert.id, checkId: check.id, detectedAt: new Date(finding.detectedAt) } });
        alerts.push({ alertId: alert.id, type: finding.type, severity: alert.severity, outcome });
      }

      return { checkId: check.id, alerts };
    });
  }

  async updateStatus(id: string, status: Extract<AlertStatus, 'ACKNOWLEDGED' | 'RESOLVED'>): Promise<Alert> {
    const alert = await this.prisma.alert.findUnique({ where: { id } });
    if (!alert) throw AppError.notFound(`Alert ${id} was not found`);
    if (!canTransition(alert.status, status)) {
      throw AppError.conflict(`Cannot change alert status from ${alert.status} to ${status}`, { currentStatus: alert.status });
    }
    const now = new Date();
    // Conditional update guards against a concurrent transition.
    const result = await this.prisma.alert.updateMany({
      where: { id, status: alert.status },
      data: {
        status,
        ...(status === 'ACKNOWLEDGED' ? { acknowledgedAt: now } : {}),
        ...(status === 'RESOLVED' ? { resolvedAt: now } : {}),
      },
    });
    if (result.count === 0) throw AppError.conflict('Alert status changed concurrently; reload and retry');
    this.logger.info({ alertId: id, apiName: alert.apiName, from: alert.status, to: status }, 'alert status changed');
    return this.prisma.alert.findUniqueOrThrow({ where: { id } });
  }
}
