import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDeps } from './container.js';
import { createLogger } from './utils/logger.js';
import { createPrismaClient } from './utils/prisma.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV);
  const prisma = createPrismaClient(env.DATABASE_URL);
  const deps = createDeps(env, logger, prisma);

  await prisma.$connect();
  const app = createApp(deps);
  const server = app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        llm: deps.llmProvider ? `enabled (${deps.llmProvider.model})` : 'fallback only (no LLM_API_KEY or LLM_ENABLED=false)',
        email: deps.emailService ? 'enabled' : 'disabled',
        latencyThresholdMs: deps.thresholds.latencyThresholdMs,
      },
      'API monitor listening',
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    server.close(async () => {
      await deps.enrichmentQueue.drain();
      await prisma.$disconnect();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  // Logger may not exist yet (e.g. invalid env), so fall back to stderr.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
