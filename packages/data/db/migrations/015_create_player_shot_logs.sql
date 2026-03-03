CREATE TABLE IF NOT EXISTS player_shot_logs (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  player_id INTEGER NOT NULL,
  player_name TEXT,
  game_id TEXT NOT NULL,
  game_date TEXT,
  opponent TEXT,
  is_home INTEGER,
  shots INTEGER,
  toi_minutes REAL,
  raw_data TEXT,
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_shot_logs_unique
  ON player_shot_logs (sport, player_id, game_id);

CREATE INDEX IF NOT EXISTS idx_player_shot_logs_player_date
  ON player_shot_logs (player_id, game_date DESC);
