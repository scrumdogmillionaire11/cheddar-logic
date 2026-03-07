-- Seed test games and odds for development
-- Usage: sqlite3 ~/.cheddar/prod-snapshot.db < seed.sql

-- Insert test NBA games
INSERT OR IGNORE INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at)
VALUES
  ('g1', 'NBA', 'nba-lal-bos-20260306', 'LAL', 'BOS', '2026-03-07T01:30:00Z', 'scheduled', '2026-03-06T18:00:00Z'),
  ('g2', 'NBA', 'nba-gsw-lac-20260306', 'GSW', 'LAC', '2026-03-07T03:00:00Z', 'scheduled', '2026-03-06T18:00:00Z');

-- Insert test NHL games
INSERT OR IGNORE INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at)
VALUES
  ('g3', 'NHL', 'nhl-nyr-njd-20260306', 'NJD', 'NYR', '2026-03-07T04:00:00Z', 'scheduled', '2026-03-06T18:00:00Z'),
  ('g4', 'NHL', 'nhl-det-tor-20260307', 'TOR', 'DET', '2026-03-08T00:00:00Z', 'scheduled', '2026-03-06T18:00:00Z');

-- Insert odds snapshots for NBA games
INSERT OR IGNORE INTO odds_snapshots 
  (id, game_id, sport, h2h_home, h2h_away, spread_home, spread_away, spread_price_home, spread_price_away,
   total, total_price_over, total_price_under, home_team, away_team, captured_at, book)
VALUES
  ('o1', 'nba-lal-bos-20260306', 'NBA', -110, -110, -3.5, 3.5, -110, -110, 215.5, -110, -110, 'LAL', 'BOS', '2026-03-06T18:00:00Z', 'draftkings'),
  ('o2', 'nba-gsw-lac-20260306', 'NBA', 110, -130, 4.0, -4.0, -110, -110, 218.0, -110, -110, 'GSW', 'LAC', '2026-03-06T18:00:00Z', 'draftkings');

-- Insert odds snapshots for NHL games
INSERT OR IGNORE INTO odds_snapshots 
  (id, game_id, sport, h2h_home, h2h_away, spread_home, spread_away, spread_price_home, spread_price_away,
   total, total_price_over, total_price_under, home_team, away_team, captured_at, book)
VALUES
  ('o3', 'nhl-nyr-njd-20260306', 'NHL', -110, -110, -1.5, 1.5, -110, -110, 5.5, -110, -110, 'NJD', 'NYR', '2026-03-06T18:00:00Z', 'draftkings'),
  ('o4', 'nhl-det-tor-20260307', 'NHL', 120, -140, 1.0, -1.0, -110, -110, 6.0, -110, -110, 'TOR', 'DET', '2026-03-06T18:00:00Z', 'draftkings');

-- Verify results
SELECT 'Games inserted:' as check_label, COUNT(*) as count FROM games;
SELECT 'Odds inserted:' as check_label, COUNT(*) as count FROM odds_snapshots;
