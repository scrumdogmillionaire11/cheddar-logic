-- Migration 081: Repair projection_accuracy_line_evals unique constraint
--
-- The table was originally created with UNIQUE(card_id, eval_line) (legacy schema).
-- The write path uses ON CONFLICT(card_id, line_role), which silently fails when
-- the unique constraint doesn't match that target.
--
-- SQLite requires a full table rebuild to change a constraint defined inline in the
-- CREATE TABLE statement.  We:
--   1. Create a shadow table with the correct UNIQUE(card_id, line_role) constraint.
--   2. Copy all rows from the existing table.
--   3. Drop the old table.
--   4. Rename the shadow table.
--   5. Recreate the non-unique indexes.
--
-- This migration is idempotent: if the table already has UNIQUE(card_id, line_role)
-- (e.g. newly bootstrapped DBs) the migration simply rebuilds the table with the same
-- schema, which is a no-op from a data perspective.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS projection_accuracy_line_evals_new (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  eval_id                 INTEGER,
  card_id                 TEXT NOT NULL,
  line_role               TEXT NOT NULL,
  line                    REAL,
  eval_line               REAL NOT NULL,
  projection_value        REAL NOT NULL,
  direction               TEXT NOT NULL,
  weak_direction_flag     INTEGER NOT NULL DEFAULT 0,
  edge_vs_line            REAL NOT NULL,

  confidence_score        REAL,
  confidence_band         TEXT NOT NULL DEFAULT 'UNKNOWN',
  market_trust            TEXT NOT NULL DEFAULT 'UNVERIFIED',
  expected_over_prob      REAL,
  expected_direction_prob REAL,

  actual_value            REAL,
  grade_status            TEXT NOT NULL DEFAULT 'PENDING',
  graded_result           TEXT,
  hit_flag                INTEGER,
  graded_at               TEXT,

  created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (eval_id) REFERENCES projection_accuracy_evals(id),
  UNIQUE(card_id, line_role)
);

INSERT INTO projection_accuracy_line_evals_new (
  id, eval_id, card_id, line_role, eval_line, projection_value,
  direction, weak_direction_flag, edge_vs_line,
  confidence_score, confidence_band, market_trust,
  actual_value, grade_status, graded_result, hit_flag, graded_at,
  created_at, updated_at
)
SELECT
  id, eval_id, card_id, line_role, eval_line, projection_value,
  direction, weak_direction_flag, edge_vs_line,
  confidence_score, confidence_band, market_trust,
  actual_value, grade_status, graded_result, hit_flag, graded_at,
  created_at, updated_at
FROM projection_accuracy_line_evals;

DROP TABLE projection_accuracy_line_evals;

ALTER TABLE projection_accuracy_line_evals_new
  RENAME TO projection_accuracy_line_evals;

CREATE INDEX IF NOT EXISTS idx_projection_accuracy_line_evals_card
  ON projection_accuracy_line_evals(card_id);

CREATE INDEX IF NOT EXISTS idx_projection_accuracy_line_evals_summary
  ON projection_accuracy_line_evals(line_role, market_trust, confidence_band, grade_status);

PRAGMA foreign_keys = ON;
