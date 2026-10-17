import { describe, expect, it } from 'vitest';
import { alertsQuery } from '../api/client';
import { formatMs, latencyFill, recordsLabel, statusTone, timeAgo } from './format';

describe('format helpers', () => {
  it('formats durations', () => {
    expect(formatMs(5500)).toBe('5,500 ms');
    expect(formatMs(12_340)).toBe('12.3 s');
  });

  it('formats relative time', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(timeAgo('2026-01-01T11:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-01-01T11:55:00Z', now)).toBe('5m ago');
    expect(timeAgo('2026-01-01T09:00:00Z', now)).toBe('3h ago');
    expect(timeAgo('2025-12-28T12:00:00Z', now)).toBe('4d ago');
  });

  it('labels record counts', () => {
    expect(recordsLabel({ records_returned: 0, records_issue: null })).toBe('0');
    expect(recordsLabel({ records_returned: null, records_issue: 'missing' })).toBe('not reported');
    expect(recordsLabel({ records_returned: null, records_issue: 'negative' })).toBe('invalid');
  });

  it('classifies status tones', () => {
    expect(statusTone(200)).toBe('ok');
    expect(statusTone(429)).toBe('warn');
    expect(statusTone(500)).toBe('fail');
    expect(statusTone(401)).toBe('fail');
  });

  it('scales latency bars against the threshold marker', () => {
    expect(latencyFill(3000, 3000)).toBeCloseTo(0.6);
    expect(latencyFill(1500, 3000)).toBeCloseTo(0.3);
    expect(latencyFill(99_000, 3000)).toBe(1);
  });
});

describe('alertsQuery', () => {
  it('serialises filters for GET /alerts', () => {
    expect(alertsQuery({ status: 'ACTIVE', severity: ['HIGH', 'CRITICAL'], apiName: ' Billing ', limit: 25, offset: 50 })).toBe(
      'status=ACTIVE&severity=HIGH%2CCRITICAL&api_name=Billing&limit=25&offset=50',
    );
    expect(alertsQuery({ status: 'ALL', severity: [], apiName: '', limit: 10, offset: 0 })).toBe('status=ALL&limit=10&offset=0');
  });
});
