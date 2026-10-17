import type { Alert } from '@prisma/client';
import type { Transporter } from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { parseApiOverrides } from '../../src/config/thresholds.js';
import { EmailService } from '../../src/services/notifications/emailService.js';
import { createLogger } from '../../src/utils/logger.js';

const DB = 'postgresql://u:p@localhost:5432/db';

describe('environment validation', () => {
  it('applies defaults', () => {
    const env = loadEnv({ DATABASE_URL: DB });
    expect(env).toMatchObject({ PORT: 4000, LATENCY_THRESHOLD_MS: 3000, LLM_ENABLED: true, MAX_BATCH_SIZE: 500 });
    expect(env.LLM_API_KEY).toBeUndefined();
  });

  it('treats empty strings as unset', () => {
    expect(loadEnv({ DATABASE_URL: DB, LLM_API_KEY: '', SMTP_HOST: '  ' }).SMTP_HOST).toBeUndefined();
  });

  it('fails fast on missing or malformed critical values', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ DATABASE_URL: 'mysql://x' })).toThrow(/PostgreSQL/);
    expect(() => loadEnv({ DATABASE_URL: DB, LATENCY_THRESHOLD_MS: 'abc' })).toThrow(/LATENCY_THRESHOLD_MS/);
  });

  it('validates per-API threshold JSON', () => {
    expect(parseApiOverrides('{"A":{"latencyThresholdMs":100}}')).toEqual({ A: { latencyThresholdMs: 100 } });
    expect(() => parseApiOverrides('{bad')).toThrow(/not valid JSON/);
    expect(() => parseApiOverrides('{"A":{"latencyThresholdMs":-1}}')).toThrow(/invalid/);
    expect(() => parseApiOverrides('{"A":{"unknown":1}}')).toThrow(/invalid/);
  });
});

describe('email notifications', () => {
  const alert = {
    id: '00000000-0000-4000-8000-000000000001',
    apiName: 'AppointmentAPI',
    anomalyType: 'SERVER_ERROR',
    severity: 'HIGH',
    title: 'AppointmentAPI <server> error',
    summary: 'Summary with <script>alert(1)</script>',
    possibleCauses: ['Cause'],
    recommendedActions: ['Action'],
    generationSource: 'FALLBACK',
    aiModel: null,
    occurrenceCount: 1,
    lastSeenAt: new Date('2026-01-01T00:00:00Z'),
  } as unknown as Alert;

  function service(minSeverity: 'HIGH' | 'CRITICAL' = 'HIGH') {
    const sendMail = vi.fn(async () => ({}));
    const svc = new EmailService(
      { host: 'localhost', port: 1025, secure: false, from: 'a@b.c', to: 'ops@b.c', minSeverity, dashboardUrl: 'http://localhost:5173' },
      createLogger('silent', 'test'),
      { sendMail } as unknown as Transporter,
    );
    return { svc, sendMail };
  }

  it('sends for alerts at or above the minimum severity', async () => {
    const { svc, sendMail } = service('HIGH');
    expect(await svc.notify(alert, 'created')).toBe(true);
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('skips lower severities and manual regenerations', async () => {
    const { svc, sendMail } = service('CRITICAL');
    expect(await svc.notify(alert, 'created')).toBe(false);
    expect(await service('HIGH').svc.notify(alert, 'manual')).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('escapes HTML and labels the content source', () => {
    const message = service().svc.buildMessage(alert, 'escalated');
    expect(message.subject).toBe('[HIGH] ESCALATED: AppointmentAPI <server> error');
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.text).toContain('Rule-based fallback text');
  });

  it('does not throw when the SMTP server fails', async () => {
    const svc = new EmailService(
      { host: 'localhost', port: 1025, secure: false, from: 'a@b.c', to: 'ops@b.c', minSeverity: 'LOW', dashboardUrl: 'http://x' },
      createLogger('silent', 'test'),
      { sendMail: vi.fn(async () => { throw new Error('smtp down'); }) } as unknown as Transporter,
    );
    await expect(svc.notify(alert, 'created')).resolves.toBe(false);
  });
});
