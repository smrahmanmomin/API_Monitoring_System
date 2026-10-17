import { describe, expect, it } from 'vitest';
import { monitorEventSchema, parseMonitorBody, toMonitoringEvent } from '../../src/schemas/monitorEvent.schema.js';

const valid = { api_name: 'PatientDataAPI', response_time_ms: 1200, status_code: 200, records_returned: 50 };

describe('monitor event schema', () => {
  it('accepts the assignment example', () => {
    expect(monitorEventSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    [{ ...valid, api_name: '' }, 'api_name'],
    [{ ...valid, api_name: 'bad name; drop' }, 'api_name'],
    [{ ...valid, response_time_ms: -1 }, 'response_time_ms'],
    [{ ...valid, response_time_ms: '100' }, 'response_time_ms'],
    [{ ...valid, status_code: 99 }, 'status_code'],
    [{ ...valid, status_code: 600 }, 'status_code'],
    [{ ...valid, records_returned: { rows: [] } }, 'records_returned'],
    [{ ...valid, checked_at: 'yesterday' }, 'checked_at'],
    [{ ...valid, checked_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }, 'checked_at'],
  ])('rejects invalid field %#', (input, field) => {
    const result = monitorEventSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((i) => i.path[0] === field)).toBe(true);
  });

  it('rejects unknown properties (e.g. patient data)', () => {
    expect(monitorEventSchema.safeParse({ ...valid, patient_name: 'Jane Doe' }).success).toBe(false);
  });

  it('defaults checked_at to the server time and keeps a provided one', () => {
    const now = new Date('2026-05-01T10:00:00Z');
    expect(toMonitoringEvent(monitorEventSchema.parse(valid), now).checkedAt).toEqual(now);
    const provided = toMonitoringEvent(monitorEventSchema.parse({ ...valid, checked_at: '2026-04-30T09:00:00+02:00' }));
    expect(provided.checkedAt.toISOString()).toBe('2026-04-30T07:00:00.000Z');
  });
});

describe('parseMonitorBody', () => {
  it('wraps a single object', () => {
    expect(parseMonitorBody(valid, 10)).toEqual({ ok: true, items: [valid], isBatch: false });
  });

  it('accepts arrays within the limit', () => {
    expect(parseMonitorBody([valid, valid], 10)).toMatchObject({ ok: true, isBatch: true });
  });

  it.each([
    [[], 'EMPTY_BATCH'],
    [new Array(11).fill(valid), 'BATCH_TOO_LARGE'],
    ['text', 'INVALID_BODY'],
    [null, 'INVALID_BODY'],
    [42, 'INVALID_BODY'],
  ])('rejects %# with the right code', (body, code) => {
    expect(parseMonitorBody(body, 10)).toMatchObject({ ok: false, code });
  });
});
