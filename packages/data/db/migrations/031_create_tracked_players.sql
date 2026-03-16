-- Migration 031: Add tracked_players table for automated player ID sourcing.
--
-- This table stores per-market tracked player IDs (starting with NHL SOG) so
-- pull jobs can source player IDs from DB instead of a manually maintained env var.

CREATE TABLE IF NOT EXISTS tracked_players (
  player_id INTEGER NOT NULL,
  sport TEXT NOT NULL,
  market TEXT NOT NULL,
  player_name TEXT,
  team_abbrev TEXT,
  shots INTEGER,
  games_played INTEGER,
  shots_per_game REAL,
  season_id INTEGER,
  source TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, sport, market)
);

CREATE INDEX IF NOT EXISTS idx_tracked_players_active_market
  ON tracked_players (sport, market, is_active);

CREATE INDEX IF NOT EXISTS idx_tracked_players_sync_time
  ON tracked_players (last_synced_at DESC);
