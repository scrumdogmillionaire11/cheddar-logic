---
phase: WI-0779-consolidate-web-types
plan: "01"
subsystem: web-types
tags: [typescript, barrel, types, refactor]

dependency-graph:
  requires: []
  provides:
    - web/src/lib/types/index.ts barrel (all runtime types accessible via single path)
  affects:
    - Any future file in web/src that imports runtime types

tech-stack:
  added: []
  patterns:
    - Barrel re-export pattern for TS type consolidation
    - Explicit conflict resolution for co-exported types with incompatible definitions

file-tracking:
  key-files:
    created:
      - path: web/src/lib/types/index.ts
        summary: Barrel re-exporting game-card and canonical-play types; resolves Sport/PassReasonCode ambiguity
    modified:
      - path: web/src/components/cards/game-card-helpers.tsx
        summary: Updated from @/lib/types/game-card to @/lib/types (pre-committed in 058b991)
      - path: web/src/components/cards/shared.ts
        summary: Updated from @/lib/types/game-card to @/lib/types
      - path: web/src/components/cards/types.ts
        summary: Updated from @/lib/types/game-card to @/lib/types
      - path: web/src/components/filter-panel.tsx
        summary: Updated from @/lib/types/game-card to @/lib/types
      - path: web/src/components/prop-game-card.tsx
        summary: Updated from @/lib/types/game-card to @/lib/types
      - path: web/src/lib/games/route-handler.ts
        summary: Updated from @/lib/types/game-card to @/lib/types
      - path: web/src/lib/game-card/market-signals.ts
        summary: Updated from @/lib/types/game-card to @/lib/types
      - path: web/src/lib/game-card/canonical-decision.ts
        summary: Updated from @/lib/types/game-card to @/lib/types
      - path: web/src/lib/game-card/presets.ts
        summary: Updated from @/lib/types/game-card to @/lib/types
      - path: web/src/lib/play-decision/decision-logic.ts
        summary: Updated from ../types/canonical-play to ../types
      - path: web/src/lib/play-decision/decision-logic.test.ts
        summary: Updated from ../types/canonical-play to ../types
      - path: web/src/lib/game-card/transform/index.ts
        summary: Updated to barrel for CanonicalPlay/MarketType/SelectionKey; kept direct canonical-play for Sport as CanonicalSport
      - path: web/src/lib/game-card/filters.ts
        summary: Updated from ../types/game-card to ../types (extra, not in plan scope)
      - path: web/src/lib/game-card/driver-scoring.ts
        summary: Updated from ../types/game-card to ../types (extra, not in plan scope)
      - path: web/src/lib/game-card/tags.ts
        summary: Updated from ../types/game-card to ../types (extra, not in plan scope)
      - path: web/src/lib/game-card/transform/legacy-repair.ts
        summary: Updated from ../../types/game-card to ../../types (extra, not in plan scope)
      - path: web/src/lib/game-card/transform/market-normalize.ts
        summary: Updated from ../../types/game-card to ../../types (extra, not in plan scope)

decisions:
  - id: barrel-conflict-resolution
    summary: "game-card.Sport wins (wider), canonical-play.PassReasonCode wins (used by decision-logic)"
    rationale: "game-card exports MLB/NFL/UNKNOWN which are required by all web components. canonical-play PassReasonCode has NO_EDGE, TOTAL_BIAS_CONFLICT, CONSISTENCY_FAIL values used by decision-logic.ts."
    alternatives: "Merge types at source (requires WI scope) or use separate barrels (defeats purpose)"
  - id: three-files-kept-deep-paths
    summary: "decision.ts, title-inference.ts kept ../types/game-card; transform/index.ts kept one canonical-play direct import"
    rationale: "decision.ts and title-inference.ts assign game-card-specific PassReasonCode literals; transport/index.ts needs canonical-play's narrower Sport for a casting operation at L1898. Changing these would require type alignment work out of WI scope."
    alternatives: "Could merge/unify the two Sports — deferred"

metrics:
  duration: "~16 minutes"
  completed: "2026-04-06"

one-liner: "web/src/lib/types/index.ts barrel with explicit Sport/PassReasonCode conflict resolution updates 12/13 planned import sites to stable barrel path"
---

