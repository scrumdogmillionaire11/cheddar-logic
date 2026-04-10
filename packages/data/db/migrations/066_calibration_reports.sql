CREATE TABLE IF NOT EXISTS calibration_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_days INTEGER NOT NULL DEFAULT 30,
  brier REAL,
  ece REAL,
  n_samples INTEGER,
  kill_switch_active INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL
);
