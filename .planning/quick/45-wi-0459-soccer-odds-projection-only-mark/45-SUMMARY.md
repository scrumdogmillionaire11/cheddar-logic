---
phase: quick-45
plan: "01"
subsystem: soccer-model
tags: [soccer, odds-api, projection-only, two-track, card-schemas, validator]
dependency_graph:
  requires: [WI-0437]
  provides: [soccer_ml, soccer_game_total, soccer_double_chance card schemas, two-track soccer runner]
  affects: [packages/odds/src/config.js, apps/worker/src/jobs/run_soccer_model.js, packages/data/src/validators/card-payload.js]
tech_stack:
  added: []
  patterns: [TDD red-green, two-track runner, odds-backed vs projection-only separation]
key_files:
  created: []
  modified:
    - packages/odds/src/config.js
    - apps/worker/src/jobs/run_soccer_model.js
    - packages/data/src/validators/card-payload.js
    - apps/worker/src/jobs/__tests__/run_soccer_model.test.js
decisions:
  - ODDS_API_MARKET_MAP checked first in normalizeToCanonicalSoccerMarket so odds API keys (h2h, totals, doubleChance) resolve to canonical card types before Tier1/Tier2/banned set lookups
  - buildSoccerOddsBackedCard is a separate function from buildSoccerTier1Payload to keep odds-backed vs projection-only logic cleanly separated
  - Track 2 fallback to gameOdds when getUpcomingGames not available ensures no breakage if data package lacks that export
  - projection_only flag on soccerOhioScopeSchema guards all price-cap superRefine checks so projection-only cards are never rejected for null prices
metrics:
  duration: "~25 min"
  completed_date: "2026-03-15"
  tasks_completed: 3
  files_changed: 4
---

# Phase Quick-45: WI-0459 Soccer Odds + Projection-Only Market Rework Summary

**One-liner:** Two-track soccer model runner with odds-backed ML/game-total/double-chance cards (real prices) and projection-only TSOA/shots/team-totals cards (projection_only:true) that emit regardless of odds availability.

## What Was Built

### Task 1 — Config + Validator
- `packages/odds/src/config.js`: SOCCER markets updated from `['h2h']` → `['h2h', 'totals', 'doubleChance']`; `tokensPerFetch` 1 → 3; token cost comment block updated.
- `packages/data/src/validators/card-payload.js`:
  - Added `soccerMlSchema` (`soccer_ml` card type — MONEYLINE with selection, price, edge_basis)
  - Added `soccerGameTotalSchema` (`soccer_game_total` — GAME_TOTAL with line, over/under price, selection)
  - Added `soccerDoubleChanceSchema` (`soccer_double_chance` — DOUBLE_CHANCE with outcome enum, price, edge_basis)
  - `soccerOhioScopeSchema`: added `projection_only: z.boolean().optional()` field; price-cap superRefine checks wrapped in `if (!payload.projection_only)` guard
  - Added `SOCCER_SELF_CONTAINED_TYPES` set replacing single-string `'soccer-ohio-scope'` check in `validateCardPayload`

### Task 2 — Two-Track Runner (TDD)
- `apps/worker/src/jobs/run_soccer_model.js`:
  - Added `ODDS_API_MARKET_MAP` lookup table: `h2h/moneyline → soccer_ml`, `totals/game_total → soccer_game_total`, `double_chance/doublechance → soccer_double_chance`
  - `normalizeToCanonicalSoccerMarket`: checks `ODDS_API_MARKET_MAP` first before Tier1/Tier2/banned sets
  - Removed `double_chance` from `OHIO_BANNED_MARKETS`
  - Added `soccer_ml`, `soccer_game_total`, `soccer_double_chance` to `OHIO_TIER1_MARKETS`
  - Added `buildSoccerOddsBackedCard(gameId, oddsSnapshot, canonicalCardType)` for all three odds-backed types
  - `runSoccerModel`: replaced early-exit block with Track 1 log; Track 1 processes odds snapshots (0 or more); Track 2 runs unconditionally for projection-only player markets with `projection_only:true`
  - Return value extended: `{ success, jobRunId, cardsGenerated, track1Cards, track2Cards }`
  - Exported `buildSoccerOddsBackedCard`

### Task 3 — Tests
All test cases were written during TDD RED phase (Task 2) and committed separately:
- `normalizeToCanonicalSoccerMarket` — odds API market keys describe block (8 new tests)
- `buildSoccerOddsBackedCard — soccer_ml` (1 new test)
- `buildSoccerOddsBackedCard — soccer_game_total` (2 new tests — happy path + MISSING_LINE)
- `buildSoccerOddsBackedCard — soccer_double_chance` (1 new test)
- `Track 2 projection-only cards` — soccer-ohio-scope with `projection_only:true` + null price (1 new test)
- All 24 pre-existing tests still pass; total: 34 tests, 34 passing.

## Commits

| Hash | Type | Description |
|------|------|-------------|
| 2911048 | feat | Config + validator — soccer markets, 3 new card schemas, projection_only flag |
| 8dfb695 | test | RED — failing tests for two-track runner (TDD) |
| 3b5b71d | feat | GREEN — two-track runner implementation + buildSoccerOddsBackedCard |

## Decisions Made

1. **ODDS_API_MARKET_MAP checked first** — Odds API raw market keys (h2h, totals, doubleChance) needed to resolve to canonical soccer card types before the Ohio projection market set lookups, since the same key space is shared.
2. **Separate builder function for odds-backed cards** — `buildSoccerOddsBackedCard` is intentionally separate from `buildSoccerTier1Payload` to maintain clear conceptual separation between odds-backed cards (real price) and projection-only cards (no price, model-derived).
3. **Track 2 fallback** — When `getUpcomingGames` is not exported from `@cheddar-logic/data`, Track 2 falls back to game IDs already seen in Track 1 to avoid a hard failure.

## Deviations from Plan

None — plan executed exactly as written. The TDD approach was followed: RED commit (8dfb695) preceded GREEN commit (3b5b71d).

## Self-Check

Verifying claims...

- Config change: `markets: ['h2h', 'totals', 'doubleChance'], tokensPerFetch: 3` — confirmed
- `normalizeToCanonicalSoccerMarket('double_chance')` returns `'soccer_double_chance'` — confirmed
- All 34 tests pass — confirmed
- Files modified match plan frontmatter — confirmed
