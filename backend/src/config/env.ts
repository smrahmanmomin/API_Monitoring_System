import { z } from 'zod';

/**
 * Centralised, validated runtime configuration.
 * The process fails fast at startup when a critical variable is missing or malformed.
 */

const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => ['true', '1', 'yes'].includes(value));

const severityEnum = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((v) => v.startsWith('postgresql://') || v.startsWith('postgres://'), 'DATABASE_URL must be a PostgreSQL connection string'),

  /** Comma-separated list of allowed browser origins. */
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Request limits
  MAX_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  REQUEST_BODY_LIMIT: z.string().default('256kb'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  MONITOR_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(60),

  // Monitoring rules
  LATENCY_THRESHOLD_MS: z.coerce.number().int().min(1).default(3000),
  /** Multiplier of the latency threshold at which latency severity becomes HIGH. */
  LATENCY_HIGH_MULTIPLIER: z.coerce.number().min(1).default(2),
  /** JSON object of per-API overrides, e.g. {"ReportingAPI":{"latencyThresholdMs":8000,"expectedMinRecords":1}} */
  API_THRESHOLDS_JSON: z.string().optional(),
  /** Occurrence count at which a grouped alert's severity is escalated one level. 0 disables escalation. */
  ESCALATION_OCCURRENCES: z.coerce.number().int().min(0).default(5),

  // LLM (any OpenAI-compatible Chat Completions endpoint)
  LLM_ENABLED: booleanString.default('true'),
  LLM_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().min(1).default('openai/gpt-oss-120b'),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** Upper bound on generated tokens. Reasoning models count hidden reasoning against it. */
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(200).max(8000).default(1200),
  /** Optional `reasoning_effort` for reasoning models (e.g. "low" for gpt-oss). Omitted when unset. */
  LLM_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).optional(),
  /** 1 by default: free tiers limit tokens per minute, so parallel calls mostly add 429s. */
  LLM_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(1),
  /** Delay before re-queueing a rate-limited AI job, and how many times to try. */
  LLM_RATE_LIMIT_RETRY_MS: z.coerce.number().int().min(1000).max(300_000).default(20_000),
  LLM_RATE_LIMIT_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),

  // E-mail notifications (optional)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: booleanString.default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  ALERT_EMAIL_FROM: z.string().default('API Monitor <alerts@apimonitor.local>'),
  ALERT_EMAIL_TO: z.string().optional(),
  EMAIL_MIN_SEVERITY: severityEnum.default('HIGH'),
  DASHBOARD_URL: z.string().url().default('http://localhost:5173'),
});

export type Env = z.infer<typeof envSchema>;

/** Treat empty strings as "not set" so `.env` placeholders like `LLM_API_KEY=` behave as expected. */
function normalise(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') result[key] = value.trim();
  }
  return result;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(normalise(source));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}
