CREATE TABLE IF NOT EXISTS player_prop_lines (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  game_id TEXT NOT NULL,
  odds_event_id TEXT,
  player_name TEXT NOT NULL,
  prop_type TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT 'full_game',
  line REAL NOT NULL,
  over_price INTEGER,
  under_price INTEGER,
  bookmaker TEXT,
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_prop_lines_unique
  ON player_prop_lines (sport, game_id, player_name, prop_type, period, bookmaker);

CREATE INDEX IF NOT EXISTS idx_player_prop_lines_game
  ON player_prop_lines (sport, game_id, prop_type);
