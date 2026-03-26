-- Migration 044: T-minus pull dedup log
--
-- Prevents duplicate odds pulls on scheduler restart mid-tick.
-- The in-memory preModelOddsQueued Set resets on every process restart, so a
-- crash-restart during a T-minus window fires a second pull for the same sport+window.
-- DB-backed INSERT OR IGNORE survives restarts.
--
-- window_key format: '<sport>|T-<mins>|<YYYY-MM-DDTHH>'
-- Rows older than 48h are purged on scheduler startup.

CREATE TABLE IF NOT EXISTS tminus_pull_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sport       TEXT    NOT NULL,
  window_key  TEXT    NOT NULL,  -- e.g. 'nba|T-30|2026-03-25T19'
  queued_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (window_key)
);

CREATE INDEX IF NOT EXISTS idx_tminus_pull_log_queued ON tminus_pull_log (queued_at);
