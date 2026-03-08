---
phase: 27-market-specific-edge-explanation-spread-
plan: 01
subsystem: game-card-decision
tags: [spread, decision-model, ui, tdd]
dependency_graph:
  requires: [game-card.ts SpreadCompare type, decision.ts DecisionModel, decision.js runtime]
  provides: [spreadCompare field on DecisionModel, Spread Compare panel, model-lean label]
  affects: [cards-page-client.tsx, decision.ts, decision.js, game-card.ts]
tech_stack:
  added: []
  patterns: [TDD red-green, parallel JS+TS runtime sync]
key_files:
  created: []
  modified:
    - web/src/lib/types/game-card.ts
    - web/src/lib/game-card/decision.ts
    - web/src/lib/game-card/decision.js
    - web/src/components/cards-page-client.tsx
    - web/src/__tests__/game-card-decision.test.js
decisions:
  - "Regex parse of driver notes for projectedSpread — no lossy signal field recovery"
  - "Parallel update of decision.ts (TypeScript) and decision.js (runtime used by tests)"
  - "spreadCompare is null for all non-SPREAD markets, directional guard (HOME/AWAY only)"
metrics:
  duration: ~20 min
  completed: 2026-03-07
  tasks_completed: 2
  files_modified: 5
  commits: 3
---

# Phase 27 Plan 01: Market-Specific Edge Explanation + Spread Compare Summary

**One-liner:** SpreadCompare field on DecisionModel surfaces market line (and optional projected spread from driver notes) on spread cards; PASS cards with directional drivers show "Model lean only — no betting edge".

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (TDD RED) | Failing SpreadCompare tests | 7db5728 | game-card-decision.test.js |
| 1 (TDD GREEN) | SpreadCompare type + deriveSpreadCompare | 2ac85f8 | game-card.ts, decision.ts, decision.js |
| 2 | Spread Compare UI panel + model-lean label | caefa13 | cards-page-client.tsx |

## What Was Built

### SpreadCompare Type (game-card.ts)

New exported interface:

```typescript
export interface SpreadCompare {
  direction: Direction;           // HOME or AWAY
  marketLine: number | null;      // e.g., -9.5
  projectedSpread: number | null; // Parsed from driver note; null if unparseable
}
```

### deriveSpreadCompare (decision.ts + decision.js)

- Returns null for non-SPREAD markets and non-HOME/AWAY directions
- `marketLine`: `odds.spreadHome` for HOME, `odds.spreadAway` for AWAY; falls back to negated opposite if chosen side is null
- `projectedSpread`: scans `topContributors` and `allDrivers` (SPREAD/UNKNOWN market) notes for regex `/[Pp]roj(?:ected)?\s*(?:spread|margin)?:?\s*([+-]?\d+\.?\d*)/`; returns first parseable float or null
- Added to `getCardDecisionModel` return object in both TS and JS runtimes

### Spread Compare Panel (cards-page-client.tsx)

Inserted after edge math / coinflip messaging, before "Why" block:
- When `projectedSpread !== null`: shows "Proj -8.2 vs Market -9.5"
- When `projectedSpread === null`: shows "Market line -9.5"
- Only renders when `decision.spreadCompare` is non-null (SPREAD market only)

### Model Lean Label

Updated WEAK support grade label in Top Contributors header:
- PASS + topContributors.length > 0 + (PASS_DRIVER_SUPPORT_WEAK or PASS_NO_EDGE) → "Model lean only — no betting edge"
- PASS_MISSING_PRIMARY_DRIVER → "No primary driver" (unchanged)
- PASS_CONFLICT_HIGH → "High conflict" (unchanged)
- Default → "Weak support" (unchanged)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] decision.js runtime must be updated alongside decision.ts**

- **Found during:** Task 1 GREEN phase
- **Issue:** Tests import `decision.js` directly (Node ESM runtime). TypeScript changes to `decision.ts` don't affect the runtime until compiled. `spreadCompare` returned `undefined` because `decision.js` lacked the function.
- **Fix:** Added `deriveSpreadCompare` and updated `getCardDecisionModel` return in `decision.js` to match the TypeScript implementation.
- **Files modified:** `web/src/lib/game-card/decision.js`
- **Commit:** 2ac85f8

## Verification Results

- `npm --prefix web run test:card-decision` — 5 SpreadCompare tests + all prior tests pass
- `npm --prefix web run test:ui:cards` — UI smoke tests pass
- `npm --prefix web run test:games-filter` — No regressions (15/15 pass)
- `npm --prefix web run build` — TypeScript compiles clean

## Self-Check: PASSED

- [x] SpreadCompare exported from game-card.ts
- [x] `spreadCompare` field on DecisionModel in decision.ts
- [x] `deriveSpreadCompare` in decision.js runtime
- [x] Spread Compare panel in cards-page-client.tsx (contains `spreadCompare`)
- [x] Model lean label updated with 4-branch logic
- [x] All 3 test suites pass
- [x] Build clean
