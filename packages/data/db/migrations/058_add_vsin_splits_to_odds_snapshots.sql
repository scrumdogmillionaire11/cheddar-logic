-- 058_add_vsin_splits_to_odds_snapshots.sql
--
-- Adds DraftKings public betting-splits columns sourced from VSIN (data.vsin.com).
-- These run PARALLEL to the Action Network splits (public_bets_pct_* columns added
-- by migration 055). Both sources remain active; the DK-labelled columns reflect
-- VSIN/DK-specific data so callers know which book the figures came from.
--
-- Related: WI-0762, pull_vsin_splits.js
-- Source: https://data.vsin.com/{sport}/betting-splits/ (DraftKings book data)

ALTER TABLE odds_snapshots ADD COLUMN dk_bets_pct_home    REAL DEFAULT NULL;
ALTER TABLE odds_snapshots ADD COLUMN dk_bets_pct_away    REAL DEFAULT NULL;
ALTER TABLE odds_snapshots ADD COLUMN dk_handle_pct_home  REAL DEFAULT NULL;
ALTER TABLE odds_snapshots ADD COLUMN dk_handle_pct_away  REAL DEFAULT NULL;
ALTER TABLE odds_snapshots ADD COLUMN dk_tickets_pct_home REAL DEFAULT NULL;
ALTER TABLE odds_snapshots ADD COLUMN dk_tickets_pct_away REAL DEFAULT NULL;
ALTER TABLE odds_snapshots ADD COLUMN vsin_captured_at    TEXT DEFAULT NULL;
