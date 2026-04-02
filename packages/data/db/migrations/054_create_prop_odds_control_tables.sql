-- Migration 054: MLB prop odds control tables
--
-- Persists scoped MLB prop event identity and prop-odds usage telemetry so
-- the candidate-driven pipeline can enforce dedupe, burn-rate gates, and
-- freshness checks across restarts.

CREATE TABLE IF NOT EXISTS prop_event_mappings (
  sport         TEXT NOT NULL,
  market_family TEXT NOT NULL,
  game_id       TEXT NOT NULL,
  odds_event_id TEXT NOT NULL,
  mapped_at     TEXT NOT NULL,
  expires_at    TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (sport, market_family, game_id)
);

CREATE INDEX IF NOT EXISTS idx_prop_event_mappings_event
  ON prop_event_mappings (sport, market_family, odds_event_id);

CREATE INDEX IF NOT EXISTS idx_prop_event_mappings_expiry
  ON prop_event_mappings (expires_at, status);

CREATE TABLE IF NOT EXISTS prop_odds_usage_log (
  id                         TEXT PRIMARY KEY,
  sport                      TEXT NOT NULL,
  market_family              TEXT NOT NULL,
  game_id                    TEXT,
  odds_event_id              TEXT,
  dedupe_key                 TEXT NOT NULL UNIQUE,
  window_bucket              TEXT NOT NULL,
  job_name                   TEXT NOT NULL,
  status                     TEXT NOT NULL,
  skip_reason                TEXT,
  token_cost                 INTEGER NOT NULL DEFAULT 0,
  remaining_quota            INTEGER,
  candidate_rank             INTEGER,
  candidates_evaluated       INTEGER,
  executable_props_published INTEGER NOT NULL DEFAULT 0,
  leans_only_count           INTEGER NOT NULL DEFAULT 0,
  pass_count                 INTEGER NOT NULL DEFAULT 0,
  metadata                   TEXT,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prop_odds_usage_log_created
  ON prop_odds_usage_log (sport, market_family, created_at);

CREATE INDEX IF NOT EXISTS idx_prop_odds_usage_log_status
  ON prop_odds_usage_log (status, skip_reason);
