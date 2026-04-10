CREATE TABLE IF NOT EXISTS projection_proxy_evals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Source card
  card_id           TEXT NOT NULL,
  game_id           TEXT NOT NULL,
  game_date         TEXT NOT NULL,            -- YYYY-MM-DD
  sport             TEXT NOT NULL,            -- 'baseball_mlb' | 'icehockey_nhl'
  card_family       TEXT NOT NULL,            -- 'MLB_F5_TOTAL' | 'NHL_1P_TOTAL'

  -- Projection and actual
  proj_value        REAL NOT NULL,            -- model's projected total
  actual_value      INTEGER NOT NULL,         -- settled actual (runs or goals)

  -- Proxy market fields
  proxy_line        REAL NOT NULL,            -- 3.5 | 4.5 | 1.5
  edge_vs_line      REAL NOT NULL,            -- proj_value - proxy_line (signed)
  recommended_side  TEXT NOT NULL,            -- 'OVER' | 'UNDER' | 'PASS'
  tier              TEXT NOT NULL,            -- 'PASS' | 'LEAN' | 'PLAY' | 'STRONG'
  confidence_bucket TEXT NOT NULL,            -- 'MICRO' | 'SMALL' | 'MEDIUM' | 'LARGE'

  -- Agreement fields (populated after all lines for a game are computed)
  agreement_group   TEXT NOT NULL DEFAULT '', -- 'CONSENSUS_OVER' | 'CONSENSUS_UNDER' | 'SPLIT' | 'PASS_ONLY'

  -- Graded result
  graded_result     TEXT NOT NULL,            -- 'WIN' | 'LOSS' | 'NO_BET'
  hit_flag          INTEGER NOT NULL,         -- 1 for WIN, 0 for LOSS/NO_BET

  -- Scoring
  tier_score        REAL NOT NULL DEFAULT 0,  -- signed float per tier weight rules
  consensus_bonus   REAL NOT NULL DEFAULT 0,  -- +/- 1.0 when both lines agree + same result

  created_at        TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(card_id, proxy_line)
);

CREATE INDEX IF NOT EXISTS idx_proxy_evals_game_date
  ON projection_proxy_evals (game_date, card_family);

CREATE INDEX IF NOT EXISTS idx_proxy_evals_card_id
  ON projection_proxy_evals (card_id);
