-- Migration: Add spread and total prices to odds_snapshots
-- Purpose: Store individual market prices (not just lines) for accurate edge calculation
-- Enables computing probability edges instead of points deltas

ALTER TABLE odds_snapshots ADD COLUMN spread_price_home INTEGER;
ALTER TABLE odds_snapshots ADD COLUMN spread_price_away INTEGER;
ALTER TABLE odds_snapshots ADD COLUMN total_price_over INTEGER;
ALTER TABLE odds_snapshots ADD COLUMN total_price_under INTEGER;
