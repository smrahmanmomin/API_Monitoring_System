import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeLlmProvider, buildTestApp, resetDatabase, testPrisma, type TestContext } from '../helpers/testApp.js';

const healthy = { api_name: 'PatientDataAPI', response_time_ms: 1200, status_code: 200, records_returned: 50 };
const failing = { api_name: 'AppointmentAPI', response_time_ms: 5500, status_code: 500, records_returned: 0 };
const prisma = testPrisma();

async function ingest(ctx: TestContext, body: unknown, headers: Record<string, string> = {}) {
  const res = await request(ctx.app).post('/monitor').set(headers).send(body as object);
  await ctx.deps.enrichmentQueue.drain();
  return res;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /monitor', () => {
  it('ingests a single healthy event without creating alerts', async () => {
    const ctx = buildTestApp();
    const res = await ingest(ctx, healthy);
    expect(res.status).toBe(201);
    expect(res.body.summary).toMatchObject({ received: 1, accepted: 1, with_anomalies: 0, alerts_created: 0 });
    expect(await prisma.apiCheck.count()).toBe(1);
    expect(await prisma.alert.count()).toBe(0);
  });

  it('ingests a batch, persists checks and one alert per anomaly', async () => {
    const ctx = buildTestApp();
    const res = await ingest(ctx, [healthy, failing]);
    expect(res.status).toBe(201);
    expect(res.body.summary).toMatchObject({ received: 2, accepted: 2, rejected: 0, with_anomalies: 1, anomalies_detected: 3, alerts_created: 3 });
    expect(res.body.results[1].anomalies.map((a: { type: string }) => a.type).sort()).toEqual(['HIGH_LATENCY', 'SERVER_ERROR', 'ZERO_RECORDS']);

    const check = await prisma.apiCheck.findFirstOrThrow({ where: { apiName: 'AppointmentAPI' } });
    expect(check).toMatchObject({ statusCode: 500, responseTimeMs: 5500, recordsReturned: 0, anomalyCount: 3, source: 'API' });
    const alerts = await prisma.alert.findMany({ where: { apiName: 'AppointmentAPI' } });
    expect(alerts).toHaveLength(3);
    expect(alerts.every((a) => a.status === 'ACTIVE' && a.latestCheckId === check.id)).toBe(true);
    expect(await prisma.alertOccurrence.count()).toBe(3);
  });

  it('returns 207 with per-item results for mixed valid and invalid items', async () => {
    const ctx = buildTestApp();
    const res = await ingest(ctx, [healthy, { ...healthy, status_code: 999 }, { api_name: 'X' }, failing]);
    expect(res.status).toBe(207);
    expect(res.body.summary).toMatchObject({ received: 4, accepted: 2, rejected: 2 });
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['accepted', 'rejected', 'rejected', 'accepted']);
    expect(res.body.results[1].errors[0]).toMatchObject({ path: 'status_code' });
    expect(await prisma.apiCheck.count()).toBe(2);
  });

  it('returns 400 when no item is valid', async () => {
    const res = await ingest(buildTestApp(), [{ api_name: '' }, { ...healthy, extra_field: true }]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toHaveLength(2);
    expect(await prisma.apiCheck.count()).toBe(0);
  });

  it.each([
    ['empty array', [], 400, 'EMPTY_BATCH'],
    ['scalar body', 'hello', 400, 'INVALID_BODY'],
  ])('rejects %s', async (_label, body, status, code) => {
    const res = await request(buildTestApp().app).post('/monitor').set('Content-Type', 'application/json').send(JSON.stringify(body));
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
  });

  it('rejects malformed JSON with a consistent error shape', async () => {
    const res = await request(buildTestApp().app).post('/monitor').set('Content-Type', 'application/json').send('{"api_name": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'MALFORMED_JSON', request_id: expect.any(String) });
    expect(res.body.error.stack).toBeUndefined();
  });

  it('rejects batches larger than MAX_BATCH_SIZE with 413', async () => {
    const res = await ingest(buildTestApp(), new Array(51).fill(healthy));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('BATCH_TOO_LARGE');
  });

  it('records the event source from X-Monitor-Source', async () => {
    await ingest(buildTestApp(), healthy, { 'X-Monitor-Source': 'demo' });
    expect((await prisma.apiCheck.findFirstOrThrow()).source).toBe('DEMO');
  });

  it('echoes a safe caller-supplied request id', async () => {
    const res = await request(buildTestApp().app).get('/health').set('X-Request-Id', 'trace-123');
    expect(res.headers['x-request-id']).toBe('trace-123');
  });
});

