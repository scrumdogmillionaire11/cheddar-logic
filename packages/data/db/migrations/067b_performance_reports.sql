-- Migration 067: Performance reports + CLV entries tables
-- Purpose: Support daily performance reporting (firing vs winning metrics) and
-- per-entry CLV tracking that supplements the aggregate clv_ledger.
--
-- daily_performance_reports: one row per (report_date, market, sport).
-- Computed nightly by run_daily_performance_report.js.
--
-- clv_entries: one row per "bet" (card + closing line pair).
-- Written by run_clv_snapshot.js after game end when closing_odds land on
-- clv_ledger rows.  Distinct from clv_ledger which is the pick-side owner.
--
-- Added: WI-0826

CREATE TABLE IF NOT EXISTS daily_performance_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL,    -- YYYY-MM-DD
  market TEXT NOT NULL,
  sport TEXT NOT NULL,
  eligible_games INTEGER DEFAULT 0,
  model_ok_count INTEGER DEFAULT 0,
  degraded_count INTEGER DEFAULT 0,
  no_bet_count INTEGER DEFAULT 0,
  bets_placed INTEGER DEFAULT 0,
  bets_blocked_gate INTEGER DEFAULT 0,
  hit_rate REAL,
  roi REAL,
  avg_edge_at_placement REAL,
  avg_clv REAL,                 -- avg(closing_implied_prob - implied_prob_at_placement)
  brier REAL,
  ece REAL,
  max_drawdown REAL,
  computed_at TEXT NOT NULL,
  UNIQUE(report_date, market, sport)
);

CREATE INDEX IF NOT EXISTS idx_dpr_date_market
  ON daily_performance_reports(report_date, market);

CREATE TABLE IF NOT EXISTS clv_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  market TEXT NOT NULL,
  side TEXT NOT NULL,
  edge_at_placement REAL,
  fair_prob_at_placement REAL,
  implied_prob_at_placement REAL,
  closing_price REAL,
  closing_implied_prob REAL,
  clv REAL,                     -- closing_implied_prob - implied_prob_at_placement
  clv_positive INTEGER,         -- 1 if CLV > 0, 0 otherwise
  outcome INTEGER,              -- 1 win, 0 loss, NULL pending
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clv_entries_market
  ON clv_entries(market, created_at);
CREATE INDEX IF NOT EXISTS idx_clv_entries_game
  ON clv_entries(game_id, market);
