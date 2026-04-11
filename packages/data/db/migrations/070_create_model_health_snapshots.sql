CREATE TABLE IF NOT EXISTS model_health_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sport TEXT NOT NULL,
  run_at TEXT NOT NULL,
  hit_rate REAL,
  roi_units REAL,
  roi_pct REAL,
  total_unique INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  streak TEXT,
  last10_hit_rate REAL,
  status TEXT NOT NULL,
  signals_json TEXT,
  lookback_days INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (sport, run_at, lookback_days)
);

CREATE INDEX IF NOT EXISTS idx_model_health_snapshots_lookup
  ON model_health_snapshots(lookback_days, sport, run_at DESC);
