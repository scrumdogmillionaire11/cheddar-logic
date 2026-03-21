-- decision_records.edge was declared NOT NULL, but EDGE_UNAVAILABLE
-- records legitimately have no edge (e.g. spread cards without projection data).
-- SQLite requires a full table recreate to drop a NOT NULL constraint.
PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE decision_records_new (
  decision_key TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  game_id TEXT NOT NULL,
  market TEXT NOT NULL,
  period TEXT NOT NULL,
  side_family TEXT NOT NULL,

  recommended_side TEXT NOT NULL,
  recommended_line REAL,
  recommended_price INTEGER,
  book TEXT,

  edge REAL,
  confidence REAL,

  locked_status TEXT NOT NULL DEFAULT 'SOFT',
  locked_at TEXT,
  last_seen_at TEXT NOT NULL,

  result_version TEXT,
  inputs_hash TEXT,
  odds_snapshot_id TEXT,

  flip_count INTEGER NOT NULL DEFAULT 0,
  last_flip_at TEXT,
  last_reason_code TEXT,
  last_reason_detail TEXT,

  last_candidate_hash TEXT,
  candidate_seen_count INTEGER NOT NULL DEFAULT 0
);

INSERT INTO decision_records_new SELECT * FROM decision_records;

DROP TABLE decision_records;

ALTER TABLE decision_records_new RENAME TO decision_records;

CREATE INDEX IF NOT EXISTS idx_decisions_game ON decision_records (sport, game_id);
CREATE INDEX IF NOT EXISTS idx_decisions_market ON decision_records (sport, market, period);

COMMIT;

PRAGMA foreign_keys = ON;
