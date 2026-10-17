/**
 * Development seed: synthetic monitoring history for a realistic dashboard.
 * Uses fictional API names and metrics only — no patient data of any kind.
 *
 *   npm run db:seed            # wipe + load synthetic history
 *   npm run db:clear           # wipe only (empty dashboard, e.g. before a live demo)
 *
 * Goes through the real ingestion pipeline (validation → rules → dedup → alerts), so the
 * seeded alerts are exactly what the running system would produce. Runs in fallback mode
 * (no LLM calls) to avoid spending provider quota; use the dashboard "Run demo" button or
 * POST /monitor to see AI-generated alerts.
 */
import { loadEnv } from '../src/config/env.js';
import { createDeps } from '../src/container.js';
import { createLogger } from '../src/utils/logger.js';
import { createPrismaClient } from '../src/utils/prisma.js';

const MINUTE = 60_000;

const APIS = {
  PatientDataAPI: { latency: 900, records: 50 },
  AppointmentAPI: { latency: 1100, records: 30 },
  BillingAPI: { latency: 1500, records: 120 },
  LabResultsAPI: { latency: 700, records: 15 },
  PharmacyAPI: { latency: 600, records: 40 },
} as const;

type ApiName = keyof typeof APIS;

function event(api: ApiName, minutesAgo: number, overrides: Record<string, unknown> = {}) {
  return {
    api_name: api,
    response_time_ms: APIS[api].latency + ((minutesAgo * 37) % 300),
    status_code: 200,
    records_returned: APIS[api].records,
    checked_at: new Date(Date.now() - minutesAgo * MINUTE).toISOString(),
    ...overrides,
  };
}

function buildHistory() {
  const events: Array<Record<string, unknown>> = [];
  // Two hours of healthy checks every 15 minutes for every API.
  for (let m = 120; m >= 15; m -= 15) for (const api of Object.keys(APIS) as ApiName[]) events.push(event(api, m));

  // Incidents (oldest first so first/last-seen timestamps are realistic).
  events.push(event('AppointmentAPI', 45, { status_code: 500, response_time_ms: 5500, records_returned: 0 }));
  events.push(event('AppointmentAPI', 30, { status_code: 503, response_time_ms: 6100, records_returned: 0 }));
  events.push(event('AppointmentAPI', 10, { status_code: 500, response_time_ms: 5800, records_returned: 0 }));
  events.push(event('BillingAPI', 25, { response_time_ms: 4200 }));
  events.push(event('BillingAPI', 5, { response_time_ms: 4700 }));
  events.push(event('LabResultsAPI', 20, { records_returned: 0, expected_min_records: 1 }));
  events.push(event('PharmacyAPI', 12, { status_code: 429, records_returned: null }));
  const { records_returned: _omit, ...missingCount } = event('PatientDataAPI', 8);
  events.push(missingCount);
  return events;
}

async function main() {
  const env = loadEnv();
  const logger = createLogger('warn', env.NODE_ENV);
  const prisma = createPrismaClient(env.DATABASE_URL);
  const deps = createDeps(env, logger, prisma, { llmProvider: null, emailService: null });

  // Removes monitoring rows only; the schema and migrations are untouched.
  await prisma.$transaction([prisma.alertOccurrence.deleteMany(), prisma.alert.deleteMany(), prisma.apiCheck.deleteMany()]);
  if (process.argv.includes('--empty')) {
    console.log('Cleared all checks and alerts.');
    await prisma.$disconnect();
    return;
  }
  const result = await deps.monitoringService.ingest(buildHistory(), 'DEMO');
  await deps.enrichmentQueue.drain();

  // Show lifecycle states on the dashboard: acknowledge one alert, resolve another.
  const latency = await prisma.alert.findFirst({ where: { anomalyType: 'HIGH_LATENCY', apiName: 'BillingAPI' } });
  if (latency) await deps.alertService.updateStatus(latency.id, 'ACKNOWLEDGED');
  const missing = await prisma.alert.findFirst({ where: { anomalyType: 'MISSING_RECORD_COUNT' } });
  if (missing) await deps.alertService.updateStatus(missing.id, 'RESOLVED');

  console.log('Seed complete:', result.summary);
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
