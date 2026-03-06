CREATE TABLE IF NOT EXISTS run_state (
  id TEXT PRIMARY KEY,
  current_run_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO run_state (id, current_run_id, updated_at)
VALUES ('singleton', NULL, CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS idx_job_runs_started_at
  ON job_runs(started_at DESC);