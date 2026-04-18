CREATE TABLE IF NOT EXISTS projection_accuracy_evals (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,

  card_id              TEXT NOT NULL UNIQUE,
  game_id              TEXT NOT NULL,
  sport                TEXT,
  card_type            TEXT NOT NULL,
  market_family        TEXT NOT NULL,

  player_id            TEXT,
  player_name          TEXT,
  team_abbr            TEXT,
  period               TEXT,

  projection_value     REAL NOT NULL,
  selected_line        REAL,
  nearest_half_line    REAL NOT NULL,
  selected_direction   TEXT,
  weak_direction_flag  INTEGER NOT NULL DEFAULT 0,

  confidence_score     REAL,
  confidence_band      TEXT NOT NULL DEFAULT 'UNKNOWN',
  market_trust         TEXT NOT NULL DEFAULT 'UNVERIFIED',
  market_trust_flags   TEXT,
  line_source          TEXT,
  basis                TEXT,

  captured_at          TEXT NOT NULL,
  generated_at         TEXT,

  actual_value         REAL,
  grade_status         TEXT NOT NULL DEFAULT 'PENDING',
  graded_result        TEXT,
  graded_at            TEXT,
  absolute_error       REAL,

  metadata             TEXT,
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projection_accuracy_line_evals (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  eval_id              INTEGER,
  card_id              TEXT NOT NULL,
  line_role            TEXT NOT NULL,
  eval_line            REAL NOT NULL,
  projection_value     REAL NOT NULL,
  direction            TEXT NOT NULL,
  weak_direction_flag  INTEGER NOT NULL DEFAULT 0,
  edge_vs_line         REAL NOT NULL,

  confidence_score     REAL,
  confidence_band      TEXT NOT NULL DEFAULT 'UNKNOWN',
  market_trust         TEXT NOT NULL DEFAULT 'UNVERIFIED',

  actual_value         REAL,
  grade_status         TEXT NOT NULL DEFAULT 'PENDING',
  graded_result        TEXT,
  hit_flag             INTEGER,
  graded_at            TEXT,

  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (eval_id) REFERENCES projection_accuracy_evals(id),
  UNIQUE(card_id, line_role)
);

CREATE INDEX IF NOT EXISTS idx_projection_accuracy_evals_card_type
  ON projection_accuracy_evals(card_type, captured_at);

CREATE INDEX IF NOT EXISTS idx_projection_accuracy_evals_market_family
  ON projection_accuracy_evals(market_family, captured_at);

CREATE INDEX IF NOT EXISTS idx_projection_accuracy_evals_game
  ON projection_accuracy_evals(game_id);

CREATE INDEX IF NOT EXISTS idx_projection_accuracy_line_evals_card
  ON projection_accuracy_line_evals(card_id);

CREATE INDEX IF NOT EXISTS idx_projection_accuracy_line_evals_summary
  ON projection_accuracy_line_evals(line_role, market_trust, confidence_band, grade_status);
