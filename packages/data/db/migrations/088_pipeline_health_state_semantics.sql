-- Migration: Add pipeline_health state semantics for one-active-condition tracking
-- Purpose: Persist first/last seen and resolved lifecycle per check while keeping history rows.

ALTER TABLE pipeline_health ADD COLUMN check_id TEXT;
ALTER TABLE pipeline_health ADD COLUMN dedupe_key TEXT;
ALTER TABLE pipeline_health ADD COLUMN first_seen_at TEXT;
ALTER TABLE pipeline_health ADD COLUMN last_seen_at TEXT;
ALTER TABLE pipeline_health ADD COLUMN resolved_at TEXT;

CREATE INDEX idx_pipeline_health_check_id ON pipeline_health(check_id);
CREATE INDEX idx_pipeline_health_check_id_created_at ON pipeline_health(check_id, created_at DESC);
CREATE INDEX idx_pipeline_health_active ON pipeline_health(check_id, resolved_at, created_at DESC);
CREATE UNIQUE INDEX idx_pipeline_health_one_active_per_check
  ON pipeline_health(check_id)
  WHERE resolved_at IS NULL;