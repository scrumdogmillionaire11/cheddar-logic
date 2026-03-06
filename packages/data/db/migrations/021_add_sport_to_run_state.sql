-- Per-sport run_id tracking
-- Adds a sport column to run_state and seeds one row per sport so each
-- model can track its own current_run_id independently. The existing
-- 'singleton' row is kept for backwards compatibility.

ALTER TABLE run_state ADD COLUMN sport TEXT;

INSERT OR IGNORE INTO run_state (id, sport, current_run_id, updated_at)
VALUES
  ('nhl',   'nhl',   NULL, CURRENT_TIMESTAMP),
  ('nba',   'nba',   NULL, CURRENT_TIMESTAMP),
  ('ncaam', 'ncaam', NULL, CURRENT_TIMESTAMP),
  ('nfl',   'nfl',   NULL, CURRENT_TIMESTAMP),
  ('mlb',   'mlb',   NULL, CURRENT_TIMESTAMP),
  ('soccer','soccer',NULL, CURRENT_TIMESTAMP);
