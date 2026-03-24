CREATE TABLE IF NOT EXISTS mlb_pitcher_stats (
  id            TEXT PRIMARY KEY,
  mlb_id        INTEGER NOT NULL UNIQUE,
  full_name     TEXT,
  team          TEXT,
  season        INTEGER,
  era           REAL,
  whip          REAL,
  k_per_9       REAL,
  innings_pitched REAL,
  recent_k_per_9  REAL,
  recent_ip       REAL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mlb_pitcher_stats_mlb_id
  ON mlb_pitcher_stats (mlb_id);
