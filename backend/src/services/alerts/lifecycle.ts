import { escalate, maxSeverity, severityRank, type AlertStatus, type Severity } from '../monitoring/types.js';

/** Allowed manual status transitions. RESOLVED is terminal; a reappearing anomaly opens a new alert. */
const TRANSITIONS: Record<AlertStatus, readonly AlertStatus[]> = {
  ACTIVE: ['ACKNOWLEDGED', 'RESOLVED'],
  ACKNOWLEDGED: ['RESOLVED'],
  RESOLVED: [],
};

export function canTransition(from: AlertStatus, to: AlertStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface GroupedSeverityInput {
  /** Current severity of the open alert (may already be escalated). */
  currentSeverity: Severity;
  /** Highest rule-engine severity recorded for the open alert so far. */
  currentBaseSeverity: Severity;
  /** Rule-engine severity of the new finding. */
  findingSeverity: Severity;
  /** Occurrence count after counting the new detection. */
  occurrenceCount: number;
  /** 0 disables escalation. */
  escalationOccurrences: number;
}

export interface GroupedSeverityResult {
  baseSeverity: Severity;
  severity: Severity;
  /** True when the new severity is higher than the alert's current severity. */
  increased: boolean;
  /** True when the increase is caused by repeat-occurrence escalation. */
  escalated: boolean;
}

/**
 * Severity of a grouped (deduplicated) alert after a repeat detection.
 * - Severity never drops automatically while the alert is open.
 * - Reaching the escalation threshold raises the base severity by one level (capped at CRITICAL).
 */
export function computeGroupedSeverity(input: GroupedSeverityInput): GroupedSeverityResult {
  const baseSeverity = maxSeverity(input.currentBaseSeverity, input.findingSeverity);
  const shouldEscalate = input.escalationOccurrences > 0 && input.occurrenceCount >= input.escalationOccurrences;
  const target = shouldEscalate ? escalate(baseSeverity) : baseSeverity;
  const severity = maxSeverity(input.currentSeverity, target);
  const increased = severityRank(severity) > severityRank(input.currentSeverity);
  return { baseSeverity, severity, increased, escalated: increased && shouldEscalate && severityRank(target) > severityRank(baseSeverity) };
}
