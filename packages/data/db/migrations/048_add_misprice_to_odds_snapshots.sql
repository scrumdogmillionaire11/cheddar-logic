-- Add spread/total misprice detection fields to odds_snapshots.
ALTER TABLE odds_snapshots ADD COLUMN spread_is_mispriced INTEGER;
ALTER TABLE odds_snapshots ADD COLUMN spread_misprice_type TEXT;
ALTER TABLE odds_snapshots ADD COLUMN spread_misprice_strength REAL;
ALTER TABLE odds_snapshots ADD COLUMN spread_outlier_book TEXT;
ALTER TABLE odds_snapshots ADD COLUMN spread_outlier_delta REAL;
ALTER TABLE odds_snapshots ADD COLUMN spread_review_flag INTEGER;

ALTER TABLE odds_snapshots ADD COLUMN total_is_mispriced INTEGER;
ALTER TABLE odds_snapshots ADD COLUMN total_misprice_type TEXT;
ALTER TABLE odds_snapshots ADD COLUMN total_misprice_strength REAL;
ALTER TABLE odds_snapshots ADD COLUMN total_outlier_book TEXT;
ALTER TABLE odds_snapshots ADD COLUMN total_outlier_delta REAL;
ALTER TABLE odds_snapshots ADD COLUMN total_review_flag INTEGER;
