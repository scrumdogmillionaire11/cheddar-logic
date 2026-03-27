ALTER TABLE odds_snapshots ADD COLUMN spread_consensus_line REAL;
ALTER TABLE odds_snapshots ADD COLUMN spread_consensus_confidence TEXT;
ALTER TABLE odds_snapshots ADD COLUMN spread_dispersion_stddev REAL;
ALTER TABLE odds_snapshots ADD COLUMN spread_source_book_count INTEGER;

ALTER TABLE odds_snapshots ADD COLUMN total_consensus_line REAL;
ALTER TABLE odds_snapshots ADD COLUMN total_consensus_confidence TEXT;
ALTER TABLE odds_snapshots ADD COLUMN total_dispersion_stddev REAL;
ALTER TABLE odds_snapshots ADD COLUMN total_source_book_count INTEGER;

ALTER TABLE odds_snapshots ADD COLUMN h2h_consensus_home REAL;
ALTER TABLE odds_snapshots ADD COLUMN h2h_consensus_away REAL;
ALTER TABLE odds_snapshots ADD COLUMN h2h_consensus_confidence TEXT;
