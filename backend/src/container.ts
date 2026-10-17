import type { PrismaClient } from '@prisma/client';
import type { Env } from './config/env.js';
import { thresholdsFromEnv, type MonitoringThresholds } from './config/thresholds.js';
import { AlertRepository } from './repositories/alertRepository.js';
import { StatsRepository } from './repositories/statsRepository.js';
import { AlertService } from './services/alerts/alertService.js';
import { EnrichmentQueue } from './services/ai/enrichmentQueue.js';
import { OpenAiCompatibleProvider } from './services/ai/openAiCompatibleProvider.js';
import type { LlmProvider } from './services/ai/types.js';
import { MonitoringService } from './services/monitoring/monitoringService.js';
import { EmailService } from './services/notifications/emailService.js';
import type { Logger } from './utils/logger.js';

/** Wired application services. Built once in server.ts; tests build it with fakes. */
export interface AppDeps {
  env: Env;
  logger: Logger;
  prisma: PrismaClient;
  thresholds: MonitoringThresholds;
  llmProvider: LlmProvider | null;
  emailService: EmailService | null;
  enrichmentQueue: EnrichmentQueue;
  alertService: AlertService;
  monitoringService: MonitoringService;
  alertRepository: AlertRepository;
  statsRepository: StatsRepository;
}

export interface DepOverrides {
  /** `null` forces fallback-only mode; `undefined` builds the provider from env. */
  llmProvider?: LlmProvider | null;
  emailService?: EmailService | null;
}

export function createLlmProvider(env: Env): LlmProvider | null {
  if (!env.LLM_ENABLED || !env.LLM_API_KEY) return null;
  return new OpenAiCompatibleProvider({
    baseURL: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxRetries: env.LLM_MAX_RETRIES,
    maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
    ...(env.LLM_REASONING_EFFORT ? { reasoningEffort: env.LLM_REASONING_EFFORT } : {}),
  });
}

export function createEmailService(env: Env, logger: Logger): EmailService | null {
  if (!env.SMTP_HOST || !env.ALERT_EMAIL_TO) return null;
  return new EmailService(
    {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
      ...(env.SMTP_PASSWORD ? { password: env.SMTP_PASSWORD } : {}),
      from: env.ALERT_EMAIL_FROM,
      to: env.ALERT_EMAIL_TO,
      minSeverity: env.EMAIL_MIN_SEVERITY,
      dashboardUrl: env.DASHBOARD_URL,
    },
    logger.child({ module: 'email' }),
  );
}

export function createDeps(env: Env, logger: Logger, prisma: PrismaClient, overrides: DepOverrides = {}): AppDeps {
  const thresholds = thresholdsFromEnv(env);
  const llmProvider = overrides.llmProvider !== undefined ? overrides.llmProvider : createLlmProvider(env);
  const emailService = overrides.emailService !== undefined ? overrides.emailService : createEmailService(env, logger);

  const enrichmentQueue = new EnrichmentQueue(
    prisma,
    llmProvider,
    logger.child({ module: 'ai' }),
    env.LLM_CONCURRENCY,
    { retryDelayMs: env.LLM_RATE_LIMIT_RETRY_MS, maxAttempts: env.LLM_RATE_LIMIT_ATTEMPTS },
    emailService ? (alert, reason) => emailService.notify(alert, reason).then(() => undefined) : undefined,
  );
  const alertService = new AlertService(prisma, thresholds, logger.child({ module: 'alerts' }));
  const monitoringService = new MonitoringService(thresholds, alertService, enrichmentQueue, logger.child({ module: 'monitoring' }));

  return {
    env,
    logger,
    prisma,
    thresholds,
    llmProvider,
    emailService,
    enrichmentQueue,
    alertService,
    monitoringService,
    alertRepository: new AlertRepository(prisma),
    statsRepository: new StatsRepository(prisma),
  };
}
