-- Migration 057: Add player_name and team_id columns to player_availability.
--
-- These columns are needed for the NBA availability gate (WI-0769), which
-- queries rows by ESPN team abbreviation (team_id) rather than numeric
-- player_id. The NBA sync job populates both fields; existing NHL rows
-- remain NULL for these columns (NHL gate uses player_id lookup).

ALTER TABLE player_availability ADD COLUMN player_name TEXT DEFAULT NULL;
ALTER TABLE player_availability ADD COLUMN team_id TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_player_availability_team_sport
  ON player_availability (team_id, sport);
