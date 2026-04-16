CREATE TABLE IF NOT EXISTS potd_shadow_candidates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  play_date   TEXT    NOT NULL,
  captured_at TEXT    NOT NULL,
  sport       TEXT    NOT NULL,
  market_type TEXT    NOT NULL,
  selection_label TEXT NOT NULL,
  home_team   TEXT,
  away_team   TEXT,
  game_id     TEXT,
  price       REAL,
  line        REAL,
  edge_pct    REAL,
  total_score REAL,
  line_value  REAL,
  market_consensus REAL,
  model_win_prob   REAL,
  implied_prob     REAL,
  projection_source TEXT,
  gap_to_min_edge  REAL  -- edge_pct - POTD_MIN_EDGE (negative means below threshold)
);

CREATE INDEX IF NOT EXISTS idx_potd_shadow_play_date ON potd_shadow_candidates(play_date);
CREATE INDEX IF NOT EXISTS idx_potd_shadow_edge ON potd_shadow_candidates(edge_pct);
