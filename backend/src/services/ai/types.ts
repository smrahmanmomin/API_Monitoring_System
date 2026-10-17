import type { AlertEvidence } from '../alerts/evidence.js';
import type { AnomalyType, Severity } from '../monitoring/types.js';

/** Everything the alert generators (LLM or fallback) are allowed to see. */
export interface AlertContext {
  apiName: string;
  anomalyType: AnomalyType;
  /** Severity decided by the rule engine; generators must not change it. */
  severity: Severity;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  evidence: AlertEvidence;
}

/** Human-readable alert content. */
export interface AlertContent {
  title: string;
  summary: string;
  /** Hypotheses only — not verified root causes. */
  possibleCauses: string[];
  /** Prioritised next steps. */
  recommendedActions: string[];
}

export interface GeneratedAlert {
  content: AlertContent;
  model: string;
  promptVersion: string;
}

export interface LlmProvider {
  /** Provider label for logs, e.g. "openai-compatible". */
  readonly name: string;
  readonly model: string;
  generate(context: AlertContext): Promise<GeneratedAlert>;
}
