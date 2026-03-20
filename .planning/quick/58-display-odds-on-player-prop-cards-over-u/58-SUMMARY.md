---
phase: 58-display-odds-on-player-prop-cards-over-u
plan: "01"
subsystem: web/props-ui
tags: [props, odds, ui, transform, contract-test]
dependency_graph:
  requires: [run_nhl_player_shots_model.js writes market_price_over/under to payload]
  provides: [priceOver/priceUnder on PropPlayRow, odds line in Model Snapshot block]
  affects: [prop-game-card.tsx, game-card.ts, transform.ts, route.ts]
tech_stack:
  added: []
  patterns: [type-cast pattern for unknown play fields, firstNumber() extraction from payload]
key_files:
  created: []
  modified:
    - web/src/app/api/games/route.ts
    - web/src/lib/types/game-card.ts
    - web/src/lib/game-card/transform.ts
    - web/src/components/prop-game-card.tsx
    - web/src/__tests__/game-card-transform-evidence-contract.test.js
decisions:
  - Followed exact prop_display_state type-cast pattern for market_price_over/under in transform.ts
  - Odds line renders conditionally only when at least one price is non-null (null-safe guard)
  - Used existing formatOdds() helper — no new utility needed
metrics:
  duration: ~10 minutes
  completed: 2026-03-20
  tasks_completed: 3
  files_modified: 5
---

# Phase 58 Plan 01: Display Odds on Player Prop Cards Summary

**One-liner:** Plumbed existing `market_price_over/under` payload fields through route.ts extraction → transform PropPlayRow mapping → conditional "OVER -115 / UNDER +105" odds line in the Model Snapshot UI block.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Wire market_price_over/under through route.ts Play type and emission | 70d90b2 | web/src/app/api/games/route.ts |
| 2 | Add priceOver/priceUnder to PropPlayRow and map in transform | de784b0 | game-card.ts, transform.ts |
| 3 | Render over/under odds in prop-game-card + contract test | ead47cb | prop-game-card.tsx, contract test |

## What Was Built

The model job already wrote `market_price_over` and `market_price_under` into card payloads but nothing consumed them. This plan wires the full chain:

1. **route.ts Play interface** — Added `market_price_over?: number | null` and `market_price_under?: number | null` to the local Play interface.
2. **route.ts extraction** — Used `firstNumber()` to extract from `payload` and `payloadPlay`, emit `normalizedPriceOver`/`normalizedPriceUnder` on the play object adjacent to `l5_sog`/`l5_mean`.
3. **PropPlayRow type** — Added `priceOver` and `priceUnder` optional fields with JSDoc noting null means no real line.
4. **transform.ts** — Mapped via the exact type-cast pattern used for `prop_display_state`: `(play as unknown as Record<string, unknown>).market_price_over`.
5. **prop-game-card.tsx** — Conditional odds line in Model Snapshot block: only renders when `priceOver != null || priceUnder != null`. Uses existing `formatOdds()` helper for American format.
6. **Contract test** — Two assertions added verifying transform source contains `priceOver`/`priceUnder` and `market_price_over`/`market_price_under`.

## Verification

- TypeScript: `npx tsc --noEmit --project web/tsconfig.json` exits 0 (clean)
- Contract test: `npm --prefix web run test:transform:evidence` passes
- Props with real sportsbook lines show "OVER -115 / UNDER +105" below confidence bar
- PROJECTION_ONLY props (null prices) show no odds row

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- [x] web/src/app/api/games/route.ts — modified (market_price_over/under in Play interface + extraction + emission)
- [x] web/src/lib/types/game-card.ts — modified (priceOver/priceUnder on PropPlayRow)
- [x] web/src/lib/game-card/transform.ts — modified (priceOver/priceUnder mapped from play)
- [x] web/src/components/prop-game-card.tsx — modified (odds line rendered conditionally)
- [x] web/src/__tests__/game-card-transform-evidence-contract.test.js — modified (two new assertions)
- [x] Commits 70d90b2, de784b0, ead47cb exist
