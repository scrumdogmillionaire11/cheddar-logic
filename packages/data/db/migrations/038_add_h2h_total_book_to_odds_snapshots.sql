-- Add bookmaker source tracking for h2h (moneyline) and totals markets
ALTER TABLE odds_snapshots ADD COLUMN h2h_book TEXT;
ALTER TABLE odds_snapshots ADD COLUMN total_book TEXT;
