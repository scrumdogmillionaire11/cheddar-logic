CREATE TABLE IF NOT EXISTS potd_shadow_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  play_date TEXT NOT NULL,
  candidate_identity_key TEXT NOT NULL,
  shadow_candidate_id INTEGER,
  game_id TEXT,
  sport TEXT,
  market_type TEXT,
  selection TEXT,
  selection_label TEXT,
  line REAL,
  price INTEGER,
  game_time_utc TEXT,
  status TEXT NOT NULL,
  result TEXT,
  virtual_stake_units REAL NOT NULL DEFAULT 1.0,
  pnl_units REAL,
  settled_at TEXT,
  grading_metadata TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(play_date, candidate_identity_key),
  FOREIGN KEY (shadow_candidate_id) REFERENCES potd_shadow_candidates(id)
);

CREATE INDEX IF NOT EXISTS idx_potd_shadow_results_status
  ON potd_shadow_results(status);

CREATE INDEX IF NOT EXISTS idx_potd_shadow_results_game
  ON potd_shadow_results(game_id);
