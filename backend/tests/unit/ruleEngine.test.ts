import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, type MonitoringThresholds } from '../../src/config/thresholds.js';
import { monitorEventSchema, toMonitoringEvent } from '../../src/schemas/monitorEvent.schema.js';
import { evaluateEvent } from '../../src/services/monitoring/ruleEngine.js';

function evaluate(input: Record<string, unknown>, thresholds: MonitoringThresholds = DEFAULT_THRESHOLDS) {
  const event = toMonitoringEvent(monitorEventSchema.parse(input));
  return evaluateEvent(event, thresholds);
}

const healthy = { api_name: 'PatientDataAPI', response_time_ms: 1200, status_code: 200, records_returned: 50 };

describe('rule engine', () => {
  it('produces no findings for a normal response', () => {
    expect(evaluate(healthy)).toEqual([]);
  });

  it('does not flag latency exactly at the threshold', () => {
    expect(evaluate({ ...healthy, response_time_ms: 3000 })).toEqual([]);
  });

  it('flags latency above the threshold as MEDIUM with measured value and threshold', () => {
    const [finding] = evaluate({ ...healthy, response_time_ms: 4200 });
    expect(finding).toMatchObject({
      type: 'HIGH_LATENCY',
      severity: 'MEDIUM',
      apiName: 'PatientDataAPI',
      observed: { responseTimeMs: 4200 },
      expected: { latencyThresholdMs: 3000 },
    });
  });

  it('escalates latency to HIGH at the configured multiplier', () => {
    const [finding] = evaluate({ ...healthy, response_time_ms: 6000 });
    expect(finding?.severity).toBe('HIGH');
  });

  it('applies per-API latency thresholds', () => {
    const thresholds: MonitoringThresholds = { ...DEFAULT_THRESHOLDS, perApi: { ReportingAPI: { latencyThresholdMs: 8000 } } };
    expect(evaluate({ ...healthy, api_name: 'ReportingAPI', response_time_ms: 7000 }, thresholds)).toEqual([]);
    expect(evaluate({ ...healthy, response_time_ms: 7000 }, thresholds)[0]?.type).toBe('HIGH_LATENCY');
  });

  it.each([
    [500, 'SERVER_ERROR', 'HIGH'],
    [503, 'SERVER_ERROR', 'HIGH'],
    [429, 'RATE_LIMITED', 'MEDIUM'],
    [401, 'AUTH_FAILURE', 'HIGH'],
    [403, 'AUTH_FAILURE', 'HIGH'],
    [404, 'CLIENT_ERROR', 'MEDIUM'],
    [400, 'CLIENT_ERROR', 'MEDIUM'],
    [301, 'UNEXPECTED_STATUS', 'LOW'],
    [101, 'UNEXPECTED_STATUS', 'LOW'],
  ])('classifies HTTP %i as %s/%s and preserves the status code', (status, type, severity) => {
    const findings = evaluate({ ...healthy, status_code: status });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type, severity, observed: { statusCode: status } });
  });

  it('treats 2xx codes other than 200 as success', () => {
    expect(evaluate({ ...healthy, status_code: 204 })).toEqual([]);
  });

  it('flags missing records_returned', () => {
    const { records_returned: _omit, ...withoutRecords } = healthy;
    const [finding] = evaluate(withoutRecords);
    expect(finding).toMatchObject({ type: 'MISSING_RECORD_COUNT', severity: 'MEDIUM', observed: { issue: 'missing' } });
  });

  it('flags null records_returned as missing', () => {
    expect(evaluate({ ...healthy, records_returned: null })[0]).toMatchObject({ type: 'MISSING_RECORD_COUNT', observed: { issue: 'null' } });
  });

  it.each([
    [-1, 'negative'],
    [2.5, 'non_integer'],
    ['abc', 'not_a_number'],
  ])('flags invalid record count %s as %s', (value, issue) => {
    const [finding] = evaluate({ ...healthy, records_returned: value });
    expect(finding).toMatchObject({ type: 'INVALID_RECORD_COUNT', severity: 'MEDIUM', observed: { issue, recordsReturned: value } });
  });

  it('accepts numeric strings as valid record counts', () => {
    expect(evaluate({ ...healthy, records_returned: '12' })).toEqual([]);
  });

  it('flags zero records as LOW and acknowledges it may be legitimate', () => {
    const [finding] = evaluate({ ...healthy, records_returned: 0 });
    expect(finding).toMatchObject({ type: 'ZERO_RECORDS', severity: 'LOW' });
    expect(finding?.message).toMatch(/may be legitimate/);
  });

  it('raises zero records to MEDIUM when a minimum is expected', () => {
    const [finding] = evaluate({ ...healthy, records_returned: 0, expected_min_records: 1 });
    expect(finding).toMatchObject({ type: 'ZERO_RECORDS', severity: 'MEDIUM', expected: { expectedMinRecords: 1 } });
  });

  it('flags record counts below the expected minimum', () => {
    const [finding] = evaluate({ ...healthy, records_returned: 3, expected_min_records: 10 });
    expect(finding).toMatchObject({ type: 'LOW_RECORD_COUNT', observed: { recordsReturned: 3 }, expected: { expectedMinRecords: 10 } });
  });

  it('uses per-API expected minimums when the event has none', () => {
    const thresholds: MonitoringThresholds = { ...DEFAULT_THRESHOLDS, perApi: { PatientDataAPI: { expectedMinRecords: 100 } } };
    expect(evaluate(healthy, thresholds)[0]?.type).toBe('LOW_RECORD_COUNT');
  });

  it('reports every anomaly in one event (HTTP 500 + slow + zero records)', () => {
    const findings = evaluate({ api_name: 'AppointmentAPI', response_time_ms: 5500, status_code: 500, records_returned: 0 });
    expect(findings.map((f) => f.type).sort()).toEqual(['HIGH_LATENCY', 'SERVER_ERROR', 'ZERO_RECORDS']);
    expect(findings.every((f) => f.apiName === 'AppointmentAPI')).toBe(true);
  });

  it('is deterministic for the same input and clock', () => {
    const event = toMonitoringEvent(monitorEventSchema.parse({ ...healthy, status_code: 502, checked_at: '2026-01-01T00:00:00Z' }));
    const now = new Date('2026-01-01T00:00:05Z');
    expect(evaluateEvent(event, DEFAULT_THRESHOLDS, now)).toEqual(evaluateEvent(event, DEFAULT_THRESHOLDS, now));
  });
});
