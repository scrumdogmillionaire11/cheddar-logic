---
phase: quick
plan: 25
subsystem: nhl-cards
tags: [nhl, totals, transform, cards, wi-0333]
dependency_graph:
  requires: []
  provides: [nhl-pace-total-cards-unblocked, wi-0333-closed]
  affects: [web/src/lib/game-card/transform.ts, apps/worker/src/models/index.js, web/src/app/api/games/route.ts]
tech_stack:
  added: []
  patterns: [gate-exemption-by-market-type, descriptor-field-completeness]
key_files:
  created: []
  modified:
    - web/src/lib/game-card/transform.ts
    - apps/worker/src/models/index.js
    - web/src/app/api/games/route.ts
    - docs/DEPLOY_GITHUB.md
    - WORK_QUEUE/WI-0333.md
decisions:
  - "Exempt TOTAL/TEAM_TOTAL market types from STALE_EDGE_SUSPECTED gate (pace edge is in goal units, not probability units)"
  - "Remove price requirement from hasMinimumViability for TOTAL — price sourced from odds snapshot at display time"
  - "Add market_type/selection/line/price to nhl-pace-totals and nhl-pace-1p descriptors so hasMinimumViability passes"
metrics:
  duration: ~10 minutes
  completed_date: 2026-03-07
---

# Quick Task 25: Investigate Why NHL Totals Are Not Displaying — Summary

**One-liner:** Fixed two independent blockers preventing NHL pace-total cards from displaying — STALE_EDGE_SUSPECTED gate false-fired on goal-unit edges, and nhl-pace driver descriptors lacked market_type/selection/line fields required by hasMinimumViability.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fix STALE_EDGE_SUSPECTED gate and add missing fields to nhl-pace driver descriptors | d892da9 | transform.ts, route.ts, models/index.js |
| 2 | Close WI-0333 — commit env/docs changes and mark work item done | c7828b1 | DEPLOY_GITHUB.md, WI-0333.md |

## What Was Fixed

### Fix 1: STALE_EDGE_SUSPECTED gate false-firing on NHL pace plays (transform.ts)

The WI-0333 gate `if (edge > 0.30)` was intended to catch stale probability-unit edges (moneyline). NHL pace-model edge is measured in **goals** (0.4–0.8 is a normal, actionable edge). The gate was blocking every viable NHL total play.

**Change:** Added `&& resolvedMarketType !== 'TOTAL' && resolvedMarketType !== 'TEAM_TOTAL'` to the condition — TOTAL/TEAM_TOTAL plays skip this gate entirely.

### Fix 2: Missing descriptor fields in nhl-pace-totals and nhl-pace-1p (models/index.js)

The `computeNHLDriverCards()` function was emitting descriptor objects without `market_type`, `selection`, `line`, or `price`. The repair logic in `route.ts` calls `hasMinimumViability(play, 'TOTAL')` which requires `selection.side` and `play.line`. Without these, all NHL pace plays degraded to `market_type: 'INFO'` / `kind: 'EVIDENCE'` and were never displayed as bettable cards.

**Change:** Added to `nhl-pace-totals` descriptor:
- `market_type: 'TOTAL'`
- `selection: { side: direction }`
- `line: marketTotal`
- `price: direction === 'OVER' ? toNumber(oddsSnapshot?.total_price_over) : toNumber(oddsSnapshot?.total_price_under)`

Added to `nhl-pace-1p` descriptor:
- `market_type: 'TOTAL'`
- `selection: { side: direction1p }`
- `line: market1pTotal`
- `price: null` (1P prices not in standard odds snapshot)

### Fix 3: hasMinimumViability for TOTAL required price (route.ts)

With `nhl-pace-1p` emitting `price: null`, the viability check still failed. Since price for totals is sourced from the odds snapshot at display time, requiring it in the payload check was overly strict.

**Change:** Removed `hasPrice` from the TOTAL branch of `hasMinimumViability` — only `side` and `line` are required.

### WI-0333 Closed (docs/DEPLOY_GITHUB.md, WI-0333.md)

- `env.example` already had `CHEDDAR_DB_PATH` documented (no change needed)
- Added explicit "Pre-Deploy Checklist" section to `DEPLOY_GITHUB.md` with checkboxes for DB path consistency, run_state, and /api/games staging check
- Marked WI-0333 CLOSED with resolution summary

## Deviations from Plan

None — plan executed exactly as written. The four specific code changes (transform.ts gate, models/index.js nhl-pace-totals, models/index.js nhl-pace-1p, route.ts hasMinimumViability) were all implemented as prescribed.

## Human Verification Required — Task 3

**Task 3 is a `checkpoint:human-verify` gate.** Code changes are committed; visual verification requires the dev server to be running with a populated database.

### Verification Steps

1. Start dev server: `npm --prefix web run dev`
2. Confirm NHL games exist in DB:
   ```bash
   sqlite3 cheddar.db "SELECT card_type, count(*) FROM card_payloads WHERE sport='NHL' GROUP BY card_type"
   ```
3. Open http://localhost:3000/cards in browser
4. Look for NHL total plays with FIRE or WATCH badge
5. Check browser console — verify DROP_NO_BETTABLE_STATUS count is reduced for NHL games
6. Optionally hit `/api/games` directly and confirm NHL plays have `market_type: "TOTAL"` and `status: "FIRE"` or `"WATCH"`

### Expected Result

NHL pace-total and nhl-pace-1p cards should appear as FIRE/WATCH bettable cards rather than being absent or appearing as EVIDENCE-only cards.

## Self-Check: PASSED

- FOUND: web/src/lib/game-card/transform.ts
- FOUND: apps/worker/src/models/index.js
- FOUND: web/src/app/api/games/route.ts
- FOUND: commit d892da9 (Task 1)
- FOUND: commit c7828b1 (Task 2)
