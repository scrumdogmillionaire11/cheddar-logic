-- Migration: Create odds ingest failure ledger for operator diagnostics

CREATE TABLE IF NOT EXISTS odds_ingest_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  failure_key TEXT NOT NULL UNIQUE,
  job_run_id TEXT,
  job_name TEXT,
  sport TEXT,
  provider TEXT,
  game_id TEXT,
  reason_code TEXT NOT NULL,
  reason_detail TEXT,
  home_team TEXT,
  away_team TEXT,
  payload_hash TEXT,
  source_context TEXT,
  first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_odds_ingest_failures_last_seen
  ON odds_ingest_failures(last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_odds_ingest_failures_reason
  ON odds_ingest_failures(reason_code, last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_odds_ingest_failures_sport
  ON odds_ingest_failures(sport, last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_odds_ingest_failures_game
  ON odds_ingest_failures(game_id, last_seen DESC);