# Phase WI-0779 Plan 01: Consolidate Web Type Directories Summary

**One-liner:** `web/src/lib/types/index.ts` barrel with explicit `Sport`/`PassReasonCode` conflict resolution; 12/13 planned import sites + 5 extra files use barrel path.

## What Was Built

Created `web/src/lib/types/index.ts` as a single barrel re-exporting all runtime types from both `canonical-play.ts` and `game-card.ts`.

**Key discovery:** Both type files export `Sport` and `PassReasonCode` with incompatible member sets:
- `game-card.Sport` = `'NHL' | 'NBA' | 'NCAAM' | 'SOCCER' | 'MLB' | 'NFL' | 'UNKNOWN'` (wider)
- `canonical-play.Sport` = `'NBA' | 'NHL' | 'SOCCER' | 'NCAAM'` (narrower)

TypeScript TS2308 required explicit conflict resolution. Barrel strategy:
```ts
export * from './game-card';         // game-card types first
export * from './canonical-play';    // canonical-play unique types
// Explicit resolution:
export type { Sport } from './game-card';           // game-card wins (wider)
export type { PassReasonCode } from './canonical-play'; // canonical-play wins
```

## Tasks Completed

| Task | Name | Status |
|------|------|--------|
| 1 | Create web/src/lib/types/index.ts barrel | ✓ DONE |
| 2 | Update all deep-path imports to use the barrel | ✓ DONE (12/13 planned + 5 extra) |

## Commits

| Hash | Description |
|------|-------------|
| 058b991 | (pre-existing, prior agent) Updated 11 planned files to barrel imports |
| 0ea4cc1 | feat(WI-0779): create barrel + update remaining deep-path imports |

## Verification Results

| Check | Result |
|-------|--------|
| New TS errors from barrel | 0 |
| web/src/types/ ambient-only | ✓ (cheddar-logic-data.d.ts, cheddar-models.d.ts) |
| web/src/lib/types/ includes barrel | ✓ (canonical-play.ts, game-card.ts, index.ts) |
| Planned import sites using barrel | 12/13 |
| Build failure introduced | None (pre-existing GameCardItem.tsx failure unchanged) |

## Deviations from Plan

### Auto-added files (not in plan)

**[Rule 2 - Missing Critical] Updated 5 extra files with deep-path game-card imports**

- **Found during:** Task 2 verification scan
- **Files:** `filters.ts`, `driver-scoring.ts`, `tags.ts`, `transform/legacy-repair.ts`, `transform/market-normalize.ts`
- **Issue:** These files had `../types/game-card` or `../../types/game-card` deep-path imports not listed in the plan
- **Fix:** Updated to barrel path where safe (no PassReasonCode literal conflict)
- **Commit:** 0ea4cc1

### Files kept at deep paths (by design after type conflict investigation)

**[Rule 1 - Bug discovery] TypeScript barrel conflict between Sport and PassReasonCode**

- **Found during:** Task 2 build verification
- **Issue:** Both type files export `Sport` and `PassReasonCode` with incompatible definitions; naive `export * from both` causes TS2308 + runtime type errors
- **Fix:** Explicit re-export override in barrel (game-card Sport, canonical-play PassReasonCode)
- **3 files kept partial/full deep paths:**
  - `decision.ts` — uses game-card `PassReasonCode` literals (`PASS_NO_EDGE`, `PASS_BLOCKED_STALE`)
  - `title-inference.ts` — uses game-card `PassReasonCode` literals (`PRICE_TOO_STEEP`, `NO_VALUE_AT_PRICE`)
  - `transform/index.ts` — one import: `Sport as CanonicalSport from '../../types/canonical-play'` (needs narrower type for cast at L1898)

## Next Phase Readiness

**Blocker for full deep-path elimination:** `Sport` and `PassReasonCode` in `game-card.ts` and `canonical-play.ts` are semantically different types with the same name. Full consolidation requires merging or aliasing these types at the source — deferred to a future WI.

The barrel is production-ready: all callers that can safely use it do so. The 2 remaining files with deep game-card paths (`decision.ts`, `title-inference.ts`) are stable and internally consistent.

---
_Completed: 2026-04-06T01:25:39Z — GitHub Copilot (pax-executor)_
