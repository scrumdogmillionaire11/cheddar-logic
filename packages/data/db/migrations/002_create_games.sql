-- Migration: Create games table
-- Purpose: Store game information (teams, start times, sport) as the primary entity
-- DateTime standard: All game times in ISO 8601 UTC

CREATE TABLE games (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  game_id TEXT NOT NULL UNIQUE,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  game_time_utc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_games_sport ON games(sport);
CREATE INDEX idx_games_game_id ON games(game_id);
CREATE INDEX idx_games_game_time_utc ON games(game_time_utc);
CREATE INDEX idx_games_status ON games(status);
