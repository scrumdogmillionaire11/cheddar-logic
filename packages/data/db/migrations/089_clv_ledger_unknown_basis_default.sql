-- Migration: Allow UNKNOWN basis in CLV ledger and make default fail-closed.
-- Purpose: Prevent silent ODDS_BACKED attribution when decision basis is missing.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS clv_ledger_new (
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
  decision_basis  TEXT NOT NULL DEFAULT 'UNKNOWN',
  CONSTRAINT clv_ledger_basis_known
    CHECK (decision_basis IN ('ODDS_BACKED', 'UNKNOWN'))
);

INSERT INTO clv_ledger_new (
  id,
  card_id,
  game_id,
  sport,
  market_type,
  prop_type,
  selection,
  line,
  odds_at_pick,
  closing_odds,
  clv_pct,
  volatility_band,
  recorded_at,
  closed_at,
  decision_basis
)
SELECT
  id,
  card_id,
  game_id,
  sport,
  market_type,
  prop_type,
  selection,
  line,
  odds_at_pick,
  closing_odds,
  clv_pct,
  volatility_band,
  recorded_at,
  closed_at,
  CASE
    WHEN UPPER(COALESCE(decision_basis, '')) = 'ODDS_BACKED' THEN 'ODDS_BACKED'
    ELSE 'UNKNOWN'
  END
FROM clv_ledger;

DROP TABLE clv_ledger;
ALTER TABLE clv_ledger_new RENAME TO clv_ledger;

CREATE INDEX IF NOT EXISTS idx_clv_ledger_card_id
  ON clv_ledger (card_id);
CREATE INDEX IF NOT EXISTS idx_clv_ledger_closed_at
  ON clv_ledger (closed_at);
CREATE INDEX IF NOT EXISTS idx_clv_ledger_sport_market
  ON clv_ledger (sport, market_type);

PRAGMA foreign_keys = ON;