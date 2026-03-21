-- decision_events.cand_edge was declared NOT NULL, but EDGE_UNAVAILABLE
-- events legitimately have no edge. SQLite requires a full table recreate
-- to drop a NOT NULL constraint.
PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE decision_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  decision_key TEXT NOT NULL,

  action TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_detail TEXT,

  prev_side TEXT,
  prev_line REAL,
  prev_price INTEGER,
  prev_edge REAL,

  cand_side TEXT NOT NULL,
  cand_line REAL,
  cand_price INTEGER,
  cand_edge REAL,

  edge_delta REAL,
  line_delta REAL,
  price_delta INTEGER,

  inputs_hash TEXT,
  result_version TEXT
);

INSERT INTO decision_events_new SELECT * FROM decision_events;

DROP TABLE decision_events;

ALTER TABLE decision_events_new RENAME TO decision_events;

CREATE INDEX IF NOT EXISTS idx_decision_events_key_ts ON decision_events (decision_key, ts);

COMMIT;

PRAGMA foreign_keys = ON;