describe('AI enrichment and fallback', () => {
  it('upgrades new alerts to AI-generated content when the LLM succeeds', async () => {
    const ctx = buildTestApp({ llm: new FakeLlmProvider('ok') });
    await ingest(ctx, failing);
    const alert = await prisma.alert.findFirstOrThrow({ where: { anomalyType: 'SERVER_ERROR' } });
    expect(alert).toMatchObject({ generationSource: 'AI', aiModel: 'fake-model-1', promptVersion: 'alert-v1', severity: 'HIGH' });
    expect(alert.title).toBe('AI: AppointmentAPI SERVER_ERROR');
    // The LLM only ever sees the deterministic severity.
    expect(ctx.llm?.calls.find((c) => c.anomalyType === 'SERVER_ERROR')?.severity).toBe('HIGH');
  });

  it('keeps the detected anomaly with fallback content when the LLM fails', async () => {
    const ctx = buildTestApp({ llm: new FakeLlmProvider('fail') });
    const res = await ingest(ctx, failing);
    expect(res.status).toBe(201);
    const alerts = await prisma.alert.findMany();
    expect(alerts).toHaveLength(3);
    for (const alert of alerts) {
      expect(alert.generationSource).toBe('FALLBACK');
      expect(alert.aiModel).toBeNull();
      expect(alert.summary.length).toBeGreaterThan(20);
    }
  });

  it('retries a rate-limited AI generation later instead of settling for fallback text', async () => {
    const ctx = buildTestApp({ llm: new FakeLlmProvider('fail-once') });
    await ingest(ctx, { ...healthy, status_code: 503 }); // ingest() drains the queue, including the delayed retry
    const alert = await prisma.alert.findFirstOrThrow();
    expect(alert.generationSource).toBe('AI');
    expect(ctx.llm?.calls).toHaveLength(2);
  });

  it('works with no LLM configured at all', async () => {
    const ctx = buildTestApp({ llm: null });
    await ingest(ctx, failing);
    expect(await prisma.alert.count({ where: { generationSource: 'FALLBACK' } })).toBe(3);
    const health = await request(ctx.app).get('/health');
    expect(health.body.dependencies.llm).toBe('fallback_only');
  });

  it('does not call the LLM again for plain repeat occurrences', async () => {
    const ctx = buildTestApp({ llm: new FakeLlmProvider('ok') });
    await ingest(ctx, { ...healthy, status_code: 503 });
    await ingest(ctx, { ...healthy, status_code: 503 });
    expect(ctx.llm?.calls).toHaveLength(1);
  });

  it('regenerates on demand via POST /alerts/:id/regenerate', async () => {
    const llm = new FakeLlmProvider('fail');
    const ctx = buildTestApp({ llm });
    await ingest(ctx, { ...healthy, status_code: 503 });
    const alert = await prisma.alert.findFirstOrThrow();
    llm.mode = 'ok';
    const res = await request(ctx.app).post(`/alerts/${alert.id}/regenerate`);
    expect(res.status).toBe(200);
    expect(res.body.generation_result).toBe('ai');
    expect(res.body.data.generation.source).toBe('AI');
  });

  it('returns 503 for regenerate when no LLM is configured', async () => {
    const ctx = buildTestApp({ llm: null });
    await ingest(ctx, { ...healthy, status_code: 503 });
    const alert = await prisma.alert.findFirstOrThrow();
    expect((await request(ctx.app).post(`/alerts/${alert.id}/regenerate`)).status).toBe(503);
  });
});

