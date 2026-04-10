CREATE TABLE IF NOT EXISTS calibration_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  market TEXT NOT NULL,
  side TEXT NOT NULL,
  fair_prob REAL NOT NULL,
  implied_prob REAL,
  outcome INTEGER,
  model_status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cal_pred_market
ON calibration_predictions(market, outcome);
