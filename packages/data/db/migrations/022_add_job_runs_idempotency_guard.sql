-- Migration: Guard job_runs idempotency per job_key
-- Purpose: Prevent overlapping running/success rows for the same job_key.

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_runs_job_key_guard
  ON job_runs(job_key)
  WHERE job_key IS NOT NULL AND status IN ('running', 'success');
