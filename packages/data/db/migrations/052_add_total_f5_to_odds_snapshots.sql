-- Add F5 total line columns to odds_snapshots
-- Stores the first-5-innings total (over/under) consensus line and prices.
-- NULL when not available from the odds provider.
ALTER TABLE odds_snapshots ADD COLUMN total_f5 REAL;
ALTER TABLE odds_snapshots ADD COLUMN total_f5_price_over REAL;
ALTER TABLE odds_snapshots ADD COLUMN total_f5_price_under REAL;
