---
phase: quick-21
plan: 01
subsystem: settlement, results-ui
tags: [settlement, results, market-filter, recommendation-type]
dependency_graph:
  requires: [quick-11, quick-20]
  provides: [correct-settlement, market-level-segments]
  affects: [apps/worker/src/jobs/settle_pending_cards.js, web/src/app/api/results/route.ts, web/src/app/results/page.tsx]
tech_stack:
  added: []
  patterns: [extractActualPlay helper, pickBetOdds helper, market filter SQL fragment pattern]
key_files:
  modified:
    - apps/worker/src/jobs/settle_pending_cards.js
    - web/src/app/api/results/route.ts
    - web/src/app/results/page.tsx
decisions:
  - "extractActualPlay() reads recommendation.type as authoritative BET direction; raw prediction is legacy fallback only"
  - "PASS recommendation returns null from extractActualPlay — card is skipped without error"
  - "Spread odds default to -110 juice when spread_home_odds/spread_away_odds not stored in odds_context"
  - "Segments GROUP BY sport + card_category + recommended_bet_type (3-key) — finer granularity than prior 2-key grouping"
  - "market filter applied to both inner and outer sides of dedup subquery to keep dedup set consistent"
metrics:
  duration: "~15 minutes"
  completed: "2026-03-02"
  tasks: 2
  files: 3
---

# Phase quick-21 Plan 01: Fix Results Settlement to Use Actual Play Summary

**One-liner:** Settlement now grades plays using `recommendation.type` (ML_HOME/ML_AWAY/SPREAD_HOME/SPREAD_AWAY/TOTAL_OVER/TOTAL_UNDER) as the authoritative BET direction instead of the raw model prediction field, with market-level segment tracking and a market filter dropdown on /results.

---

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fix settle_pending_cards to use recommendation.type | 0188e97 | apps/worker/src/jobs/settle_pending_cards.js |
| 2 | Add market filter + market column to /results API and page | 0d76679 | web/src/app/api/results/route.ts, web/src/app/results/page.tsx |

---

## What Was Built

### Task 1 — Settlement correctness fix

`apps/worker/src/jobs/settle_pending_cards.js`

Added `extractActualPlay(payloadData)` helper that maps `recommendation.type` values to `{ direction, market }`:

- `ML_HOME` → `{ direction: 'HOME', market: 'moneyline' }`
- `ML_AWAY` → `{ direction: 'AWAY', market: 'moneyline' }`
- `SPREAD_HOME` → `{ direction: 'HOME', market: 'spread' }`
- `SPREAD_AWAY` → `{ direction: 'AWAY', market: 'spread' }`
- `TOTAL_OVER` → `{ direction: 'OVER', market: 'total' }`
- `TOTAL_UNDER` → `{ direction: 'UNDER', market: 'total' }`
- `PASS` or missing → returns `null` (card skipped)
- No `recommendation.type` → legacy fallback to raw `prediction` field + `recommended_bet_type`

Replaced `pickMoneylineOdds(payloadData, prediction)` with `pickBetOdds(payloadData, direction, market)` which handles spread odds (defaulting to -110 standard juice when `spread_home_odds`/`spread_away_odds` are absent) and moneyline odds from `h2h_home`/`h2h_away`.

All `prediction` references in the settlement loop replaced with `direction` from `extractActualPlay`. Log line format: `Settled card {id}: {direction} ({market}) -> {result} (pnl: {n})`.

### Task 2 — Market filter + market column

`web/src/app/api/results/route.ts`

- Added `ALLOWED_MARKETS = ['moneyline', 'spread', 'total']` constant
- Parses and sanitizes `market` query param
- `marketFilter3`/`marketParams3` applied inside inner dedup subquery (on `cr3`)
- `marketFilter2`/`marketParams2` applied on outer dedup query (on `cr2`)
- Segments query now `GROUP BY cr.sport, card_category, cr.recommended_bet_type` (was 2-key, now 3-key)
- `SegmentRow` type includes `recommended_bet_type`
- Response maps `recommendedBetType: row.recommended_bet_type || 'unknown'`
- `filters` response object includes `market` field in both early-return and normal paths

`web/src/app/results/page.tsx`

- `SegmentRow` type adds `recommendedBetType: string`
- `ResultsResponse` filters type adds `market: string | null`
- `filterMarket` state, added to URLSearchParams fetch, `useCallback` dep array, `hasActiveFilters`, Clear handler
- Market select control (All Markets / Moneyline / Spread / Total) rendered after category select in filter row
- Segments table: 6-column → 7-column; header adds "Market"; data rows add `recommendedBetType` cell
- Row key: `sport-cardCategory-recommendedBetType` (stable 3-part key)

---

## Deviations from Plan

None — plan executed exactly as written.

---

## Self-Check

Files created/modified:

- [x] `apps/worker/src/jobs/settle_pending_cards.js` — modified (extractActualPlay, pickBetOdds)
- [x] `web/src/app/api/results/route.ts` — modified (market filter, 3-key GROUP BY, recommendedBetType)
- [x] `web/src/app/results/page.tsx` — modified (filterMarket state, market select, 7-col table)

Commits:

- [x] 0188e97 — fix(quick-21): settle using recommendation.type (actual BET) not raw prediction
- [x] 0d76679 — feat(quick-21): add market filter + market column to /results API and page

TypeScript: `npx tsc --noEmit` — passed with zero errors.

## Self-Check: PASSED
