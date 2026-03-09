-- Migration: Fix team_metrics_cache schema to match db.js expectations
--
-- The live table was created with an early WI-0351 schema (id TEXT, sport lowercase,
-- team_normalized, metrics_data, expires_at). Migration 025 was a no-op because the
-- table already existed via IF NOT EXISTS.
--
-- The db.js functions (getTeamMetricsCache / upsertTeamMetricsCache) expect:
--   team_name, cache_date, status, metrics, team_info, recent_games, resolution, fetched_at
--
-- This migration drops the broken table and recreates it with the correct schema.
-- Existing cached data is worthless (0 rows) so no data migration is needed.

PRAGMA foreign_keys=OFF;

DROP TABLE IF EXISTS team_metrics_cache;

CREATE TABLE team_metrics_cache (
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

PRAGMA foreign_keys=ON;
