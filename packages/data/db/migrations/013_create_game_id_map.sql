-- Migration: Create game_id_map table
-- Purpose: Map external provider game IDs (e.g., ESPN) to canonical game_id
-- DateTime standard: All timestamps in ISO 8601 UTC

CREATE TABLE IF NOT EXISTS game_id_map (
  sport TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_game_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  match_method TEXT NOT NULL,
  match_confidence REAL NOT NULL,
  matched_at TEXT NOT NULL,
  ext_game_time_utc TEXT,
  ext_home_team TEXT,
  ext_away_team TEXT,
  odds_game_time_utc TEXT,
  odds_home_team TEXT,
  odds_away_team TEXT,
  PRIMARY KEY (sport, provider, external_game_id),
  UNIQUE (sport, provider, game_id)
);

CREATE INDEX IF NOT EXISTS idx_game_id_map_game_id
  ON game_id_map (sport, game_id);
