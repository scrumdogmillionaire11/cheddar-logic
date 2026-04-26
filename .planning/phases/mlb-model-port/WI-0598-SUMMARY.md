---
phase: 3
plan: WI-0598
subsystem: mlb-model
tags: [mlb, pitcher-k, validator, market-contract, odds-backed]

dependency-graph:
  requires: [WI-0595, WI-0596, WI-0597]
  provides: [mlb-pitcher-k schema, ODDS_BACKED payload contract, market-contract coverage]
  affects: [WI-0599, WI-0600]

tech-stack:
  added: []
  patterns: [self-contained PROP schema, basis enum gate, deriveLockedMarketContext bypass for PROP]

key-files:
  created:
    - packages/data/src/__tests__/validators/card-payload.mlb-pitcher-k.test.js
    - packages/data/src/__tests__/market-contract.test.js
  modified:
    - packages/data/src/validators/card-payload.js
    - apps/worker/src/jobs/run_mlb_model.js
    - apps/worker/src/models/mlb-model.js

decisions:
  - id: D1
    decision: PROP cards (mlb-pitcher-k, mlb-strikeout, mlb-f5) added to SOCCER_SELF_CONTAINED_TYPES set
    rationale: PROP market_type bypasses SPREAD/TOTAL/MONEYLINE contract; deriveLockedMarketContext returns null for unknown market types

metrics:
  duration: 40m
  completed: 2026-03-26
---

# Phase 3 WI-0598: Pitcher K Contract Hardening Summary

**One-liner:** Explicit `mlb-pitcher-k` Zod schema with basis-discriminated PROJECTION_ONLY/ODDS_BACKED gates, PROP self-contained bypass, strikeout_lines wiring and market-contract test coverage.

## What Was Delivered

- **`mlbPitcherKPayloadSchema`** — new Zod schema in `card-payload.js`:

  - Required fields: `game_id`, `sport: 'MLB'`, `market_type: 'PROP'`, `canonical_market_key: 'pitcher_strikeouts'`, `basis: enum(PROJECTION_ONLY|ODDS_BACKED)`, `player_name`
  - `PROJECTION_ONLY` superRefine gate: requires `tags` to include `'no_odds_mode'`
  - `ODDS_BACKED` superRefine gate: requires numeric `line` and non-empty `line_source`
  - Optional odds-backed fields: `over_price`, `under_price`, `best_line_bookmaker`, `margin`
  - `.passthrough()` — allows diagnostic fields without schema rejection

- **Self-contained types broadened** — `mlb-pitcher-k`, `mlb-strikeout`, `mlb-f5` added to `SOCCER_SELF_CONTAINED_TYPES` set. PROP cards skip `deriveLockedMarketContext` (which only handles SPREAD/TOTAL/MONEYLINE contracts).

- **`run_mlb_model.js` payload wiring** — `getPlayerPropLinesForGame` imported; `enrichMlbPitcherData` looks up `player_prop_lines` for `pitcher_strikeouts` rows when `PITCHER_KS_MODEL_MODE=ODDS_BACKED`. Payload carries `line_source`, `over_price`, `under_price`, `best_line_bookmaker`, `margin`. Card title is mode-aware: `[ODDS_BACKED]` vs `[PROJECTION_ONLY]`.

- **`mlb-model.js` scoring wiring** — `computePitcherKDriverCards` resolves market line from `mlb.strikeout_lines` map; passes `'FULL'` mode to `scorePitcherK` when line is available (enables Block 1 margin score + Block 4 structure score); gracefully degrades to `PROJECTION_ONLY` if no line found for pitcher. `lineMeta` (line_source, over_price, under_price, best_line_bookmaker) spread into driver card output.

## Tests

15 new passing tests across two files:

- `card-payload.mlb-pitcher-k.test.js`: 11 tests — valid PROJECTION_ONLY, valid ODDS_BACKED, reject missing no_odds_mode tag, reject missing line_source, reject wrong canonical_market_key, reject wrong sport, reject wrong market_type, reject missing player_name, reject invalid basis, reject missing game_id, PROP bypass of market contract
- `market-contract.test.js`: 4 tests — normalizeMarketType variants, deriveLockedMarketContext returns null for PROP market, existing TOTAL contract still works

## Deviations from Plan

None — plan executed exactly as written.

## Decisions Made

| Decision | Rationale |
|---|---|
| PROP self-contained bypass (not a new contract path) | PROP market_type is not SPREAD/TOTAL/MONEYLINE; returning null from deriveLockedMarketContext is correct behavior — added MLB cards to the existing bypass set |
| basis-discriminated superRefine instead of separate schemas | Single schema with conditional gates is simpler to maintain and makes the contract explicit in one place |
