-- Add F5 Moneyline columns to odds_snapshots
-- Stores the first-5-innings h2h (moneyline) prices per side.
-- American odds format (e.g. -120, +105).
-- NULL when not available from the odds provider.
ALTER TABLE odds_snapshots ADD COLUMN ml_f5_home REAL;
ALTER TABLE odds_snapshots ADD COLUMN ml_f5_away REAL;
