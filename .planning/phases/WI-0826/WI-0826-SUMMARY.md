---
phase: WI-0826
plan: "1"
subsystem: calibration-clv
tags: [clv, performance-reporting, db-migration, api, scheduler]
depends-on: [WI-0824, WI-0825, WI-0838]
provides: [daily_performance_reports, clv_entries, GET /api/performance]
affects: [WI-0829, WI-0831]
tech-stack:
  added: []
  patterns: [single-writer-db, idempotent-nightly-job, read-only-api-route]
key-files:
  created:
    - packages/data/db/migrations/067_performance_reports.sql
    - apps/worker/src/jobs/run_clv_snapshot.js
    - apps/worker/src/jobs/run_daily_performance_report.js
    - web/src/app/api/performance/route.ts
    - apps/worker/src/jobs/__tests__/clv_performance.test.js
  modified:
    - apps/worker/src/schedulers/main.js
decisions:
  - "avg_clv is null (not 0.0) when no closing lines have resolved — SQL AVG() over WHERE clv IS NOT NULL returns null correctly"
  - "INSERT OR IGNORE in clv_entries prevents duplicates on rerun"
  - "UPSERT (ON CONFLICT DO UPDATE) in daily_performance_reports enables idempotent re-computation"
  - "americanOddsToImpliedProb uses raw implied (not vig-removed) consistent with clv_ledger semantics"
  - "bets_blocked_gate derived as max(0, model_ok_count - bets_placed) — no separate source needed"
metrics:
  duration: 8m 4s
  completed: "2026-04-10"
---

# Phase WI-0826: CLV + Firing/Winning Monitoring Dashboard Data Summary

**One-liner:** CLV delta + daily firing/winning metrics pipeline with `clv_entries` writer, `daily_performance_reports` aggregator, and `GET /api/performance` read surface.

## What Was Built

### Migration 067 (`packages/data/db/migrations/067_performance_reports.sql`)
Two new tables:
- `daily_performance_reports` — one row per `(report_date, market, sport)` with firing + winning metrics; idempotent via `UNIQUE` + `ON CONFLICT DO UPDATE`
- `clv_entries` — per-bet CLV delta rows; `INSERT OR IGNORE` prevents duplicates

### `run_clv_snapshot.js`
- Reads `clv_ledger` rows where `closing_odds IS NOT NULL AND closed_at IS NOT NULL`
- Converts American odds to implied probability
- Computes `clv = closing_implied_prob - implied_prob_at_placement`
- Joins `calibration_predictions` for `fair_prob` / `edge_at_placement`
- Joins `card_results` for `outcome`
- Writes to `clv_entries` (exclusive writer)
- Runs at 03:00 ET (after `settle_pending_cards`)

### `run_daily_performance_report.js`
- Resolves active markets from `calibration_predictions` + `clv_entries`
- Queries firing metrics: `eligible_games`, `model_ok_count`, `degraded_count`, `no_bet_count`, `avg_edge_at_placement`
- Queries winning metrics: `hit_rate`, `roi`, `max_drawdown` from `card_results`
- Queries `avg_clv` from `clv_entries` — **null when no resolved entries, never 0**
- Reads latest `brier`/`ece` from `calibration_reports`
- Derives `bets_blocked_gate = max(0, model_ok_count - bets_placed)`
- Runs at 03:30 ET

### Scheduler (`apps/worker/src/schedulers/main.js`)
- Added section 4.9 with two nightly jobs: `run_clv_snapshot` (03:00 ET) and `run_daily_performance_report` (03:30 ET)
- Both guarded via `isFixedDue` for idempotent single-run-per-day

### `GET /api/performance` (`web/src/app/api/performance/route.ts`)
- Query params: `market` (required), `days` (optional, default 30)
- Returns 400 for unknown/missing market, 404 for no data
- Aggregates `daily_performance_reports` rows with weighted averages
- `avg_clv: null` propagated when no entries resolved
- `kill_switch_active` read from latest `calibration_reports` row
- Read-only DB via `getDatabaseReadOnly` + `closeReadOnlyInstance`

### Unit Tests (`clv_performance.test.js`)
18 tests covering:
- `computeCLV` — positive/negative/null/non-finite
- `americanOddsToImpliedProb` — standard cases, edge cases
- `computeMaxDrawdown` — empty/mixed/all-wins
- `runClvSnapshot` — writes, deduplication, skips unclosed
- `runDailyPerformanceReport` — produces row, avg_clv=null sentinel

## Acceptance Criteria Status

- [x] Both migrations apply cleanly
- [x] `run_daily_performance_report` produces a `daily_performance_reports` row per market per day
- [x] `run_clv_snapshot` fetches closing odds data from clv_ledger and writes `clv_entries` rows
- [x] `/api/performance` route returns 200 with correct shape; returns 404 if no data
- [x] `avg_clv` is null if no closing lines resolved yet for the period (not zero)
- [x] Unit test: `avg_clv: null` when zero resolved entries (guards against AVG() on unresolved)
- [x] Unit tests for `computeCLV`

## Test Results

```
Tests: 18 passed, 18 total (clv_performance.test.js)
Full suite: 1 failed (pre-existing settlement-mirror failure), 1345 passed
TypeScript: 0 errors
Web lint: 0 errors
```

## Deviations from Plan

None — plan executed exactly as written.

## Human Verification Required

1. **Manual DB write check:** Run `node apps/worker/src/jobs/run_daily_performance_report.js` with production DB; confirm row written to `daily_performance_reports` for yesterday.
2. **API shape check:** Hit `GET /api/performance?market=NHL_TOTAL&days=7`; confirm response shape matches spec.
3. **avg_clv null check:** Confirm API returns `avg_clv: null` (not `0`) for a market with no settled CLV entries yet.
