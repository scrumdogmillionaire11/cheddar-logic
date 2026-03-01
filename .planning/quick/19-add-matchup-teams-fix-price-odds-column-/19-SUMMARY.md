---
phase: quick-19
plan: "01"
subsystem: web-ui
tags: [results, ledger, odds, matchup, ui]
dependency_graph:
  requires: [quick-18]
  provides: [matchup-display, real-price-display, confidence-display]
  affects: [web/src/app/results/page.tsx, web/src/app/api/results/route.ts]
tech_stack:
  added: []
  patterns: [safeJsonParse, odds_context extraction, payload field fallback]
key_files:
  modified:
    - web/src/app/api/results/route.ts
    - web/src/app/results/page.tsx
decisions:
  - "Extract price from odds_context keyed on prediction value (HOME/AWAY/OVER/UNDER/SPREAD_*)"
  - "Confidence uses confidence_pct first, falls back to confidence * 100"
  - "Play Ledger expanded from 7 to 8 columns — added Matchup, renamed Edge to Confidence"
metrics:
  duration: "5 minutes"
  completed: "2026-03-01"
  tasks_completed: 2
  files_modified: 2
---

# Phase quick-19 Plan 01: Add Matchup Teams and Fix Price/Confidence Columns Summary

Enriched the /results Play Ledger with real Matchup (Away @ Home), Price (from odds_context keyed on prediction), and Confidence (pct from payload_data) instead of hardcoded '--' stubs.

## What Was Built

### Task 1: Extract matchup, price, and confidence from payload_data in API route

- Added `homeTeam` and `awayTeam` from `payload.home_team` / `payload.away_team`
- Added `price` extracted from `payload.odds_context` using prediction-keyed logic:
  - HOME -> `odds_context.h2h_home`
  - AWAY -> `odds_context.h2h_away`
  - OVER/UNDER -> `odds_context.total`
  - SPREAD_HOME* -> `odds_context.spread_home`
  - SPREAD_AWAY* -> `odds_context.spread_away`
- Added `confidencePct` with fallback: `confidence_pct` first, then `confidence * 100`; rounded to 1 decimal

**Commit:** `1494f53`
**Files:** `web/src/app/api/results/route.ts`

### Task 2: Update LedgerRow type and Play Ledger table

- Extended `LedgerRow` type with `homeTeam`, `awayTeam`, `price`, `confidencePct`
- Changed Play Ledger from `grid-cols-7` to `grid-cols-8`
- Added Matchup column rendering `${awayTeam} @ ${homeTeam}` (or '--' if missing)
- Renamed "Edge" column header to "Confidence"
- Wired `price` and `confidencePct` cells with real values (fallback '--' if null)

**Commit:** `a6fefb8`
**Files:** `web/src/app/results/page.tsx`

## Verification

- TypeScript compiles with zero errors (`tsc --noEmit -p web/tsconfig.json` exit code 0)
- API returns `homeTeam`, `awayTeam`, `price`, `confidencePct` keys on every ledger row
- Play Ledger shows 8 columns: Date | Sport | Matchup | Market | Pick | Price | Confidence | Result
- Rows with complete payload show real matchup and values; rows with absent fields show '--'
- No changes to Segments table, summary cards, or Data Integrity section

## Deviations from Plan

None - plan executed exactly as written.

## Self-Check: PASSED

- `web/src/app/api/results/route.ts` — FOUND
- `web/src/app/results/page.tsx` — FOUND
- Commit `1494f53` — FOUND
- Commit `a6fefb8` — FOUND
