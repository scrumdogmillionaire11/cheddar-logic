-- Migration 055: add public betting splits columns to odds_snapshots
-- Stores public bet %, handle %, ticket % and metadata from external providers
-- (e.g. Action Network). All columns are nullable; existing rows are unaffected.

ALTER TABLE odds_snapshots ADD COLUMN public_bets_pct_home    REAL    DEFAULT NULL;
ALTER TABLE odds_snapshots ADD COLUMN public_bets_pct_away    REAL    DEFAULT NULL;
ALTER TABLE odds_snapshots ADD COLUMN public_handle_pct_home  REAL    DEFAULT NULL;
ALTER TABLE odds_snapshots ADD COLUMN public_handle_pct_away  REAL    DEFAULT NULL;
ALTER TABLE odds_snapshots ADD COLUMN public_tickets_pct_home REAL    DEFAULT NULL;
ALTER TABLE odds_snapshots ADD COLUMN public_tickets_pct_away REAL    DEFAULT NULL;
ALTER TABLE odds_snapshots ADD COLUMN splits_source           TEXT    DEFAULT NULL;
ALTER TABLE odds_snapshots ADD COLUMN splits_captured_at      TEXT    DEFAULT NULL;
