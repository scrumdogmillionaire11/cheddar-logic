-- Migration: Create clv_ledger table
-- Purpose: Closing Line Value (CLV) ledger — records the open price at card
-- creation time (odds_at_pick) and the closing market price at settlement
-- (closing_odds), then computes clv_pct = (devigged_close - devigged_open).
-- Positive values indicate the system consistently finds prices before the
-- market moves against them — the gold-standard predictor of sustainable edge.
--
-- Only ODDS_BACKED cards are eligible. PROJECTION_ONLY cards are excluded by
-- the CHECK constraint and by the recordClvEntry guard in db-telemetry.js.
--
-- The ensureClvLedgerSchema() inline fallback in db-telemetry.js mirrors this
-- DDL exactly so that both stay in sync.
--
-- Added: WI-0807

CREATE TABLE IF NOT EXISTS clv_ledger (
  id              TEXT PRIMARY KEY,
  card_id         TEXT NOT NULL,
  game_id         TEXT NOT NULL,
  sport           TEXT,
  market_type     TEXT,
  prop_type       TEXT,
  selection       TEXT,
  line            REAL,
  odds_at_pick    REAL,
  closing_odds    REAL,
  clv_pct         REAL,
  volatility_band TEXT,
  recorded_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at       TEXT,
  decision_basis  TEXT NOT NULL DEFAULT 'ODDS_BACKED',
  CONSTRAINT clv_ledger_no_projection
    CHECK (decision_basis = 'ODDS_BACKED')
);

CREATE INDEX IF NOT EXISTS idx_clv_ledger_card_id
  ON clv_ledger (card_id);
CREATE INDEX IF NOT EXISTS idx_clv_ledger_closed_at
  ON clv_ledger (closed_at);
CREATE INDEX IF NOT EXISTS idx_clv_ledger_sport_market
  ON clv_ledger (sport, market_type);
