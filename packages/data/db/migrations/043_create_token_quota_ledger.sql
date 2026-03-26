-- Migration 043: Token quota ledger
--
-- Tracks API token usage per provider per calendar month.
-- Used by the tiered throttle system (Day 4) to gate odds fetches.
-- Persists the 401 circuit breaker (Day 3 upgrade from the in-memory flag added Day 1).
--
-- One row per (provider, period). Updated pessimistically before each fetch,
-- reconciled with the x-requests-remaining header after.

CREATE TABLE IF NOT EXISTS token_quota_ledger (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  provider             TEXT    NOT NULL,                        -- e.g. 'odds_api'
  period               TEXT    NOT NULL,                        -- YYYY-MM
  tokens_remaining     INTEGER NOT NULL DEFAULT 0,              -- last known balance from header
  tokens_spent_session INTEGER NOT NULL DEFAULT 0,              -- accumulated spend this process run
  monthly_limit        INTEGER NOT NULL DEFAULT 20000,          -- configured limit (ODDS_MONTHLY_LIMIT)
  circuit_open_until   TEXT    DEFAULT NULL,                    -- ISO datetime; if future, skip fetches
  circuit_reason       TEXT    DEFAULT NULL,                    -- e.g. '401', 'budget_critical'
  last_updated         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_by           TEXT    DEFAULT NULL,                    -- job run ID that last wrote this row
  UNIQUE (provider, period)
);

CREATE INDEX IF NOT EXISTS idx_token_quota_ledger_provider_period
  ON token_quota_ledger (provider, period);
