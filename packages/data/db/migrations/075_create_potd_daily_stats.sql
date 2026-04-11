CREATE TABLE IF NOT EXISTS potd_daily_stats (
  play_date             TEXT    PRIMARY KEY,
  potd_fired            INTEGER NOT NULL,
  candidate_count       INTEGER NOT NULL,
  viable_count          INTEGER NOT NULL,
  top_edge_pct          REAL,
  top_score             REAL,
  selected_edge_pct     REAL,
  selected_score        REAL,
  stake_pct_of_bankroll REAL,
  created_at            TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
