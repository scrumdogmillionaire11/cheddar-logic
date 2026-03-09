-- Migration: Create team_metrics_cache table for daily ESPN metrics persistence
-- Purpose: Cache ESPN team metrics + recent games by sport/team/date to reduce API calls
-- Refresh cadence: Daily at 09:00 ET (aligned with fixed-time model windows)
-- Run timestamp: AUTO-INSERTED BY MIGRATION ENGINE

CREATE TABLE IF NOT EXISTS team_metrics_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sport TEXT NOT NULL CHECK (sport IN ('NBA', 'NHL', 'NCAAM', 'SOCCER', 'MLB', 'NFL')),
  team_name TEXT NOT NULL,
  cache_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'missing', 'failed', 'partial')),
  metrics TEXT,
  team_info TEXT,
  recent_games TEXT,
  resolution TEXT,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sport, team_name, cache_date)
);

CREATE INDEX IF NOT EXISTS idx_team_metrics_cache_lookup
  ON team_metrics_cache (sport, team_name, cache_date);

CREATE INDEX IF NOT EXISTS idx_team_metrics_cache_date
  ON team_metrics_cache (cache_date DESC);

CREATE INDEX IF NOT EXISTS idx_team_metrics_cache_status
  ON team_metrics_cache (status);

