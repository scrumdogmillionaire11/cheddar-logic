-- Add 1st-period total line columns to odds_snapshots
-- Stores the NHL first-period total (over/under) line and prices.
-- NULL when not available from the odds provider.
ALTER TABLE odds_snapshots ADD COLUMN total_1p REAL;
ALTER TABLE odds_snapshots ADD COLUMN total_1p_price_over REAL;
ALTER TABLE odds_snapshots ADD COLUMN total_1p_price_under REAL;