describe('deduplication and lifecycle', () => {
  it('groups repeated identical anomalies into one alert', async () => {
    const ctx = buildTestApp();
    const event = { ...healthy, status_code: 502 };
    await ingest(ctx, [event, event]);
    const res = await ingest(ctx, event);
    expect(res.body.summary).toMatchObject({ alerts_created: 0, alerts_updated: 1 });
    const alerts = await prisma.alert.findMany();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.occurrenceCount).toBe(3);
    expect(await prisma.alertOccurrence.count({ where: { alertId: alerts[0]!.id } })).toBe(3);
  });

  it('tracks first/last seen from event timestamps', async () => {
    const ctx = buildTestApp();
    await ingest(ctx, { ...healthy, status_code: 500, checked_at: '2026-01-01T10:00:00Z' });
    await ingest(ctx, { ...healthy, status_code: 500, checked_at: '2026-01-01T11:00:00Z' });
    const alert = await prisma.alert.findFirstOrThrow();
    expect(alert.firstSeenAt.toISOString()).toBe('2026-01-01T10:00:00.000Z');
    expect(alert.lastSeenAt.toISOString()).toBe('2026-01-01T11:00:00.000Z');
  });

  it('escalates severity after ESCALATION_OCCURRENCES repeats', async () => {
    const ctx = buildTestApp(); // test env: escalation at 3
    const slow = { ...healthy, response_time_ms: 4000 };
    await ingest(ctx, [slow, slow]);
    expect((await prisma.alert.findFirstOrThrow()).severity).toBe('MEDIUM');
    const res = await ingest(ctx, slow);
    expect(res.body.results[0].alerts[0]).toMatchObject({ outcome: 'escalated', severity: 'HIGH' });
    const alert = await prisma.alert.findFirstOrThrow();
    expect(alert).toMatchObject({ severity: 'HIGH', baseSeverity: 'MEDIUM', occurrenceCount: 3 });
    expect((alert.evidence as { escalation?: unknown }).escalation).toMatchObject({ fromSeverity: 'MEDIUM', toSeverity: 'HIGH' });
  });

  it('acknowledges then resolves an alert, and rejects invalid transitions', async () => {
    const ctx = buildTestApp();
    await ingest(ctx, { ...healthy, status_code: 500 });
    const { id } = await prisma.alert.findFirstOrThrow();

    const ack = await request(ctx.app).patch(`/alerts/${id}/status`).send({ status: 'ACKNOWLEDGED' });
    expect(ack.status).toBe(200);
    expect(ack.body.data).toMatchObject({ status: 'ACKNOWLEDGED', acknowledged_at: expect.any(String) });

    const again = await request(ctx.app).patch(`/alerts/${id}/status`).send({ status: 'ACKNOWLEDGED' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const resolved = await request(ctx.app).patch(`/alerts/${id}/status`).send({ status: 'RESOLVED' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data).toMatchObject({ status: 'RESOLVED', resolved_at: expect.any(String) });

    expect((await request(ctx.app).patch(`/alerts/${id}/status`).send({ status: 'RESOLVED' })).status).toBe(409);
  });

  it('opens a new ACTIVE alert when a resolved anomaly reappears', async () => {
    const ctx = buildTestApp();
    const event = { ...healthy, status_code: 500 };
    await ingest(ctx, event);
    const first = await prisma.alert.findFirstOrThrow();
    await request(ctx.app).patch(`/alerts/${first.id}/status`).send({ status: 'RESOLVED' });

    await ingest(ctx, event);
    const alerts = await prisma.alert.findMany({ orderBy: { createdAt: 'asc' } });
    expect(alerts.map((a) => a.status)).toEqual(['RESOLVED', 'ACTIVE']);
    expect(alerts[1]?.occurrenceCount).toBe(1);
  });

  it('keeps grouping into an acknowledged alert', async () => {
    const ctx = buildTestApp();
    const event = { ...healthy, status_code: 500 };
    await ingest(ctx, event);
    const { id } = await prisma.alert.findFirstOrThrow();
    await request(ctx.app).patch(`/alerts/${id}/status`).send({ status: 'ACKNOWLEDGED' });
    await ingest(ctx, event);
    expect(await prisma.alert.count()).toBe(1);
    expect((await prisma.alert.findUniqueOrThrow({ where: { id } })).occurrenceCount).toBe(2);
  });

  it.each([
    [{ status: 'ACTIVE' }],
    [{ status: 'done' }],
    [{}],
    [{ status: 'RESOLVED', note: 'x' }],
  ])('rejects malformed status body %j', async (body) => {
    const ctx = buildTestApp();
    await ingest(ctx, { ...healthy, status_code: 500 });
    const { id } = await prisma.alert.findFirstOrThrow();
    const res = await request(ctx.app).patch(`/alerts/${id}/status`).send(body);
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown alerts and 400 for malformed ids', async () => {
    const ctx = buildTestApp();
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await request(ctx.app).get(`/alerts/${missing}`)).status).toBe(404);
    expect((await request(ctx.app).patch(`/alerts/${missing}/status`).send({ status: 'RESOLVED' })).status).toBe(404);
    const bad = await request(ctx.app).get('/alerts/not-a-uuid');
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('id');
  });
});

