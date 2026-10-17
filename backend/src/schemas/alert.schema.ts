import { z } from 'zod';
import { ALERT_STATUSES, SEVERITIES } from '../services/monitoring/types.js';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

/** Accept a single value or a comma-separated list, case-insensitively: `severity=high,critical`. */
function enumList<T extends readonly [string, ...string[]]>(values: T) {
  return z
    .string()
    .transform((raw) => raw.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean))
    .pipe(z.array(z.enum(values)).min(1).max(values.length));
}

export const listAlertsQuerySchema = z
  .object({
    /** Defaults to ACTIVE. Use `ALL` for every status. */
    status: z
      .string()
      .optional()
      .transform((v) => (v ?? 'ACTIVE').trim().toUpperCase())
      .pipe(z.union([z.literal('ALL'), enumList(ALERT_STATUSES)])),
    severity: enumList(SEVERITIES).optional(),
    api_name: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

export type ListAlertsQuery = z.infer<typeof listAlertsQuerySchema>;

export const alertIdParamSchema = z.object({ id: z.string().uuid('id must be a valid UUID') });

export const updateStatusBodySchema = z
  .object({ status: z.enum(['ACKNOWLEDGED', 'RESOLVED'], { errorMap: () => ({ message: 'status must be ACKNOWLEDGED or RESOLVED' }) }) })
  .strict();

export const listChecksQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    api_name: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
