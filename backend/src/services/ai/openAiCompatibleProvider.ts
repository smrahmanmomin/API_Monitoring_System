import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { parseLlmAlertOutput } from './alertOutput.schema.js';
import { ALERT_SYSTEM_PROMPT, PROMPT_VERSION, buildAlertUserPrompt, buildRepairPrompt } from './prompts/alertPrompt.v1.js';
import type { AlertContext, GeneratedAlert, LlmProvider } from './types.js';

export type LlmErrorKind = 'timeout' | 'rate_limited' | 'auth' | 'connection' | 'provider' | 'invalid_output';

/** Provider failure with a coarse category. Never carries credentials or request payloads. */
export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly httpStatus?: number,
    /** Provider error code, e.g. "json_validate_failed" (never contains request data). */
    public readonly providerCode?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Minimal surface of the OpenAI SDK used here — lets tests inject a fake client. */
export interface ChatClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: ChatCompletionMessageParam[];
        temperature: number;
        max_tokens: number;
        response_format: { type: 'json_object' };
        reasoning_effort?: 'low' | 'medium' | 'high';
      }): Promise<{ choices: Array<{ message: { content: string | null } }> }>;
    };
  };
}

export interface OpenAiCompatibleOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

const TEMPERATURE = 0.2;
const JSON_VALIDATION_FAILED = 'json_validate_failed';
const DEFAULT_MAX_OUTPUT_TOKENS = 1200;

function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new LlmError('timeout', 'LLM request timed out');
  if (error instanceof OpenAI.APIConnectionError) return new LlmError('connection', 'Could not connect to the LLM provider');
  if (error instanceof OpenAI.RateLimitError) return new LlmError('rate_limited', 'LLM provider rate limit reached', 429);
  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
    return new LlmError('auth', 'LLM provider rejected the credentials', error.status);
  }
  if (error instanceof OpenAI.APIError) {
    const code = typeof error.code === 'string' ? error.code : undefined;
    // Some providers (e.g. Groq) reject a reply server-side when the model breaks JSON mode.
    if (code === JSON_VALIDATION_FAILED) return new LlmError('invalid_output', 'Provider rejected the model reply as invalid JSON', error.status, code);
    return new LlmError('provider', `LLM provider error (HTTP ${error.status ?? 'unknown'}${code ? `, ${code}` : ''})`, error.status, code);
  }
  return new LlmError('provider', error instanceof Error ? error.message : 'Unknown LLM error');
}

/**
 * Works with any OpenAI-compatible Chat Completions API (Groq, Gemini's OpenAI endpoint,
 * OpenRouter, Ollama, OpenAI). Timeouts and bounded retries with backoff for 408/409/429/5xx
 * and connection errors are handled by the official SDK (`timeout`, `maxRetries`).
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai-compatible';
  readonly model: string;
  private readonly client: ChatClient;
  private readonly maxOutputTokens: number;
  private readonly reasoningEffort: OpenAiCompatibleOptions['reasoningEffort'];

  constructor(options: OpenAiCompatibleOptions, client?: ChatClient) {
    this.model = options.model;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.reasoningEffort = options.reasoningEffort;
    this.client =
      client ??
      new OpenAI({
        baseURL: options.baseURL,
        apiKey: options.apiKey,
        timeout: options.timeoutMs,
        maxRetries: options.maxRetries,
      });
  }

  private async complete(messages: ChatCompletionMessageParam[]): Promise<string | null> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature: TEMPERATURE,
        max_tokens: this.maxOutputTokens,
        response_format: { type: 'json_object' },
        ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
      });
      return response.choices[0]?.message.content ?? null;
    } catch (error) {
      throw toLlmError(error);
    }
  }

  async generate(context: AlertContext): Promise<GeneratedAlert> {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: ALERT_SYSTEM_PROMPT },
      { role: 'user', content: buildAlertUserPrompt(context) },
    ];

    let first: string | null;
    let result: ReturnType<typeof parseLlmAlertOutput>;
    try {
      first = await this.complete(messages);
      result = parseLlmAlertOutput(first);
    } catch (error) {
      if (!(error instanceof LlmError && error.kind === 'invalid_output')) throw error;
      first = null;
      result = { ok: false, error: 'reply was not valid JSON' };
    }

    // One bounded recovery attempt for malformed output.
    if (!result.ok) {
      const repaired = await this.complete([
        ...messages,
        ...(first !== null ? [{ role: 'assistant' as const, content: first }] : []),
        { role: 'user', content: buildRepairPrompt(result.error) },
      ]);
      result = parseLlmAlertOutput(repaired);
      if (!result.ok) throw new LlmError('invalid_output', `LLM output invalid after repair attempt: ${result.error}`);
    }

    return { content: result.content, model: this.model, promptVersion: PROMPT_VERSION };
  }
}
