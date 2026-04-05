-- Migration: Create projection_audit table
-- Purpose: Row-level audit trail for every settled projection, capturing all
-- segmentation dimensions at settle time. Replaces lossy aggregate-only model
-- of tracking_stats as the source of truth for retroactive slicing.
-- Added: WI-0787

CREATE TABLE IF NOT EXISTS projection_audit (
  id                  TEXT PRIMARY KEY,        -- card_result_id
  card_result_id      TEXT NOT NULL UNIQUE,    -- FK reference to card_results.id
  sport               TEXT NOT NULL,
  market_type         TEXT NOT NULL,           -- 'total', 'moneyline', 'spread', etc.
  period              TEXT,                    -- NULL, '1P', '2P', etc.
  player_count        INTEGER,                 -- number of players in card (NULL if unavailable)
  confidence_score    REAL,                    -- raw model confidence (0-1)
  confidence_band     TEXT,                    -- '<40', '40-50', '50-60', '60+', 'unknown'
  odds_american       INTEGER,                 -- locked price at projection time
  sharp_price_status  TEXT,                    -- 'CONFIRMED', 'ESTIMATED', 'UNTAGGED'
  direction           TEXT,                    -- 'OVER', 'UNDER', 'HOME', 'AWAY', etc.
  result              TEXT NOT NULL,           -- 'win', 'loss', 'push'
  pnl_units           REAL NOT NULL DEFAULT 0,
  settled_at          TEXT NOT NULL,           -- ISO8601
  job_run_id          TEXT,
  metadata            TEXT,                    -- JSON blob for any extra context
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_projection_audit_sport_market
  ON projection_audit (sport, market_type);
CREATE INDEX IF NOT EXISTS idx_projection_audit_settled_at
  ON projection_audit (settled_at);
CREATE INDEX IF NOT EXISTS idx_projection_audit_player_count
  ON projection_audit (player_count);
CREATE INDEX IF NOT EXISTS idx_projection_audit_sharp_price_status
  ON projection_audit (sharp_price_status);
