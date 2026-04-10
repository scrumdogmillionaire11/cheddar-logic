-- Migration 063: Create POTD play history table
--
-- Stores the single published Play of the Day row for each date, plus the
-- settlement fields used by the worker mirror and web read surface.

CREATE TABLE IF NOT EXISTS potd_plays (
  id TEXT PRIMARY KEY,
  play_date TEXT NOT NULL UNIQUE,
  game_id TEXT NOT NULL,
  card_id TEXT NOT NULL UNIQUE,
  sport TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  market_type TEXT NOT NULL,
  selection TEXT NOT NULL,
  selection_label TEXT NOT NULL,
  line REAL,
  price INTEGER NOT NULL,
  confidence_label TEXT NOT NULL,
  total_score REAL NOT NULL,
  model_win_prob REAL NOT NULL,
  implied_prob REAL NOT NULL,
  edge_pct REAL NOT NULL,
  score_breakdown TEXT NOT NULL,
  wager_amount REAL NOT NULL,
  bankroll_at_post REAL NOT NULL,
  kelly_fraction REAL NOT NULL,
  game_time_utc TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  discord_posted INTEGER NOT NULL DEFAULT 0,
  discord_posted_at TEXT,
  result TEXT,
  settled_at TEXT,
  pnl_dollars REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_potd_plays_play_date
  ON potd_plays(play_date DESC);

CREATE INDEX IF NOT EXISTS idx_potd_plays_game_id
  ON potd_plays(game_id);

CREATE INDEX IF NOT EXISTS idx_potd_plays_sport
  ON potd_plays(sport);

CREATE INDEX IF NOT EXISTS idx_potd_plays_result
  ON potd_plays(result);
