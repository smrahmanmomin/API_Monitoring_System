-- CreateEnum
CREATE TYPE "CheckSource" AS ENUM ('API', 'FILE', 'DEMO');

-- CreateEnum
CREATE TYPE "AnomalyType" AS ENUM ('HIGH_LATENCY', 'SERVER_ERROR', 'RATE_LIMITED', 'AUTH_FAILURE', 'CLIENT_ERROR', 'UNEXPECTED_STATUS', 'MISSING_RECORD_COUNT', 'INVALID_RECORD_COUNT', 'ZERO_RECORDS', 'LOW_RECORD_COUNT');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "GenerationSource" AS ENUM ('AI', 'FALLBACK');

-- CreateTable
CREATE TABLE "api_checks" (
    "id" UUID NOT NULL,
    "api_name" VARCHAR(100) NOT NULL,
    "response_time_ms" INTEGER NOT NULL,
    "status_code" INTEGER NOT NULL,
    "records_returned" INTEGER,
    "records_issue" VARCHAR(32),
    "expected_min_records" INTEGER,
    "checked_at" TIMESTAMPTZ(3) NOT NULL,
    "anomaly_count" INTEGER NOT NULL DEFAULT 0,
    "source" "CheckSource" NOT NULL DEFAULT 'API',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "fingerprint" VARCHAR(160) NOT NULL,
    "api_name" VARCHAR(100) NOT NULL,
    "anomaly_type" "AnomalyType" NOT NULL,
    "severity" "Severity" NOT NULL,
    "base_severity" "Severity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "evidence" JSONB NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "summary" TEXT NOT NULL,
    "possible_causes" JSONB NOT NULL,
    "recommended_actions" JSONB NOT NULL,
    "generation_source" "GenerationSource" NOT NULL DEFAULT 'FALLBACK',
    "ai_model" VARCHAR(120),
    "prompt_version" VARCHAR(40),
    "generated_at" TIMESTAMPTZ(3),
    "occurrence_count" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "latest_check_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_occurrences" (
    "id" UUID NOT NULL,
    "alert_id" UUID NOT NULL,
    "check_id" UUID NOT NULL,
    "detected_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "alert_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_checks_api_name_checked_at_idx" ON "api_checks"("api_name", "checked_at" DESC);

-- CreateIndex
CREATE INDEX "api_checks_checked_at_idx" ON "api_checks"("checked_at" DESC);

-- CreateIndex
CREATE INDEX "alerts_status_severity_idx" ON "alerts"("status", "severity");

-- CreateIndex
CREATE INDEX "alerts_api_name_idx" ON "alerts"("api_name");

-- CreateIndex
CREATE INDEX "alerts_last_seen_at_idx" ON "alerts"("last_seen_at" DESC);

-- CreateIndex
CREATE INDEX "alerts_fingerprint_idx" ON "alerts"("fingerprint");

-- CreateIndex
CREATE INDEX "alert_occurrences_check_id_idx" ON "alert_occurrences"("check_id");

-- CreateIndex
CREATE UNIQUE INDEX "alert_occurrences_alert_id_check_id_key" ON "alert_occurrences"("alert_id", "check_id");

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_latest_check_id_fkey" FOREIGN KEY ("latest_check_id") REFERENCES "api_checks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_occurrences" ADD CONSTRAINT "alert_occurrences_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_occurrences" ADD CONSTRAINT "alert_occurrences_check_id_fkey" FOREIGN KEY ("check_id") REFERENCES "api_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deduplication guard (hand-written; Prisma cannot express partial indexes).
-- At most one non-resolved alert may exist per fingerprint ("<api>:<anomaly type>"),
-- so concurrent ingestion cannot create duplicate open alerts. A RESOLVED alert does
-- not block a new ACTIVE alert when the anomaly reappears.
CREATE UNIQUE INDEX "alerts_open_fingerprint_key" ON "alerts"("fingerprint") WHERE "status" <> 'RESOLVED';