describe('GET /alerts', () => {
  async function seed(ctx: TestContext) {
    await ingest(ctx, [
      failing, // SERVER_ERROR HIGH, HIGH_LATENCY MEDIUM, ZERO_RECORDS LOW
      { ...healthy, api_name: 'BillingAPI', response_time_ms: 7000 }, // HIGH_LATENCY HIGH
      { ...healthy, api_name: 'LabResultsAPI', status_code: 429 }, // RATE_LIMITED MEDIUM
    ]);
  }

  it('returns only ACTIVE alerts by default, most severe first', async () => {
    const ctx = buildTestApp();
    await seed(ctx);
    const target = await prisma.alert.findFirstOrThrow({ where: { anomalyType: 'RATE_LIMITED' } });
    await request(ctx.app).patch(`/alerts/${target.id}/status`).send({ status: 'RESOLVED' });

    const res = await request(ctx.app).get('/alerts');
    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({ total: 4, limit: 20, offset: 0, has_more: false });
    expect(res.body.data.every((a: { status: string }) => a.status === 'ACTIVE')).toBe(true);
    const severities = res.body.data.map((a: { severity: string }) => a.severity);
    expect(severities).toEqual(['HIGH', 'HIGH', 'MEDIUM', 'LOW']);
    expect(res.body.data[0].latest_check).toMatchObject({ status_code: expect.any(Number), response_time_ms: expect.any(Number) });
  });

  it('filters by status, severity (comma list) and api_name', async () => {
    const ctx = buildTestApp();
    await seed(ctx);
    const high = await request(ctx.app).get('/alerts?severity=high,critical');
    expect(high.body.data).toHaveLength(2);

    const byApi = await request(ctx.app).get('/alerts?api_name=appointment');
    expect(byApi.body.data).toHaveLength(3);
    expect(byApi.body.data.every((a: { api_name: string }) => a.api_name === 'AppointmentAPI')).toBe(true);

    const all = await request(ctx.app).get('/alerts?status=ALL');
    expect(all.body.pagination.total).toBe(5);
    const resolved = await request(ctx.app).get('/alerts?status=RESOLVED');
    expect(resolved.body.data).toHaveLength(0);
  });

  it('paginates with limit and offset', async () => {
    const ctx = buildTestApp();
    await seed(ctx);
    const page1 = await request(ctx.app).get('/alerts?limit=2&offset=0');
    const page2 = await request(ctx.app).get('/alerts?limit=2&offset=2');
    const page3 = await request(ctx.app).get('/alerts?limit=2&offset=4');
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.pagination.has_more).toBe(true);
    expect(page3.body.data).toHaveLength(1);
    const ids = [...page1.body.data, ...page2.body.data, ...page3.body.data].map((a: { id: string }) => a.id);
    expect(new Set(ids).size).toBe(5);
  });

  it.each(['limit=0', 'limit=101', 'offset=-1', 'severity=urgent', 'status=OPEN', 'unknown=1'])('rejects invalid query %s', async (qs) => {
    const res = await request(buildTestApp().app).get(`/alerts?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns alert detail with recent occurrences', async () => {
    const ctx = buildTestApp();
    await ingest(ctx, [failing, failing]);
    const alert = await prisma.alert.findFirstOrThrow({ where: { anomalyType: 'SERVER_ERROR' } });
    const res = await request(ctx.app).get(`/alerts/${alert.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: alert.id, occurrence_count: 2, anomaly_type: 'SERVER_ERROR' });
    expect(res.body.data.recent_occurrences).toHaveLength(2);
    expect(res.body.data.evidence.check).toMatchObject({ statusCode: 500, latencyThresholdMs: 3000 });
  });
});

describe('dashboard endpoints', () => {
  it('GET /stats summarises checks and alerts', async () => {
    const ctx = buildTestApp();
    await ingest(ctx, [healthy, failing]);
    const res = await request(ctx.app).get('/stats');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      total_checks: 2,
      anomalous_checks: 1,
      monitored_apis: 2,
      alerts: { active: 3, acknowledged: 0, resolved: 0, critical_or_high_active: 1 },
      affected_apis: [{ api_name: 'AppointmentAPI', open_alerts: 3, highest_severity: 'HIGH' }],
    });
    expect(res.body.data.api_health).toHaveLength(2);
  });

  it('GET /checks lists recent checks', async () => {
    const ctx = buildTestApp();
    await ingest(ctx, [healthy, failing]);
    const res = await request(ctx.app).get('/checks?limit=1');
    expect(res.body.data).toHaveLength(1);
  });

  it('GET /health reports dependency status without secrets', async () => {
    const res = await request(buildTestApp().app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', dependencies: { database: 'up', llm: 'configured' } });
    expect(JSON.stringify(res.body)).not.toMatch(/postgres|password|api_key/i);
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(buildTestApp().app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('sets security headers', async () => {
    const res = await request(buildTestApp().app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
