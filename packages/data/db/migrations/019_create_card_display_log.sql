CREATE TABLE IF NOT EXISTS card_display_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pick_id TEXT UNIQUE NOT NULL,
  run_id TEXT,
  game_id TEXT,
  sport TEXT,
  market_type TEXT,
  selection TEXT,
  line REAL,
  odds REAL,
  odds_book TEXT,
  confidence_pct REAL,
  displayed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  api_endpoint TEXT
);

CREATE INDEX IF NOT EXISTS idx_card_display_log_run_game
  ON card_display_log (run_id, game_id);

CREATE INDEX IF NOT EXISTS idx_card_display_log_game_sport
  ON card_display_log (game_id, sport);

CREATE INDEX IF NOT EXISTS idx_card_display_log_displayed_at
  ON card_display_log (displayed_at DESC);
