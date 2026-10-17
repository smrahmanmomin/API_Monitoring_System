import pino, { type Logger } from 'pino';

/**
 * Structured JSON logger. Credentials and request bodies are redacted so secrets and
 * potentially sensitive payloads never reach log storage.
 */
export function createLogger(level: string, nodeEnv: string): Logger {
  const pretty = nodeEnv === 'development' && process.stdout.isTTY;
  return pino({
    level,
    base: { service: 'api-monitor' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
        'apiKey',
        '*.apiKey',
        'password',
        '*.password',
        'body',
        'req.body',
      ],
      censor: '[REDACTED]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } } : {}),
  });
}

export type { Logger };
