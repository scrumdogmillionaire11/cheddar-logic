---
phase: WI-0853-mlb-f5-market-token
plan: 02
subsystem: web-market-type
tags: [mlb, typescript, market-type, normalizer, route-handler, backward-compat]
status: complete

dependency-graph:
  requires:
    - WI-0853-01 (worker emits FIRST_5_INNINGS)
  provides:
    - CanonicalMarketType includes FIRST_5_INNINGS
    - inferMarketFromCardType('mlb-f5') returns FIRST_5_INNINGS
    - MLB.expectedPlayableMarkets = Set(['PROP', 'FIRST_5_INNINGS'])
    - normalizeMarketType('FIRST_5_INNINGS') passes through
    - Legacy MLB FIRST_PERIOD rows remapped to FIRST_5_INNINGS at read time
  affects: []

tech-stack:
  added: []
  patterns:
    - Inline conditional remap at read layer (rowSport + token guard, no helper fn)

key-files:
  created: []
  modified:
    - web/src/lib/types/game-card.ts
    - web/src/lib/games/market-inference.ts
    - web/src/lib/games/normalizers.ts
    - web/src/lib/games/route-handler.ts
    - web/src/lib/games/stage-counters.ts
    - web/src/lib/games/validators.ts

decisions:
  - "Inline remap (rowSport === MLB + FIRST_PERIOD → FIRST_5_INNINGS) at line 2002 — rowSport already in scope at L1921"
  - "No helper function; plan explicitly said no separate helper needed"

metrics:
  duration: ~10 min
  completed: 2026-04-10
---

# Phase WI-0853 Plan 02: MLB F5 Market Token Web Layer Summary

**One liner:** Web layer: `FIRST_5_INNINGS` added to 6 MarketType unions across types/normalizers/route-handler; legacy MLB `FIRST_PERIOD` DB rows remapped inline; `npx tsc --noEmit` exits 0.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add FIRST_5_INNINGS to CanonicalMarketType and MarketType | 7e053fa | game-card.ts, market-inference.ts, normalizers.ts |
| 2 | Update route-handler MLB config + legacy remap + verify build | 8859738 | route-handler.ts, stage-counters.ts, validators.ts |

## Verification Results

- `game-card.ts` line 26: `| 'FIRST_5_INNINGS'` in CanonicalMarketType
- `market-inference.ts`: 3 occurrences (MarketType union, WAVE1_MARKETS, mlb-f5 branch)
- `normalizers.ts`: 2 occurrences (MarketType union + normalizeMarketType whitelist)
- `route-handler.ts` line 1029: `MLB.expectedPlayableMarkets = Set(['PROP', 'FIRST_5_INNINGS'])`
- `route-handler.ts` line 2004: inline legacy remap `rowSport === 'MLB' && FIRST_PERIOD → FIRST_5_INNINGS`
- `stage-counters.ts` line 14: `| 'FIRST_5_INNINGS'`
- `validators.ts` line 130: `| 'FIRST_5_INNINGS'`
- `npx tsc --noEmit`: EXIT 0

## Deviations from Plan

### Auto-fixed Issues

**[Rule 1 - Bug] stage-counters.ts + validators.ts MarketType unions missing FIRST_5_INNINGS**

- **Found during:** Task 2
- **Issue:** After adding FIRST_5_INNINGS to route-handler ACTIVE_SPORT_CARD_TYPE_CONTRACT (which uses market-inference.ts's exported `MarketType`) and to `CanonicalMarketType` (which drives route-handler's local `type MarketType = NonNullable<Play['market_type']>`), two type errors surfaced:
  - `stage-counters.ts` had its own local `MarketType` union without FIRST_5_INNINGS, causing incompatibility in `buildPlayableMarketFamilyDiagnostics`
  - `validators.ts` `hasMinimumViability` parameter type lacked FIRST_5_INNINGS
- **Fix:** Added `| 'FIRST_5_INNINGS'` to both union/parameter types
- **Files modified:** `stage-counters.ts`, `validators.ts`
- **Commit:** 8859738

## Human Verification Required

1. Confirm `/api/games` diagnostic shows `MLB: ['FIRST_5_INNINGS']` for missing F5 slots (not `FIRST_PERIOD`).
2. Confirm NHL total cards still render with `FIRST_PERIOD` / `1P` market type labels unchanged.
