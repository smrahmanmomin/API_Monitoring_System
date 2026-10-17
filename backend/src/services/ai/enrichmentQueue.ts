import type { Alert, PrismaClient } from '@prisma/client';
import type { Logger } from '../../utils/logger.js';
import { alertToContext } from '../alerts/alertService.js';
import { LlmError } from './openAiCompatibleProvider.js';
import type { LlmProvider } from './types.js';

export type EnrichmentReason = 'created' | 'escalated' | 'manual';

export interface EnrichmentJob {
  alertId: string;
  reason: EnrichmentReason;
  /** Internal: number of times this job was re-queued because the alert changed mid-generation. */
  attempt?: number;
  /** Internal: number of rate-limit retries already scheduled for this job. */
  rateLimitAttempt?: number;
}

export interface RateLimitRetryPolicy {
  /** Wait before re-queueing a job that hit the provider's rate limit. */
  retryDelayMs: number;
  /** Maximum rate-limit retries per job (0 = give up immediately and keep fallback text). */
  maxAttempts: number;
}

/** Bound on re-queues for a frequently updated alert; afterwards the last AI text is kept as-is. */
const MAX_REQUEUES = 2;

export type EnrichmentResult = 'ai' | 'fallback' | 'skipped';

/** Called once AI enrichment has finished (successfully or not), e.g. to send an e-mail with final content. */
export type AlertReadyListener = (alert: Alert, reason: EnrichmentReason) => Promise<void>;

/**
 * In-process, bounded-concurrency queue that upgrades fallback alert text to LLM text
 * after ingestion has committed. Ingestion never waits for the LLM.
 *
 * Trade-off: jobs are in memory and lost on restart. That is acceptable because every
 * alert already has persisted fallback content; `POST /alerts/:id/regenerate` retries manually.
 */
export class EnrichmentQueue {
  private readonly pending: EnrichmentJob[] = [];
  private readonly queuedIds = new Set<string>();
  private running = 0;
  private idleWaiters: Array<() => void> = [];
  /** Jobs waiting for a rate-limit retry timer; counted in `size` so drain() waits for them. */
  private delayed = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: LlmProvider | null,
    private readonly logger: Logger,
    private readonly concurrency: number,
    private readonly rateLimitPolicy: RateLimitRetryPolicy = { retryDelayMs: 20_000, maxAttempts: 0 },
    private readonly onAlertReady?: AlertReadyListener,
  ) {}

  enqueue(job: EnrichmentJob): void {
    if (this.queuedIds.has(job.alertId)) return; // already waiting; it will read the latest evidence
    this.queuedIds.add(job.alertId);
    this.pending.push(job);
    this.pump();
  }

  get size(): number {
    return this.pending.length + this.running + this.delayed;
  }

  /** Resolves when all queued work has finished (used by tests and graceful shutdown). */
  drain(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.queuedIds.delete(job.alertId);
      this.running += 1;
      void this.process(job)
        .catch((error: unknown) => this.logger.error({ err: error, alertId: job.alertId }, 'alert enrichment job crashed'))
        .finally(() => {
          this.running -= 1;
          this.pump();
          this.notifyIfIdle();
        });
    }
  }

  private notifyIfIdle(): void {
    if (this.size !== 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  /** Re-queue a rate-limited job after a delay. Returns false when retries are exhausted. */
  private scheduleRateLimitRetry(job: EnrichmentJob): boolean {
    const attempt = (job.rateLimitAttempt ?? 0) + 1;
    if (job.reason === 'manual' || attempt > this.rateLimitPolicy.maxAttempts) return false;
    this.delayed += 1;
    const timer = setTimeout(() => {
      this.delayed -= 1;
      this.enqueue({ ...job, rateLimitAttempt: attempt });
      this.notifyIfIdle();
    }, this.rateLimitPolicy.retryDelayMs);
    timer.unref?.();
    this.logger.info({ alertId: job.alertId, attempt, delayMs: this.rateLimitPolicy.retryDelayMs }, 'LLM rate limited; AI generation re-scheduled');
    return true;
  }

  /** Generate AI content for one alert. Exposed for the synchronous regenerate endpoint. */
  async process(job: EnrichmentJob): Promise<EnrichmentResult> {
    const alert = await this.prisma.alert.findUnique({ where: { id: job.alertId } });
    if (!alert || alert.status === 'RESOLVED') return 'skipped';

    let result: EnrichmentResult = 'fallback';
    let finalAlert: Alert = alert;

    if (this.provider) {
      const started = Date.now();
      try {
        const generated = await this.provider.generate(alertToContext(alert));
        // Only overwrite if the evidence we explained is still the latest (no newer detection raced us).
        const update = await this.prisma.alert.updateMany({
          where: { id: alert.id, updatedAt: alert.updatedAt },
          data: {
            title: generated.content.title,
            summary: generated.content.summary,
            possibleCauses: generated.content.possibleCauses,
            recommendedActions: generated.content.recommendedActions,
            generationSource: 'AI',
            aiModel: generated.model,
            promptVersion: generated.promptVersion,
            generatedAt: new Date(),
          },
        });
        if (update.count === 0) {
          const attempt = (job.attempt ?? 0) + 1;
          if (attempt <= MAX_REQUEUES) {
            this.logger.info({ alertId: alert.id, attempt }, 'alert changed during AI generation; re-queueing');
            this.enqueue({ alertId: alert.id, reason: job.reason, attempt });
            return 'skipped';
          }
          this.logger.info({ alertId: alert.id }, 'alert keeps changing; leaving latest content in place');
        } else {
          result = 'ai';
        }
        finalAlert = (await this.prisma.alert.findUnique({ where: { id: alert.id } })) ?? alert;
        this.logger.info(
          { alertId: alert.id, apiName: alert.apiName, model: generated.model, durationMs: Date.now() - started },
          'AI alert content generated',
        );
      } catch (error) {
        const kind = error instanceof LlmError ? error.kind : 'unknown';
        // Free tiers limit tokens per minute: wait and retry instead of settling for fallback text.
        // The e-mail (if any) is sent once the final attempt has finished.
        if (kind === 'rate_limited' && this.scheduleRateLimitRetry(job)) return 'skipped';
        this.logger.warn(
          { alertId: alert.id, apiName: alert.apiName, kind, reason: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started },
          'LLM generation failed; keeping deterministic fallback alert',
        );
      }
    }

    if (this.onAlertReady) {
      try {
        await this.onAlertReady(finalAlert, job.reason);
      } catch (error) {
        this.logger.warn({ alertId: alert.id, err: error }, 'alert-ready listener failed');
      }
    }
    return result;
  }
}
