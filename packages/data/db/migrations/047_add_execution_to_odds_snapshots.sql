-- Add side-specific execution source fields to odds_snapshots.
-- Existing price/line values remain in their legacy columns; this migration
-- adds the book/line detail needed when best line and best price diverge.
ALTER TABLE odds_snapshots ADD COLUMN spread_price_home_book TEXT;
ALTER TABLE odds_snapshots ADD COLUMN spread_price_away_book TEXT;

ALTER TABLE odds_snapshots ADD COLUMN h2h_home_book TEXT;
ALTER TABLE odds_snapshots ADD COLUMN h2h_away_book TEXT;

ALTER TABLE odds_snapshots ADD COLUMN total_line_over REAL;
ALTER TABLE odds_snapshots ADD COLUMN total_line_over_book TEXT;
ALTER TABLE odds_snapshots ADD COLUMN total_line_under REAL;
ALTER TABLE odds_snapshots ADD COLUMN total_line_under_book TEXT;
ALTER TABLE odds_snapshots ADD COLUMN total_price_over_book TEXT;
ALTER TABLE odds_snapshots ADD COLUMN total_price_under_book TEXT;
