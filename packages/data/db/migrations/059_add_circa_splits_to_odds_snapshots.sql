-- 059_add_circa_splits_to_odds_snapshots.sql
--
-- Adds Circa Sports sharp-money splits columns sourced from VSIN (source='CIRCA').
-- Circa is a professional/sharp book; handle % here signals smart-money positioning.
--
-- Related: WI-0776, pull_vsin_splits.js (second CIRCA fetch pass)
-- Source: https://data.vsin.com/{sport}/betting-splits/ (Circa Sports book data)

ALTER TABLE odds_snapshots ADD COLUMN circa_handle_pct_home  REAL DEFAULT NULL;
ALTER TABLE odds_snapshots ADD COLUMN circa_handle_pct_away  REAL DEFAULT NULL;
ALTER TABLE odds_snapshots ADD COLUMN circa_tickets_pct_home REAL DEFAULT NULL;
ALTER TABLE odds_snapshots ADD COLUMN circa_tickets_pct_away REAL DEFAULT NULL;
