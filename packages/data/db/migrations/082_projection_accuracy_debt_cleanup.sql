ALTER TABLE projection_accuracy_line_evals RENAME TO projection_accuracy_line_evals_legacy_082;

CREATE TABLE projection_accuracy_line_evals (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  eval_id              INTEGER,
  card_id              TEXT NOT NULL,
  line_role            TEXT NOT NULL,
  line                 REAL,
  eval_line            REAL NOT NULL,
  projection_value     REAL NOT NULL,
  direction            TEXT NOT NULL,
  weak_direction_flag  INTEGER NOT NULL DEFAULT 0,
  edge_vs_line         REAL NOT NULL,

  confidence_score     REAL,
  confidence_band      TEXT NOT NULL DEFAULT 'UNKNOWN',
  market_trust         TEXT NOT NULL DEFAULT 'UNVERIFIED',
  expected_over_prob   REAL,
  expected_direction_prob REAL,

  actual_value         REAL,
  grade_status         TEXT NOT NULL DEFAULT 'PENDING',
  graded_result        TEXT,
  hit_flag             INTEGER,
  graded_at            TEXT,

  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (eval_id) REFERENCES projection_accuracy_evals(id),
  UNIQUE(card_id, eval_line)
);

INSERT OR IGNORE INTO projection_accuracy_line_evals (
  id, eval_id, card_id, line_role, line, eval_line, projection_value,
  direction, weak_direction_flag, edge_vs_line,
  confidence_score, confidence_band, market_trust,
  expected_over_prob, expected_direction_prob,
  actual_value, grade_status, graded_result, hit_flag, graded_at,
  created_at, updated_at
)
SELECT
  id,
  eval_id,
  card_id,
  CASE WHEN line_role = 'NEAREST_HALF' THEN 'SYNTHETIC' ELSE line_role END AS line_role,
  COALESCE(line, eval_line) AS line,
  eval_line,
  projection_value,
  direction,
  weak_direction_flag,
  edge_vs_line,
  confidence_score,
  confidence_band,
  market_trust,
  expected_over_prob,
  expected_direction_prob,
  actual_value,
  grade_status,
  graded_result,
  hit_flag,
  graded_at,
  created_at,
  updated_at
FROM projection_accuracy_line_evals_legacy_082
ORDER BY
  card_id,
  eval_line,
  CASE
    WHEN line_role IN ('SYNTHETIC', 'NEAREST_HALF') THEN 0
    WHEN line_role = 'SELECTED_MARKET' THEN 1
    ELSE 2
  END,
  id;

DROP TABLE projection_accuracy_line_evals_legacy_082;

CREATE INDEX IF NOT EXISTS idx_projection_accuracy_line_evals_card
  ON projection_accuracy_line_evals(card_id);

CREATE INDEX IF NOT EXISTS idx_projection_accuracy_line_evals_summary
  ON projection_accuracy_line_evals(line_role, market_trust, confidence_band, grade_status);

CREATE TABLE IF NOT EXISTS projection_accuracy_market_health (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  market_family            TEXT NOT NULL UNIQUE,
  line_role                TEXT NOT NULL DEFAULT 'SYNTHETIC',
  generated_at             TEXT NOT NULL,
  sample_size              INTEGER NOT NULL DEFAULT 0,
  wins                     INTEGER NOT NULL DEFAULT 0,
  losses                   INTEGER NOT NULL DEFAULT 0,
  pushes                   INTEGER NOT NULL DEFAULT 0,
  no_bets                  INTEGER NOT NULL DEFAULT 0,
  win_rate                 REAL,
  mae                      REAL,
  bias                     REAL,
  calibration_gap          REAL,
  avg_confidence           REAL,
  weak_direction_share     REAL,
  confidence_lift_json     TEXT,
  market_trust_status      TEXT NOT NULL DEFAULT 'INSUFFICIENT_DATA',
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_projection_accuracy_market_health_status
  ON projection_accuracy_market_health(market_trust_status, generated_at);
