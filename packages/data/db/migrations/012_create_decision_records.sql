CREATE TABLE IF NOT EXISTS decision_records (
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

  edge REAL NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_decisions_game ON decision_records (sport, game_id);
CREATE INDEX IF NOT EXISTS idx_decisions_market ON decision_records (sport, market, period);

CREATE TABLE IF NOT EXISTS decision_events (
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
  cand_edge REAL NOT NULL,

  edge_delta REAL,
  line_delta REAL,
  price_delta INTEGER,

  inputs_hash TEXT,
  result_version TEXT
);

CREATE INDEX IF NOT EXISTS idx_decision_events_key_ts ON decision_events (decision_key, ts);
