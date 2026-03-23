-- Add bookmaker source tracking for best-line spread selection
ALTER TABLE odds_snapshots ADD COLUMN spread_home_book TEXT;
ALTER TABLE odds_snapshots ADD COLUMN spread_away_book TEXT;
