-- Migration 030: Add player_availability table for injury/status tracking.
--
-- This table is populated by pull_nhl_player_shots when it detects a player's
-- availability status from the NHL API landing payload. It provides a persistent
-- record of injury checks that can be shared across jobs (e.g., model runners
-- can skip players that the pull job logged as injured without re-fetching the API).
--
-- Primary key is (player_id, sport) so each player has one row per sport.
-- On re-check, use INSERT OR REPLACE to overwrite with latest status.

CREATE TABLE IF NOT EXISTS player_availability (
  player_id INTEGER NOT NULL,
  sport TEXT NOT NULL DEFAULT 'NHL',
  status TEXT NOT NULL,
  status_reason TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (player_id, sport)
);
