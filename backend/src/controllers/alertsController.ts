import type { Request, Response } from 'express';
import type { AppDeps } from '../container.js';
import { parseOrThrow } from '../middleware/validate.js';
import { alertIdParamSchema, listAlertsQuerySchema, updateStatusBodySchema } from '../schemas/alert.schema.js';
import { AppError } from '../utils/errors.js';
import { serializeAlert, serializeAlertDetail } from './serializers.js';

export function createAlertsController(deps: AppDeps) {
  return {
    /** GET /alerts — active alerts by default; filter by status, severity, api_name; paginate with limit/offset. */
    async list(req: Request, res: Response) {
      const query = parseOrThrow(listAlertsQuerySchema, req.query, 'query parameters');
      const { data, total } = await deps.alertRepository.list(query);
      res.json({
        data: data.map(serializeAlert),
        pagination: { total, limit: query.limit, offset: query.offset, has_more: query.offset + data.length < total },
        filters: { status: query.status, severity: query.severity ?? null, api_name: query.api_name ?? null },
      });
    },

    /** GET /alerts/:id */
    async get(req: Request, res: Response) {
      const { id } = parseOrThrow(alertIdParamSchema, req.params, 'alert id');
      const alert = await deps.alertRepository.findById(id);
      if (!alert) throw AppError.notFound(`Alert ${id} was not found`);
      res.json({ data: serializeAlertDetail(alert) });
    },

    /** PATCH /alerts/:id/status — { "status": "ACKNOWLEDGED" | "RESOLVED" } */
    async updateStatus(req: Request, res: Response) {
      const { id } = parseOrThrow(alertIdParamSchema, req.params, 'alert id');
      const { status } = parseOrThrow(updateStatusBodySchema, req.body ?? {}, 'request body');
      const alert = await deps.alertService.updateStatus(id, status);
      res.json({ data: serializeAlert(alert) });
    },

    /** POST /alerts/:id/regenerate — synchronously retry AI generation for one alert. */
    async regenerate(req: Request, res: Response) {
      const { id } = parseOrThrow(alertIdParamSchema, req.params, 'alert id');
      const existing = await deps.prisma.alert.findUnique({ where: { id }, select: { status: true } });
      if (!existing) throw AppError.notFound(`Alert ${id} was not found`);
      if (existing.status === 'RESOLVED') throw AppError.conflict('Resolved alerts cannot be regenerated');
      if (!deps.llmProvider) throw new AppError(503, 'LLM_NOT_CONFIGURED', 'No LLM provider is configured; alerts use deterministic fallback text');

      const result = await deps.enrichmentQueue.process({ alertId: id, reason: 'manual' });
      const alert = await deps.alertRepository.findById(id);
      if (!alert) throw AppError.notFound(`Alert ${id} was not found`);
      res.json({ data: serializeAlertDetail(alert), generation_result: result });
    },
  };
}
