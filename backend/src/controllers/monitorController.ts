import type { Request, Response } from 'express';
import type { AppDeps } from '../container.js';
import { parseMonitorBody } from '../schemas/monitorEvent.schema.js';
import { AppError } from '../utils/errors.js';
import { CHECK_SOURCES, type CheckSource } from '../services/monitoring/types.js';

/** Clients may label where events came from (`X-Monitor-Source: demo|file|api`); anything else is API. */
function sourceFrom(req: Request): CheckSource {
  const header = req.get('x-monitor-source')?.trim().toUpperCase();
  return CHECK_SOURCES.find((s) => s === header) ?? 'API';
}

/**
 * POST /monitor
 *
 * Partial-failure strategy:
 *   201 — every item accepted
 *   207 — some items accepted, some rejected/failed (see `results[]`, one entry per input index)
 *   400 — body is not an event/array, or no item passed validation
 *   413 — batch exceeds MAX_BATCH_SIZE or body exceeds the size limit
 *   503 — no item could be persisted (database failure)
 */
export function createMonitorController(deps: AppDeps) {
  return {
    async ingest(req: Request, res: Response) {
      const parsed = parseMonitorBody(req.body, deps.env.MAX_BATCH_SIZE);
      if (!parsed.ok) {
        throw new AppError(parsed.code === 'BATCH_TOO_LARGE' ? 413 : 400, parsed.code, parsed.message);
      }

      const result = await deps.monitoringService.ingest(parsed.items, sourceFrom(req), req.log);
      const { accepted, received, failed } = result.summary;

      if (accepted === 0 && failed === 0) {
        throw AppError.badRequest('No monitoring events passed validation', result.results, 'VALIDATION_ERROR');
      }
      if (accepted === 0) {
        throw new AppError(503, 'PERSISTENCE_FAILED', 'Monitoring events could not be stored', result.results);
      }
      res.status(accepted === received ? 201 : 207).json(result);
    },
  };
}
