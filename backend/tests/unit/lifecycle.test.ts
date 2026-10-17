import { describe, expect, it } from 'vitest';
import { canTransition, computeGroupedSeverity } from '../../src/services/alerts/lifecycle.js';
import { fingerprintFor } from '../../src/services/alerts/evidence.js';

describe('alert status transitions', () => {
  it.each([
    ['ACTIVE', 'ACKNOWLEDGED', true],
    ['ACTIVE', 'RESOLVED', true],
    ['ACKNOWLEDGED', 'RESOLVED', true],
    ['ACKNOWLEDGED', 'ACKNOWLEDGED', false],
    ['ACKNOWLEDGED', 'ACTIVE', false],
    ['RESOLVED', 'ACTIVE', false],
    ['RESOLVED', 'ACKNOWLEDGED', false],
  ] as const)('%s -> %s allowed=%s', (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
  });
});

describe('grouped alert severity', () => {
  const base = { currentSeverity: 'MEDIUM', currentBaseSeverity: 'MEDIUM', findingSeverity: 'MEDIUM', escalationOccurrences: 5 } as const;

  it('keeps severity for repeats below the escalation threshold', () => {
    expect(computeGroupedSeverity({ ...base, occurrenceCount: 2 })).toEqual({ baseSeverity: 'MEDIUM', severity: 'MEDIUM', increased: false, escalated: false });
  });

  it('escalates one level when the occurrence threshold is reached', () => {
    expect(computeGroupedSeverity({ ...base, occurrenceCount: 5 })).toEqual({ baseSeverity: 'MEDIUM', severity: 'HIGH', increased: true, escalated: true });
  });

  it('does not escalate again once already escalated', () => {
    expect(computeGroupedSeverity({ ...base, currentSeverity: 'HIGH', occurrenceCount: 6 })).toMatchObject({ severity: 'HIGH', increased: false });
  });

  it('caps escalation at CRITICAL', () => {
    const result = computeGroupedSeverity({ currentSeverity: 'CRITICAL', currentBaseSeverity: 'CRITICAL', findingSeverity: 'CRITICAL', occurrenceCount: 10, escalationOccurrences: 5 });
    expect(result.severity).toBe('CRITICAL');
    expect(result.increased).toBe(false);
  });

  it('raises severity when a repeat finding is more severe (not an escalation)', () => {
    expect(computeGroupedSeverity({ ...base, findingSeverity: 'HIGH', occurrenceCount: 2 })).toEqual({ baseSeverity: 'HIGH', severity: 'HIGH', increased: true, escalated: false });
  });

  it('never lowers severity of an open alert', () => {
    expect(computeGroupedSeverity({ ...base, currentSeverity: 'HIGH', currentBaseSeverity: 'HIGH', findingSeverity: 'LOW', occurrenceCount: 2 }).severity).toBe('HIGH');
  });

  it('can be disabled with 0', () => {
    expect(computeGroupedSeverity({ ...base, escalationOccurrences: 0, occurrenceCount: 100 }).severity).toBe('MEDIUM');
  });
});

describe('fingerprint', () => {
  it('groups by API and anomaly type', () => {
    expect(fingerprintFor('AppointmentAPI', 'SERVER_ERROR')).toBe('AppointmentAPI:SERVER_ERROR');
  });
});
