# Intelligent API Monitoring & AI-Powered Alert System

This project monitors the APIs a healthcare organisation depends on for patient and operational data. It accepts monitoring events, either one at a time or in batches, and checks each event against deterministic rules for high latency, failed requests, and missing or zero records. Every check and every anomaly is stored in PostgreSQL. An LLM then turns each anomaly into a readable alert with a summary, hypotheses, and recommended actions. Operators triage the alerts in a React dashboard and can receive optional e-mail reports.

> **Core design principle:** the rules decide *whether* something is an anomaly and how severe it is. The LLM only *explains* the anomaly. When the LLM is unavailable, a deterministic fallback writes the alert text instead, so no anomaly is lost and every alert says which of the two wrote it.

---

## Contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Technology stack](#technology-stack)
4. [Repository structure](#repository-structure)
5. [Quick start](#quick-start)
6. [Environment variables](#environment-variables)
7. [Database](#database)
8. [Running, testing, building](#running-testing-building)
9. [Demo workflow](#demo-workflow)
10. [REST API](#rest-api)
11. [Monitoring rules](#monitoring-rules)
12. [LLM integration and fallback](#llm-integration-and-fallback)
13. [E-mail reports (optional feature)](#e-mail-reports-optional-feature)
14. [Security and privacy](#security-and-privacy)
15. [Known limitations](#known-limitations)
16. [Deliverables](#deliverables)

---

## Features

- **Two ways to send input**
  - `POST /monitor` accepts a single event or a batch of up to 500.
  - `npm run ingest:file` sends a static JSON file (assignment §5, method 1).
- **Per-item validation and partial failure.** A malformed item in a batch is reported back with its index and never disappears silently. Responses use `201`, `207`, `400` and `413`.
- **Deterministic anomaly detection**
  - Covers latency, 5xx errors, rate limiting, authentication failures, other 4xx, and unexpected 1xx/3xx codes.
  - Covers missing, invalid, zero, and below-expected record counts.
  - One event can produce **several findings**.
- **Configurable thresholds.** Set a global latency threshold, override it per API, and set expected minimum record counts.
- **Alert lifecycle:** `ACTIVE → ACKNOWLEDGED → RESOLVED`
  - Repeats of the same anomaly are **deduplicated** into one alert, tracked with an occurrence count and first/last-seen times.
  - Severity is **escalated** after repeated occurrences.
  - If a resolved anomaly reappears, a new alert opens.
- **AI-generated alerts**
  - Works with any OpenAI-compatible API. The default is the **Groq free tier**.
  - Uses a versioned prompt and validated JSON output, with one repair attempt.
  - Generation runs asynchronously, with timeouts and retries.
- **Deterministic fallback text.** Used when no key is configured or the provider fails. The alert is always labelled **AI** or **Rule**.
- **React dashboard**
  - An "API health" panel showing the latest check per API against the latency threshold.
  - Counters, plus filters by status, severity, and API.
  - Paginated alerts table, a detail panel with evidence and history, and Acknowledge / Resolve / Regenerate actions.
  - 10-second polling, a demo panel with sample and custom JSON input, and loading, empty, and error states.
- **E-mail anomaly reports** through SMTP (Mailpit locally) for HIGH and CRITICAL alerts.
- **Operations and safety**
  - Structured logging (Pino) with request IDs.
  - Helmet, explicit CORS, rate limiting, and body and batch limits.
  - Environment variables are validated at startup.
- **Tests:** 95 unit tests (89 backend, 6 frontend) and 43 API integration tests against a real PostgreSQL test database. The LLM is mocked, so no paid key is needed.

## Architecture

```
               ┌──────────────── React dashboard (Vite, :5173) ────────────────┐
               │  API health · counters · filters · alerts table · detail      │
               │  demo panel (sample/custom JSON)  ── /api proxy ──┐            │
               └───────────────────────────────────────────────────┼────────────┘
 JSON file ── npm run ingest:file ──┐                              │
 Any client ── POST /monitor ───────┤                              ▼
                                    ▼                 Express API (:4000)
                   helmet · CORS · rate limit · request-id · JSON limit · error handler
                                    │
               ┌────────────────────┼──────────────────────────────────────────┐
               ▼                    ▼                                          ▼
     MonitoringService      AlertService (lifecycle)                Repositories (queries)
     validate each item ─►  one DB transaction per event:           GET /alerts, /stats,
     rule engine (pure) ─►  ApiCheck + Alert upsert (dedup,         /checks, /alerts/:id
                            escalation) + AlertOccurrence,
                            fallback text written immediately
                                    │ after commit
                                    ▼
                    EnrichmentQueue (in-process, concurrency 2)
                    LLM provider ─► Zod-validated JSON ─► alert marked AI
                    on failure: keep fallback text (marked Rule)
                                    │
                                    ▼
                    EmailService (HIGH+ new/escalated alerts) ─► SMTP (Mailpit)

                         PostgreSQL 16 (Docker): api_checks · alerts · alert_occurrences
```

**Key decisions**

| Decision | Why |
|---|---|
| Rule engine is a pure function, `evaluateEvent(event, thresholds)` | Deterministic and unit-testable. The LLM can never invent or suppress an anomaly. |
| Checks and alerts live in separate tables | Healthy checks are kept for history and stats. An alert groups many occurrences. |
| Dedup via a fingerprint `api:type` plus a **partial unique index** (`WHERE status <> 'RESOLVED'`) | Prevents duplicate open alerts even under concurrent ingestion. A resolved alert doesn't block a new one. |
| Fallback text is written inside the ingestion transaction, then AI text is applied asynchronously | Ingestion never waits on or fails because of the LLM. No detected anomaly is lost. |
| A single OpenAI-compatible provider class | One small, testable adapter covers Groq, Gemini, OpenRouter, Ollama, and OpenAI. |
| AI is called only for new or escalated alerts | Saves free-tier quota. Plain repeats only update counts and evidence. |
| An in-process queue instead of Redis or another broker | Simplest reliable option at this scale. The trade-off is documented under [limitations](#known-limitations). |
| snake_case API contract everywhere | Matches the assignment's input format, and stays consistent for both input and output. |

## Technology stack

| Layer | Choice |
|---|---|
| Backend | Node.js 22, TypeScript 5.9, Express 5, Zod 3, Prisma 6, Pino 9, Helmet, express-rate-limit, Nodemailer |
| Database | PostgreSQL 16 (Docker Compose) |
| AI | Official `openai` SDK v6 against any OpenAI-compatible endpoint. The default is Groq `openai/gpt-oss-120b`. |
| Frontend | React 19, Vite 7, TanStack Query 5, hand-written CSS (no UI framework) |
| Tests | Vitest 3 and Supertest |
| Tooling | npm workspaces, Docker Compose, GitHub Actions CI, the `docx` library for AI_Prompts.docx |

The stable major versions were chosen deliberately: Prisma 6 rather than 7, TypeScript 5 rather than 7, and Zod 3 rather than 4. Their APIs are mature and well documented, which suits a time-boxed assignment.

## Repository structure

```
.
├── backend/
│   ├── prisma/                 schema.prisma, migrations/, seed.ts
│   ├── src/
│   │   ├── config/             env.ts (Zod-validated env), thresholds.ts
│   │   ├── controllers/        monitor, alerts, system (+ snake_case serializers)
│   │   ├── middleware/         error handler, request logging/IDs, validation helper
│   │   ├── repositories/       alert + stats queries
│   │   ├── routes/             route table
│   │   ├── schemas/            monitor event + alert query/body schemas
│   │   ├── services/
│   │   │   ├── monitoring/     ruleEngine.ts (pure), monitoringService.ts, types.ts
│   │   │   ├── alerts/         alertService.ts (transaction, dedup), lifecycle.ts, evidence.ts
│   │   │   ├── ai/             prompts/alertPrompt.v1.ts, openAiCompatibleProvider.ts,
│   │   │   │                   alertOutput.schema.ts, fallbackGenerator.ts, enrichmentQueue.ts
│   │   │   └── notifications/  emailService.ts
│   │   ├── cli/ingestFile.ts   static JSON file input
│   │   ├── container.ts        dependency wiring
│   │   ├── app.ts / server.ts
│   └── tests/                  unit/, integration/, live/ (opt-in), helpers/
├── frontend/src/               api/ (client, types), hooks/, components/, lib/, App.tsx, styles.css
├── samples/                    sample-batch.json, assignment-example.json, mixed-invalid-batch.json
├── docs/                       prompts/implementation-prompt.md
├── scripts/                    generate-ai-prompts-docx.ts
├── docker/postgres/            init script that creates the test database
├── docker-compose.yml          PostgreSQL (host port 5433) + Mailpit (SMTP 1025, UI 8025)
├── AI_Prompts.docx             prompts documentation (assignment §9)
└── .github/workflows/ci.yml
```

## Quick start

**Prerequisites:** Node.js **20.19+** (tested on 22.19), npm 10, and Docker Desktop.

```bash
# 1. Start PostgreSQL and Mailpit
docker compose up -d

# 2. Install dependencies (also runs `prisma generate`)
npm install

# 3. Configure the backend
cp backend/.env.example backend/.env      # Windows PowerShell: Copy-Item backend/.env.example backend/.env
#    optional: put a free Groq key in LLM_API_KEY (https://console.groq.com/keys)

# 4. Create the schema and load demo history
npm run db:deploy
npm run db:seed

# 5. Run backend (:4000) and frontend (:5173) together
npm run dev
```

Then open:
- **http://localhost:5173** for the dashboard.
- **http://localhost:8025** for the Mailpit inbox, where alert e-mails arrive.

Without an `LLM_API_KEY` everything works, but alerts are labelled **Rule** (fallback mode). The header shows "AI off: rule-based text".

## Environment variables

Backend variables live in `backend/.env`; the template is [`backend/.env.example`](backend/.env.example). They are validated at startup, and the process exits with a clear message if a value is invalid. Empty values count as unset.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | – (**required**) | PostgreSQL connection string. Compose exposes it on `localhost:5433`. |
| `TEST_DATABASE_URL` | compose `apimonitor_test` | Used only by the integration tests. They refuse to run unless the name contains `test`. |
| `PORT` | `4000` | API port |
| `NODE_ENV` / `LOG_LEVEL` | `development` / `info` | `production` hides internal error messages from clients |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated list of allowed origins |
| `MAX_BATCH_SIZE` | `500` | Maximum events per `POST /monitor` |
| `REQUEST_BODY_LIMIT` | `256kb` | JSON body limit |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` / `MONITOR_RATE_LIMIT_MAX` | `60000` / `300` / `60` | Global and ingestion rate limits per IP |
| `LATENCY_THRESHOLD_MS` | `3000` | Global latency threshold |
| `LATENCY_HIGH_MULTIPLIER` | `2` | Latency becomes HIGH severity at threshold × multiplier |
| `API_THRESHOLDS_JSON` | – | Per-API overrides, e.g. `{"ReportingAPI":{"latencyThresholdMs":8000},"PatientDataAPI":{"expectedMinRecords":1}}` |
| `ESCALATION_OCCURRENCES` | `5` | Raise severity one level when a grouped alert reaches this many occurrences. `0` turns escalation off. |
| `LLM_ENABLED` | `true` | Turn AI explanations off without removing the key |
| `LLM_BASE_URL` | `https://api.groq.com/openai/v1` | Any OpenAI-compatible base URL |
| `LLM_API_KEY` | – | Provider key. Leave empty for fallback-only mode. |
| `LLM_MODEL` | `openai/gpt-oss-120b` | Model id. Check your provider's model list. |
| `LLM_TIMEOUT_MS` / `LLM_MAX_RETRIES` | `15000` / `2` | Per-request timeout and SDK retries with backoff |
| `LLM_MAX_OUTPUT_TOKENS` | `1200` | Output budget. Reasoning models spend part of it on hidden reasoning. |
| `LLM_REASONING_EFFORT` | – | `low`/`medium`/`high`, sent only when set. Use `low` for gpt-oss. |
| `LLM_CONCURRENCY` | `1` | Parallel AI jobs. Free tiers cap tokens per minute, so 1 avoids rate limits. |
| `LLM_RATE_LIMIT_RETRY_MS` / `LLM_RATE_LIMIT_ATTEMPTS` | `20000` / `3` | When the provider rate-limits, wait and retry the job this many times before keeping the fallback text |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` | `localhost`, `1025`, `false` | SMTP server. E-mail is disabled if `SMTP_HOST` or `ALERT_EMAIL_TO` is empty. |
| `ALERT_EMAIL_FROM` / `ALERT_EMAIL_TO` | – | Sender and recipient |
| `EMAIL_MIN_SEVERITY` | `HIGH` | Minimum severity that triggers an e-mail |
| `DASHBOARD_URL` | `http://localhost:5173` | Used for the deep link in e-mails (`/?alert=<id>`) |

Frontend variables live in `frontend/.env`; the template is [`frontend/.env.example`](frontend/.env.example). All are optional:
- `VITE_API_BASE_URL`, default `/api`, which goes through the Vite proxy.
- `BACKEND_URL`, the proxy target, default `http://localhost:4000`.
- `VITE_POLL_INTERVAL_MS`, default `10000`.

**Switching LLM provider.** Only the environment changes:

| Provider | `LLM_BASE_URL` | `LLM_MODEL` (example) | Cost |
|---|---|---|---|
| Groq (default) | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` | free tier, no card |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | a current Flash model from AI Studio | free tier |
| Ollama (local) | `http://localhost:11434/v1` | `llama3.1` (`LLM_API_KEY=ollama`) | free, offline |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | paid |

## Database

The schema is in [`backend/prisma/schema.prisma`](backend/prisma/schema.prisma), and the migration is in `backend/prisma/migrations/`.

- **`api_checks`** has one row per accepted event, healthy or not. It stores the API, latency, status, the record count (or the reason it is unusable), the expected minimum, the check time, the anomaly count, and the source (`API`/`FILE`/`DEMO`).
- **`alerts`** has one row per open anomaly per API. It stores:
  - the fingerprint, type, severity, base severity, and status;
  - structured `evidence` (JSON) and the title, summary, causes, and actions;
  - `generation_source` (AI/FALLBACK), the model, and the prompt version;
  - the occurrence count and first/last-seen, acknowledged, and resolved times;
  - the latest check.
- **`alert_occurrences`** links every detection to its check, for history.
- **Indexes:** `(api_name, checked_at)`, `(status, severity)`, `last_seen_at`, `fingerprint`, and the partial unique index on open fingerprints.

```bash
npm run db:deploy   # apply migrations (non-interactive)
npm run db:migrate  # dev: create/apply migrations interactively (prisma migrate dev)
npm run db:seed     # wipe checks/alerts and load ~2h of synthetic history (fictional data only)
npm run db:clear    # wipe checks/alerts only — empty dashboard before a live demo
npm run db:reset    # drop and recreate the dev database (destructive; asks for confirmation)
```

The seed runs the same ingestion pipeline as the API, in fallback mode. It also acknowledges one alert and resolves another, so every lifecycle state is visible on the dashboard.

## Running, testing, building

| Command | What it does |
|---|---|
| `npm run dev` | Backend (`tsx watch`, :4000) and frontend (Vite, :5173) together |
| `npm run dev:backend` / `npm run dev:frontend` | Run one of them |
| `npm test` | Backend unit and integration tests, then frontend unit tests (needs `docker compose up -d`) |
| `npm run test:unit -w backend` | Backend unit tests only (no database needed) |
| `npm run test:llm -w backend` | **Opt-in** live call to your LLM provider (needs `LLM_API_KEY`; skipped otherwise) |
| `npm run typecheck` | `tsc --noEmit` for both packages |
| `npm run build` | `prisma generate` + `tsc` for the backend (`backend/dist`) and `vite build` for the frontend (`frontend/dist`) |
| `npm start -w backend` | Run the compiled backend |
| `npm run preview -w frontend` | Serve the built frontend on :4173, proxying `/api` |
| `npm run docs:prompts` | Regenerate `AI_Prompts.docx` from the prompt source |

The integration tests use a separate `apimonitor_test` database. Compose creates it on first start, and the tests apply migrations to it automatically and truncate it between tests. If your Postgres volume predates the init script, create the database yourself:

```bash
docker exec apimonitor-postgres createdb -U apimonitor apimonitor_test
```

## Demo workflow

1. Run `docker compose up -d`, then `npm run db:seed`, then `npm run dev`, and open http://localhost:5173.
2. **Send test events → Send sample batch.** This posts [`samples/sample-batch.json`](samples/sample-batch.json) to `POST /monitor`, labelled as demo data. The batch contains:

   | # | Scenario | Expected result |
   |---|---|---|
   | 0 | Normal (`PatientDataAPI`, 200, 1200 ms, 50 rec) | healthy, no alert |
   | 1 | Slow (`BillingAPI`, 4200 ms) | HIGH_LATENCY · MEDIUM |
   | 2 | Server error (`AppointmentAPI`, 500, 5500 ms, 0 rec) | SERVER_ERROR · HIGH + HIGH_LATENCY · MEDIUM + ZERO_RECORDS · LOW |
   | 3 | Zero records with `expected_min_records: 1` (`LabResultsAPI`) | ZERO_RECORDS · MEDIUM |
   | 4 | Missing `records_returned` (`InsuranceAPI`) | MISSING_RECORD_COUNT · MEDIUM |

3. Click an alert to open its summary, recommended actions, hypotheses, evidence, and history. Use **Acknowledge** and then **Resolve**.
4. Send the batch again. The occurrence counts increase instead of new alerts being created. After 5 occurrences, severity escalates.
5. Resolve an alert, then send again: a new **Active** alert opens.
6. Try **Custom JSON**. For example, paste [`samples/mixed-invalid-batch.json`](samples/mixed-invalid-batch.json) to see per-item rejections (HTTP 207).
7. Open http://localhost:8025 to see the HIGH-severity e-mail reports.
8. File input: `npm run ingest:file -- samples/sample-batch.json`

## REST API

The base URL is `http://localhost:4000`. The dashboard calls the same routes through `/api/...`. Every error uses one shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid query parameters", "details": [{ "path": "limit", "message": "..." }], "request_id": "..." } }
```

Every response carries an `X-Request-Id` header. If the caller sends a safe `X-Request-Id`, it is echoed back.

### `POST /monitor`

The body is one event object or an array of 1–`MAX_BATCH_SIZE` events.

| Field | Type | Rules |
|---|---|---|
| `api_name` | string | required, 1–100 chars, `[A-Za-z0-9._-]` |
| `response_time_ms` | integer | required, 0 – 600000 |
| `status_code` | integer | required, 100–599 |
| `records_returned` | number \| numeric string \| null | optional. Missing, null, negative, or non-integer values become **data-quality anomalies**, not validation errors. |
| `expected_min_records` | integer ≥ 0 | optional |
| `checked_at` | ISO-8601 with offset | optional. Defaults to server time and must not be in the future. |

Unknown properties are **rejected**. This keeps arbitrary payloads, including patient data, out of storage and out of the LLM prompt. The optional header `X-Monitor-Source: demo|file|api` labels where the data came from.

**Partial-failure strategy**

| Status | Meaning |
|---|---|
| `201` | Every item was accepted |
| `207` | Some items were accepted and some were rejected or failed. See `results[]`, which has one entry per input index. |
| `400` | The body is not an event or array, the batch is empty, malformed JSON was sent, or **no** item passed validation (details are per index) |
| `413` | The batch exceeds `MAX_BATCH_SIZE`, or the body exceeds `REQUEST_BODY_LIMIT` |
| `429` | Rate limit hit |
| `503` | No valid item could be stored (database failure) |

```bash
curl -X POST http://localhost:4000/monitor -H "Content-Type: application/json" \
  --data @samples/assignment-example.json
```

```json
{
  "summary": { "received": 2, "accepted": 2, "rejected": 0, "failed": 0, "with_anomalies": 1,
               "anomalies_detected": 3, "alerts_created": 3, "alerts_updated": 0 },
  "results": [
    { "index": 0, "status": "accepted", "check_id": "…", "api_name": "PatientDataAPI", "anomalies": [], "alerts": [] },
    { "index": 1, "status": "accepted", "check_id": "…", "api_name": "AppointmentAPI",
      "anomalies": [
        { "type": "SERVER_ERROR", "severity": "HIGH", "message": "Request failed with HTTP 500 (Internal Server Error), a server-side error.",
          "observed": { "statusCode": 500 }, "expected": { "statusClass": "2xx" } },
        { "type": "HIGH_LATENCY", "severity": "MEDIUM", "message": "Response time 5500 ms exceeded the 3000 ms threshold (1.8x).",
          "observed": { "responseTimeMs": 5500 }, "expected": { "latencyThresholdMs": 3000 } },
        { "type": "ZERO_RECORDS", "severity": "LOW", "message": "The API returned 0 records. This may be legitimate for some APIs or time windows and should be verified.",
          "observed": { "recordsReturned": 0 }, "expected": { "recordsReturned": "non-negative integer" } }
      ],
      "alerts": [ { "alert_id": "…", "type": "SERVER_ERROR", "severity": "HIGH", "outcome": "created" }, "…" ] }
  ]
}
```

Mixed batch (`samples/mixed-invalid-batch.json`): the response is `207`, and each rejected item shows exactly why:

```json
{ "index": 6, "status": "rejected", "errors": [ { "path": "(root)", "message": "Unrecognized key(s) in object: 'patient_ssn'" } ] }
```

### `GET /alerts`

By default this returns **active** alerts, most severe first and then most recent.

| Query | Values |
|---|---|
| `status` | `ACTIVE` (default), `ACKNOWLEDGED`, `RESOLVED`, a comma list, or `ALL` |
| `severity` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`, or a comma list (case-insensitive) |
| `api_name` | case-insensitive substring |
| `limit` / `offset` | 1–100 (default 20) / ≥ 0 |

```bash
curl "http://localhost:4000/alerts?severity=high,critical&limit=5"
```

```json
{
  "data": [{
    "id": "3ff8343e-…", "api_name": "AppointmentAPI", "anomaly_type": "SERVER_ERROR",
    "severity": "HIGH", "base_severity": "HIGH", "status": "ACTIVE",
    "title": "AppointmentAPI server error (with high latency, zero records)",
    "summary": "AppointmentAPI failed with HTTP 500 (Internal Server Error), took 5500 ms (threshold 3000 ms) and returned 0 records. Possible outage or backend failure.",
    "possible_causes": ["Unhandled exception in the API service", "…"],
    "recommended_actions": ["Inspect the API service logs around the check timestamp", "…"],
    "evidence": { "finding": { "…": "…" }, "check": { "statusCode": 500, "responseTimeMs": 5500, "recordsReturned": 0, "latencyThresholdMs": 3000 }, "relatedFindings": ["…"] },
    "generation": { "source": "FALLBACK", "model": null, "prompt_version": null, "generated_at": "…" },
    "occurrence_count": 1, "first_seen_at": "…", "last_seen_at": "…",
    "acknowledged_at": null, "resolved_at": null,
    "latest_check": { "api_name": "AppointmentAPI", "status_code": 500, "response_time_ms": 5500, "records_returned": 0, "source": "API", "…": "…" }
  }],
  "pagination": { "total": 1, "limit": 5, "offset": 0, "has_more": false },
  "filters": { "status": ["ACTIVE"], "severity": ["HIGH", "CRITICAL"], "api_name": null }
}
```

### Other endpoints

| Endpoint | Purpose |
|---|---|
| `GET /alerts/:id` | One alert plus its 20 most recent occurrences. Returns `400` for a malformed UUID and `404` if the alert doesn't exist. |
| `PATCH /alerts/:id/status` | Body `{"status":"ACKNOWLEDGED"}` or `{"status":"RESOLVED"}`. Allowed transitions are ACTIVE→ACKNOWLEDGED, ACTIVE→RESOLVED, and ACKNOWLEDGED→RESOLVED; anything else returns `409`. |
| `POST /alerts/:id/regenerate` | Retry AI generation for one alert synchronously. Returns `503` if no LLM is configured and `409` if the alert is resolved. |
| `GET /stats` | Dashboard counters, affected APIs, the latest check per API, and the active thresholds and LLM mode |
| `GET /checks?limit=&api_name=` | The most recent checks |
| `GET /health` | `{status, dependencies:{database, llm, email}, ai_queue_pending}`. Never includes hosts, versions, or credentials. Returns `503` if the database is down. |

## Monitoring rules

All rules run for every event, so a single event can produce several findings. Thresholds are resolved in this order: the event's own `expected_min_records`, then the per-API override in `API_THRESHOLDS_JSON`, then the global default.

| Condition | Anomaly type | Severity |
|---|---|---|
| `response_time_ms` > threshold (default 3000) | `HIGH_LATENCY` | MEDIUM; **HIGH** at ≥ 2× the threshold |
| 5xx | `SERVER_ERROR` | HIGH |
| 401 / 403 | `AUTH_FAILURE` | HIGH |
| 429 | `RATE_LIMITED` | MEDIUM |
| other 4xx | `CLIENT_ERROR` | MEDIUM |
| 1xx / 3xx | `UNEXPECTED_STATUS` | LOW |
| `records_returned` missing or null | `MISSING_RECORD_COUNT` | MEDIUM |
| negative, non-integer, or non-numeric | `INVALID_RECORD_COUNT` | MEDIUM |
| `records_returned` = 0 | `ZERO_RECORDS` | LOW, or **MEDIUM** if a minimum > 0 is expected. The text notes that zero can be legitimate. |
| 0 < records < expected minimum | `LOW_RECORD_COUNT` | LOW |

**Grouping and escalation**
- Alerts are grouped by `api_name + anomaly_type` while they are not resolved.
- Each repeat increments `occurrence_count`, updates last-seen and the evidence, and adds an occurrence row.
- An open alert never drops severity automatically.
- At `ESCALATION_OCCURRENCES` repeats (default 5), severity rises one level, capped at CRITICAL. Escalation is recorded in the evidence, triggers AI regeneration, and sends an e-mail.

## LLM integration and fallback

- **Prompt:** [`backend/src/services/ai/prompts/alertPrompt.v1.ts`](backend/src/services/ai/prompts/alertPrompt.v1.ts) (`alert-v1`). The system prompt makes the model:
  - explain only the provided evidence;
  - never fabricate logs, metrics, or causes;
  - label causes as hypotheses;
  - keep the given severity;
  - acknowledge that zero records may be legitimate;
  - treat the evidence as data, not instructions;
  - return JSON only.

  The full prompt texts are in **AI_Prompts.docx**.
- **Output handling:**
  - Requests use `response_format: json_object`.
  - The reply is parsed tolerantly (code fences are allowed) and validated with Zod: title, summary, 1–4 causes, 1–5 actions.
  - Unknown keys, including any severity, are discarded.
  - If the reply is invalid, or the provider rejects it as invalid JSON (Groq's `json_validate_failed`), **one repair prompt** is sent. If that also fails, the fallback text stays.
- **Reliability:**
  - Requests time out after 15 s, and the SDK retries up to 2 times with backoff for 408/409/429/5xx and connection errors.
  - When the provider rate-limits (Groq's free tier allows about 8,000 tokens per minute), the job is retried after 20 s, up to 3 times. AI jobs run one at a time.
  - Errors are logged by category (`timeout`, `rate_limited`, `auth`, …) without credentials or payloads.
- **Flow:**
  - Ingestion commits the alert with deterministic fallback text, marked `FALLBACK`.
  - After the commit, the enrichment queue asks the LLM.
  - On success the alert becomes `AI` with the model and prompt version. On failure it stays `FALLBACK`.
  - The UI shows **AI** or **Rule** on every alert, and so do the e-mails.
- **When the LLM is called:** for new alerts, severity escalations, and manual regeneration. It is not called for plain repeats.
- **Fallback generator** ([`fallbackGenerator.ts`](backend/src/services/ai/fallbackGenerator.ts)): fixed templates per anomaly type. They combine the facts of the check, as in "AppointmentAPI failed with HTTP 500 (Internal Server Error), took 5500 ms (threshold 3000 ms) and returned 0 records. Possible outage or backend failure.", with type-specific hypotheses and up to 5 actions.

## E-mail reports (optional feature)

When `SMTP_HOST` and `ALERT_EMAIL_TO` are set, every **new or escalated** alert at or above `EMAIL_MIN_SEVERITY` (default HIGH) is e-mailed in plain text and HTML (the HTML is escaped). The e-mail goes out after AI generation has been attempted, so it contains the final text and says whether that text is AI-generated or rule-based. It also includes a dashboard deep link. SMTP failures are logged and never affect ingestion. Locally, Mailpit catches every message at http://localhost:8025, so nothing leaves your machine.

## Security and privacy

- **Input validation:**
  - Zod checks every input: body, query, params, and environment.
  - Unknown event fields are rejected.
  - Batch-size and body-size limits apply, along with a strict status-change body and UUID-validated ids.
- **HTTP hardening:**
  - Helmet headers and `x-powered-by` turned off.
  - Explicit CORS allowlist with only `GET/POST/PATCH`.
  - Global rate limit plus a stricter one on ingestion.
- **Data access:** only through Prisma (parameterised). The one raw statement is a constant `SELECT 1` health probe.
- **Errors:** a consistent JSON shape with a request id. No stack traces are ever sent; internal messages appear only outside production, and only for 500s.
- **Logging:**
  - Pino JSON logs.
  - Authorization and cookie headers, API keys, passwords, and request bodies are redacted.
  - Request logs contain only method, URL, status, and id.
- **Secrets:**
  - Secrets come only from `backend/.env`, which is git-ignored; `.env.example` holds placeholders.
  - The LLM key never reaches the browser, because the frontend talks only to the backend.
- **What leaves the server:** for each alert explanation, the configured LLM provider receives monitoring metadata only:
  - API name, anomaly type, severity, and the rule message;
  - status code, latency, record count, and thresholds;
  - the other anomaly types in the same check;
  - the occurrence count and first/last-seen timestamps.

  No response bodies, patient data, headers, or credentials are ever sent. Free tiers (Groq, Gemini) may use submitted data to improve their models, so use a paid or self-hosted provider such as Ollama if even this metadata is sensitive. Set `LLM_ENABLED=false` to send nothing.
- **No real patient data** is needed: the samples and seed are entirely synthetic.

## Known limitations

- **Live AI was verified with Groq `openai/gpt-oss-120b`:** `npm run test:llm -w backend` passes, and a sample batch produced 6/6 AI-generated alerts plus e-mails. Free-tier output can still occasionally fall back to rule text; the alert says so. Groq has retired `llama-3.3-70b-versatile`, so confirm `LLM_MODEL` against your provider's model list (`GET /models`). The automated suite mocks the provider, covering valid output, malformed output with repair, provider-side JSON rejection, rate-limit retry, timeout, and failure.
- **The AI enrichment queue is in-process.** Pending jobs are lost on restart. Alerts keep their fallback text, and `POST /alerts/:id/regenerate` retries manually. With multiple instances, use a durable queue (for example pg-boss or BullMQ).
- **Batch items are processed sequentially** for deterministic grouping. That is fine at 500 events per request; much higher throughput would need batched writes.
- **Rate limiting is per process and in memory.** Use a shared store behind a load balancer.
- **There is no authentication or authorization on the API or dashboard.** It is intended for an internal network or behind an SSO proxy, and adding auth is the first step before any real deployment.
- **The API health panel draws every lane against the global latency threshold.** Per-API overrides are applied by the rules but are not drawn on the strip.
- **Escalation counts occurrences only.** It does not consider rate over time.
- **Automatic resolution is not implemented.** An alert stays open until an operator resolves it, even if later checks are healthy.
- **The remaining `npm audit` advisories are in development tooling only:** the Prisma CLI's `@prisma/config` and the Vitest `tinypool` dependency. They are not part of the runtime. Fixing them requires major upgrades (Prisma 7, Vitest 5) that were deliberately deferred.
- **Windows:** stop `npm run dev` before running `npm install`, because the running backend locks Prisma's query-engine DLL and `prisma generate` fails.

## Deliverables

| Deliverable | Location |
|---|---|
| Source code | this repository |
| README (setup and run) | this file |
| AI prompts documentation | [`AI_Prompts.docx`](AI_Prompts.docx), regenerated with `npm run docs:prompts`. The verbatim implementation prompt is also in [`docs/prompts/implementation-prompt.md`](docs/prompts/implementation-prompt.md). |
