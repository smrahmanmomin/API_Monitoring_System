import { z } from 'zod';
import type { Env } from './env.js';

/** Rule-engine configuration. Kept separate from Env so the engine stays pure and unit-testable. */
export interface ApiOverride {
  latencyThresholdMs?: number;
  expectedMinRecords?: number;
}

export interface MonitoringThresholds {
  latencyThresholdMs: number;
  latencyHighMultiplier: number;
  escalationOccurrences: number;
  perApi: Record<string, ApiOverride>;
}

const overrideSchema = z
  .object({
    latencyThresholdMs: z.number().int().positive().optional(),
    expectedMinRecords: z.number().int().min(0).optional(),
  })
  .strict();

const overridesSchema = z.record(z.string().min(1).max(100), overrideSchema);

export const DEFAULT_THRESHOLDS: MonitoringThresholds = {
  latencyThresholdMs: 3000,
  latencyHighMultiplier: 2,
  escalationOccurrences: 5,
  perApi: {},
};

export function parseApiOverrides(json: string | undefined): Record<string, ApiOverride> {
  if (!json) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('API_THRESHOLDS_JSON is not valid JSON');
  }
  const parsed = overridesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`API_THRESHOLDS_JSON is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

export function thresholdsFromEnv(env: Env): MonitoringThresholds {
  return {
    latencyThresholdMs: env.LATENCY_THRESHOLD_MS,
    latencyHighMultiplier: env.LATENCY_HIGH_MULTIPLIER,
    escalationOccurrences: env.ESCALATION_OCCURRENCES,
    perApi: parseApiOverrides(env.API_THRESHOLDS_JSON),
  };
}
