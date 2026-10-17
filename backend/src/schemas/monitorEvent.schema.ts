import { z } from 'zod';
import type { MonitoringEvent, RecordsIssue } from '../services/monitoring/types.js';

/** Maximum tolerated clock skew for client-supplied `checked_at` values. */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Response times above this are treated as invalid input rather than latency (10 minutes). */
export const MAX_RESPONSE_TIME_MS = 10 * 60 * 1000;
const API_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Wire contract for one monitoring event (snake_case, as in the assignment).
 * Unknown properties are rejected (`strict`) so arbitrary payloads — e.g. raw patient
 * records — cannot be smuggled into storage or the LLM prompt.
 *
 * `records_returned` is deliberately tolerant: a missing, null, negative or non-integer
 * value is not a validation error but a data-quality anomaly detected by the rule engine.
 * Only primitive values are accepted, so nested objects/arrays are still rejected.
 */
export const monitorEventSchema = z
  .object({
    api_name: z
      .string({ required_error: 'api_name is required', invalid_type_error: 'api_name must be a string' })
      .trim()
      .min(1, 'api_name must not be empty')
      .max(100, 'api_name must be at most 100 characters')
      .regex(API_NAME_PATTERN, 'api_name may only contain letters, digits, ".", "_" and "-"'),
    response_time_ms: z
      .number({ required_error: 'response_time_ms is required', invalid_type_error: 'response_time_ms must be a number' })
      .int('response_time_ms must be an integer')
      .min(0, 'response_time_ms must be non-negative')
      .max(MAX_RESPONSE_TIME_MS, `response_time_ms must be at most ${MAX_RESPONSE_TIME_MS}`),
    status_code: z
      .number({ required_error: 'status_code is required', invalid_type_error: 'status_code must be a number' })
      .int('status_code must be an integer')
      .min(100, 'status_code must be a valid HTTP status (100-599)')
      .max(599, 'status_code must be a valid HTTP status (100-599)'),
    records_returned: z
      .union([z.number(), z.string().max(50), z.null()], {
        errorMap: () => ({ message: 'records_returned must be a number, numeric string or null' }),
      })
      .optional(),
    expected_min_records: z
      .number({ invalid_type_error: 'expected_min_records must be a number' })
      .int('expected_min_records must be an integer')
      .min(0, 'expected_min_records must be non-negative')
      .max(1_000_000_000)
      .optional(),
    checked_at: z
      .string({ invalid_type_error: 'checked_at must be a string' })
      .datetime({ offset: true, message: 'checked_at must be an ISO-8601 timestamp' })
      .refine((v) => new Date(v).getTime() <= Date.now() + MAX_FUTURE_SKEW_MS, 'checked_at must not be in the future')
      .optional(),
  })
  .strict();

export type MonitorEventInput = z.infer<typeof monitorEventSchema>;

function classifyRecords(raw: MonitorEventInput['records_returned']): {
  recordsReturned: number | null;
  recordsIssue: RecordsIssue | null;
} {
  if (raw === undefined) return { recordsReturned: null, recordsIssue: 'missing' };
  if (raw === null) return { recordsReturned: null, recordsIssue: 'null' };
  const value = typeof raw === 'string' ? (raw.trim() === '' ? Number.NaN : Number(raw)) : raw;
  if (!Number.isFinite(value)) return { recordsReturned: null, recordsIssue: 'not_a_number' };
  if (!Number.isInteger(value)) return { recordsReturned: null, recordsIssue: 'non_integer' };
  if (value < 0) return { recordsReturned: null, recordsIssue: 'negative' };
  return { recordsReturned: value, recordsIssue: null };
}

/** Normalise a validated wire event into the engine's domain model. */
export function toMonitoringEvent(input: MonitorEventInput, now: Date = new Date()): MonitoringEvent {
  const { recordsReturned, recordsIssue } = classifyRecords(input.records_returned);
  const event: MonitoringEvent = {
    apiName: input.api_name,
    responseTimeMs: input.response_time_ms,
    statusCode: input.status_code,
    recordsReturned,
    recordsIssue,
    checkedAt: input.checked_at ? new Date(input.checked_at) : now,
  };
  if (recordsIssue !== null && recordsIssue !== 'missing') event.rawRecordsValue = input.records_returned ?? null;
  if (input.expected_min_records !== undefined) event.expectedMinRecords = input.expected_min_records;
  return event;
}

export type ParsedMonitorBody =
  | { ok: true; items: unknown[]; isBatch: boolean }
  | { ok: false; code: 'INVALID_BODY' | 'EMPTY_BATCH' | 'BATCH_TOO_LARGE'; message: string };

/** Request body: one event object or a non-empty array of events. Items are validated individually later. */
export function parseMonitorBody(body: unknown, maxBatchSize: number): ParsedMonitorBody {
  if (Array.isArray(body)) {
    if (body.length === 0) return { ok: false, code: 'EMPTY_BATCH', message: 'Batch must contain at least one event' };
    if (body.length > maxBatchSize) {
      return { ok: false, code: 'BATCH_TOO_LARGE', message: `Batch contains ${body.length} events; the maximum is ${maxBatchSize}` };
    }
    return { ok: true, items: body, isBatch: true };
  }
  if (body !== null && typeof body === 'object') return { ok: true, items: [body], isBatch: false };
  return { ok: false, code: 'INVALID_BODY', message: 'Request body must be a monitoring event object or an array of events' };
}
