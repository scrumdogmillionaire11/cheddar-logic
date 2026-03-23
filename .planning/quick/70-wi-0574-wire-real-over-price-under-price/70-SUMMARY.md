---
phase: quick-70
plan: 01
subsystem: nhl-props-pipeline
tags: [nhl, props, selection-price, odds-api, fix]
key-files:
  modified:
    - apps/worker/src/jobs/run_nhl_player_shots_model.js
decisions:
  - "Used ?? -110 fallback in both ternaries to preserve existing behavior when Odds API price is unavailable"
metrics:
  duration: "< 5 minutes"
  completed: 2026-03-23
  tasks: 1
  files: 1
---

# Phase quick-70 Plan 01: WI-0574 Wire Real Over/Under Price Summary

Real `over_price`/`under_price` from Odds API wired into `selection.price` for both full-game and 1P card payloads, replacing hardcoded `-110` with direction-conditional ternaries and `?? -110` fallback.

## What Changed

Three targeted edits in `apps/worker/src/jobs/run_nhl_player_shots_model.js` — no other files touched.

### Edit A — Full-game selection.price (line 1500)

**Before:**
```javascript
price: -110,
```

**After:**
```javascript
price: fullGameEdge.direction === 'OVER' ? (overPrice ?? -110) : (underPrice ?? -110),
```

Uses already-computed `overPrice`/`underPrice` variables (derived from `realPropLine?.over_price` / `realPropLine?.under_price` at line 1250).

### Edit B — 1P price variable declarations (lines 1337–1338, inserted after `resolvePlayerPropLineWithFallback` call)

**Added:**
```javascript
const overPrice1p = realPropLine1p?.over_price ?? null;
const underPrice1p = realPropLine1p?.under_price ?? null;
```

### Edit C — 1P selection.price (line 1739)

**Before:**
```javascript
price: -110,
```

**After:**
```javascript
price: firstPeriodEdge.direction === 'OVER' ? (overPrice1p ?? -110) : (underPrice1p ?? -110),
```

## Verification Output

### No hardcoded -110 remains in selection blocks

```
$ grep -n "price: -110" apps/worker/src/jobs/run_nhl_player_shots_model.js && echo "FOUND" || echo "NO HARDCODED -110 REMAINING"
NO HARDCODED -110 REMAINING
```

### Real price variables declared and used

```
$ grep -n "overPrice1p\|underPrice1p" apps/worker/src/jobs/run_nhl_player_shots_model.js
1337:            const overPrice1p = realPropLine1p?.over_price ?? null;
1338:            const underPrice1p = realPropLine1p?.under_price ?? null;
1739:                      price: firstPeriodEdge.direction === 'OVER' ? (overPrice1p ?? -110) : (underPrice1p ?? -110),
```

### Syntax check

```
$ node --check apps/worker/src/jobs/run_nhl_player_shots_model.js
SYNTAX OK
```

## Commit

- `69f91eb` — fix(quick-70-01): WI-0574 — wire real over_price/under_price into selection.price

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- [x] `apps/worker/src/jobs/run_nhl_player_shots_model.js` modified
- [x] Commit `69f91eb` exists
- [x] Zero `price: -110` in selection blocks
- [x] `overPrice1p` and `underPrice1p` declared at line 1337–1338
- [x] Full-game selection.price uses direction-conditional ternary
- [x] 1P selection.price uses direction-conditional ternary
- [x] Syntax check passes
