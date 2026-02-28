-- Migration: Add job_key to job_runs for deterministic idempotency
-- Purpose: Enable window-based scheduling with "run once per window" guarantee
-- Window key format: sport|window_type|context|value
--   Examples:
--     nhl|fixed|2026-02-27|0900
--     nhl|tminus|nhl-2026-02-27-van-sea|120
--     odds|hourly|2026-02-27|15

ALTER TABLE job_runs ADD COLUMN job_key TEXT;

CREATE INDEX IF NOT EXISTS idx_job_runs_job_key ON job_runs(job_key);
CREATE INDEX IF NOT EXISTS idx_job_runs_job_key_status ON job_runs(job_key, status);
