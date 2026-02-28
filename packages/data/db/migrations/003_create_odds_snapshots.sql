-- Migration: Create odds_snapshots table
-- Purpose: Store odds data snapshots captured at specific times
-- Each row is a point-in-time capture of odds for a game
-- DateTime standard: All timestamps in ISO 8601 UTC

CREATE TABLE odds_snapshots (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  sport TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  h2h_home REAL,
  h2h_away REAL,
  total REAL,
  spread_home REAL,
  spread_away REAL,
  moneyline_home INTEGER,
  moneyline_away INTEGER,
  raw_data TEXT,
  job_run_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_id) REFERENCES games(game_id),
  FOREIGN KEY (job_run_id) REFERENCES job_runs(id)
);

CREATE INDEX idx_odds_snapshots_game_id ON odds_snapshots(game_id);
CREATE INDEX idx_odds_snapshots_sport ON odds_snapshots(sport);
CREATE INDEX idx_odds_snapshots_captured_at ON odds_snapshots(captured_at);
CREATE INDEX idx_odds_snapshots_game_captured ON odds_snapshots(game_id, captured_at);
CREATE INDEX idx_odds_snapshots_job_run_id ON odds_snapshots(job_run_id);
