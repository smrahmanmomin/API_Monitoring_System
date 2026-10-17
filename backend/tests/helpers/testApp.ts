import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { createDeps, type AppDeps } from '../../src/container.js';
import { LlmError } from '../../src/services/ai/openAiCompatibleProvider.js';
import { PROMPT_VERSION } from '../../src/services/ai/prompts/alertPrompt.v1.js';
import type { AlertContext, GeneratedAlert, LlmProvider } from '../../src/services/ai/types.js';
import { createLogger } from '../../src/utils/logger.js';
import { createPrismaClient, type PrismaClient } from '../../src/utils/prisma.js';
import { TEST_DATABASE_URL } from './testEnv.js';

/** Deterministic stand-in for the LLM: records calls and either succeeds or fails on demand. */
export class FakeLlmProvider implements LlmProvider {
  readonly name = 'fake';
  readonly model = 'fake-model-1';
  calls: AlertContext[] = [];

  /** 'fail-once' rejects the first call with a rate limit, then succeeds. */
  constructor(public mode: 'ok' | 'fail' | 'fail-once' = 'ok') {}

  async generate(context: AlertContext): Promise<GeneratedAlert> {
    this.calls.push(context);
    if (this.mode === 'fail') throw new LlmError('provider', 'simulated provider outage', 503);
    if (this.mode === 'fail-once' && this.calls.length === 1) throw new LlmError('rate_limited', 'simulated rate limit', 429);
    return {
      model: this.model,
      promptVersion: PROMPT_VERSION,
      content: {
        title: `AI: ${context.apiName} ${context.anomalyType}`,
        summary: `AI summary for ${context.apiName} with severity ${context.severity}.`,
        possibleCauses: ['Possible cause A'],
        recommendedActions: ['Do the first thing', 'Do the second thing'],
      },
    };
  }
}

let sharedPrisma: PrismaClient | undefined;

export function testPrisma(): PrismaClient {
  sharedPrisma ??= createPrismaClient(TEST_DATABASE_URL);
  return sharedPrisma;
}

export async function resetDatabase(): Promise<void> {
  await testPrisma().$executeRawUnsafe('TRUNCATE TABLE alert_occurrences, alerts, api_checks RESTART IDENTITY CASCADE');
}

export interface TestContext {
  app: Express;
  deps: AppDeps;
  llm: FakeLlmProvider | null;
}

export function buildTestApp(options: { llm?: FakeLlmProvider | null; env?: Record<string, string> } = {}): TestContext {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    RATE_LIMIT_MAX: '100000',
    MONITOR_RATE_LIMIT_MAX: '100000',
    MAX_BATCH_SIZE: '50',
    ESCALATION_OCCURRENCES: '3',
    LLM_RATE_LIMIT_RETRY_MS: '1000',
    LLM_RATE_LIMIT_ATTEMPTS: '2',
    ...options.env,
  });
  const llm = options.llm === undefined ? new FakeLlmProvider() : options.llm;
  const deps = createDeps(env, createLogger('silent', 'test'), testPrisma(), { llmProvider: llm, emailService: null });
  return { app: createApp(deps), deps, llm };
}
