import type { Request, Response } from 'express';
import type { AppDeps } from '../container.js';
import { parseOrThrow } from '../middleware/validate.js';
import { listChecksQuerySchema } from '../schemas/alert.schema.js';
import { serializeCheck, serializeStats } from './serializers.js';

export function createSystemController(deps: AppDeps) {
  return {
    /** GET /health — liveness plus dependency status; no hosts, versions or credentials are disclosed. */
    async health(_req: Request, res: Response) {
      let database: 'up' | 'down' = 'up';
      try {
        await deps.prisma.$queryRaw`SELECT 1`;
      } catch {
        database = 'down';
      }
      const status = database === 'up' ? 'ok' : 'degraded';
      res.status(database === 'up' ? 200 : 503).json({
        status,
        uptime_s: Math.round(process.uptime()),
        dependencies: {
          database,
          llm: deps.llmProvider ? 'configured' : 'fallback_only',
          email: deps.emailService ? 'configured' : 'disabled',
        },
        ai_queue_pending: deps.enrichmentQueue.size,
      });
    },

    /** GET /stats — dashboard summary. */
    async stats(_req: Request, res: Response) {
      const stats = await deps.statsRepository.dashboard();
      res.json({
        data: {
          ...serializeStats(stats),
          config: {
            latency_threshold_ms: deps.thresholds.latencyThresholdMs,
            escalation_occurrences: deps.thresholds.escalationOccurrences,
            llm_mode: deps.llmProvider ? 'ai' : 'fallback_only',
            llm_model: deps.llmProvider?.model ?? null,
          },
        },
      });
    },

    /** GET /checks — most recent API checks (healthy and anomalous). */
    async checks(req: Request, res: Response) {
      const query = parseOrThrow(listChecksQuerySchema, req.query, 'query parameters');
      const checks = await deps.statsRepository.recentChecks(query.limit, query.api_name);
      res.json({ data: checks.map(serializeCheck) });
    },
  };
}
