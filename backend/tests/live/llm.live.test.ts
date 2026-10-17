import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../../src/config/thresholds.js';
import { monitorEventSchema, toMonitoringEvent } from '../../src/schemas/monitorEvent.schema.js';
import { buildEvidence } from '../../src/services/alerts/evidence.js';
import { OpenAiCompatibleProvider } from '../../src/services/ai/openAiCompatibleProvider.js';
import { evaluateEvent } from '../../src/services/monitoring/ruleEngine.js';

/**
 * Opt-in smoke test against a real provider (costs quota; never part of `npm test`):
 *   LLM_API_KEY=... [LLM_BASE_URL=...] [LLM_MODEL=...] npm run test:llm -w backend
 */
const apiKey = process.env.LLM_API_KEY;

describe.skipIf(!apiKey)('live LLM provider', () => {
  it('generates a schema-valid alert for the assignment example', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseURL: process.env.LLM_BASE_URL ?? 'https://api.groq.com/openai/v1',
      apiKey: apiKey!,
      model: process.env.LLM_MODEL ?? 'openai/gpt-oss-120b',
      timeoutMs: 30_000,
      maxRetries: 1,
    });
    const event = toMonitoringEvent(monitorEventSchema.parse({ api_name: 'AppointmentAPI', response_time_ms: 5500, status_code: 500, records_returned: 0 }));
    const findings = evaluateEvent(event, DEFAULT_THRESHOLDS);
    const finding = findings[0]!;
    const result = await provider.generate({
      apiName: event.apiName,
      anomalyType: finding.type,
      severity: finding.severity,
      occurrenceCount: 1,
      firstSeenAt: event.checkedAt.toISOString(),
      lastSeenAt: event.checkedAt.toISOString(),
      evidence: buildEvidence(event, finding, findings, { expectedMinRecords: undefined, latencyThresholdMs: 3000 }),
    });
    console.log(JSON.stringify(result, null, 2));
    expect(result.content.title.length).toBeGreaterThan(3);
    expect(result.content.recommendedActions.length).toBeGreaterThan(0);
  });
});
