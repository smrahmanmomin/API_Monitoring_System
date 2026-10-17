import { z } from 'zod';
import type { AlertContent } from './types.js';

const sentence = z.string().trim().min(3).max(400);

/**
 * Contract for LLM output. Unknown keys are stripped (not trusted); any severity the model
 * may return is ignored because severity always comes from the rule engine.
 */
export const llmAlertOutputSchema = z.object({
  title: z.string().trim().min(3).max(120),
  summary: z.string().trim().min(10).max(1200),
  possible_causes: z.array(sentence).min(1).max(4),
  recommended_actions: z.array(sentence).min(1).max(5),
});

export type ParseResult = { ok: true; content: AlertContent } | { ok: false; error: string };

/** Extract a JSON object from model text, tolerating code fences or surrounding prose. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('reply did not contain a JSON object');
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

export function parseLlmAlertOutput(text: string | null | undefined): ParseResult {
  if (!text || text.trim() === '') return { ok: false, error: 'reply was empty' };
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (error) {
    return { ok: false, error: `reply was not valid JSON (${error instanceof Error ? error.message : 'parse error'})` };
  }
  const parsed = llmAlertOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `reply did not match the schema (${parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')})` };
  }
  return {
    ok: true,
    content: {
      title: parsed.data.title,
      summary: parsed.data.summary,
      possibleCauses: parsed.data.possible_causes,
      recommendedActions: parsed.data.recommended_actions,
    },
  };
}
