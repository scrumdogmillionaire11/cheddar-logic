---
phase: quick-71
plan: "01"
subsystem: nhl-shots-model
tags: [nhl, opportunity-score, play-direction, projectSogV2, projectBlkV1]
requires: []
provides: ["direction-aware opportunity_score for OVER/UNDER NHL shots cards"]
affects: ["WI-0576+", "NHL card payload display", "computePropDisplayState"]
tech-stack:
  added: []
  patterns: ["direction-aware scoring", "TDD RED-GREEN-REFACTOR"]
key-files:
  created: []
  modified:
    - apps/worker/src/models/nhl-player-shots.js
    - apps/worker/src/jobs/run_nhl_player_shots_model.js
    - apps/worker/src/models/__tests__/nhl-player-shots-two-stage.test.js
decisions:
  - "play_direction defaults to 'OVER' — zero breaking change to existing callers"
  - "Job runner uses classifyEdge(mu, marketLine, 0.75).direction inline at call site (no v2PlayDirection variable) — deterministic match with fullGameEdge.direction"
metrics:
  duration: "~10 minutes"
  completed: "2026-03-23"
---

# Phase quick-71 Plan 01: WI-0575 opportunity_score Direction Fix Summary

**One-liner:** Direction-aware `opportunity_score` added to `projectSogV2` and `projectBlkV1` — UNDER cards now use `edge_under_pp + ev_under + (market_line - mu)` instead of the OVER formula.

## Root Cause

**`projectSogV2` (lines 494–508, nhl-player-shots.js):** The `opportunity_score` block unconditionally gated on `market_price_over` and used `edge_over_pp`, `ev_over`, and `(sog_mu - market_line)`. When the V1 model called UNDER, the score was still computed from OVER-side inputs — producing a positive OVER score contradicting the UNDER call.

Same bug in **`projectBlkV1` (lines 704–716)** — identical pattern with blk_mu.

## Changes Per File

### `apps/worker/src/models/nhl-player-shots.js`

- Added `play_direction = 'OVER'` to destruction block of both `projectSogV2` (line ~384) and `projectBlkV1` (line ~615).
- Replaced single `if (market_price_over ...)` block with direction-branched version:
  - `play_direction === 'UNDER'` → gates on `market_price_under`, uses `edge_under_pp + ev_under + (market_line - mu)`.
  - else OVER (default) → existing formula unchanged.
- Both functions affected.

### `apps/worker/src/jobs/run_nhl_player_shots_model.js`

- Added `play_direction: classifyEdge(mu, marketLine, 0.75).direction` inline inside the `projectSogV2({...})` call (line ~1285).
- `mu` is computed at line 1207; `marketLine` resolved by line 1244 — both available before the call.
- This call result is deterministically identical to `fullGameEdge.direction` computed later at line 1400 (same `classifyEdge` with same `mu` + line inputs).

### `apps/worker/src/models/__tests__/nhl-player-shots-two-stage.test.js`

Four new tests added in the `Stage 2 — pricing layer invariants` block:
1. `play_direction=OVER` produces same result as omitting the param (backward-compat).
2. `play_direction=UNDER` with low shot rate returns non-null positive score.
3. `play_direction=UNDER` with `market_price_under=null` returns `null` (gating enforced).
4. `play_direction=OVER` with `market_price_over=null` returns `null` (existing behavior).

## Test Results

```
Test Suites: 1 passed, 1 total
Tests:       36 passed, 36 total (was 32 prior)
```

## Commits

| Hash    | Message |
|---------|---------|
| `ca802d1` | feat(quick-71): add play_direction to projectSogV2 and projectBlkV1 |
| `782c07a` | feat(quick-71): wire play_direction into projectSogV2 call in job runner |

## Deviations from Plan

None — plan executed exactly as written. The `v2PlayDirection` variable the plan described was inlined directly into the call argument (`classifyEdge(mu, marketLine, 0.75).direction`) rather than declared as a named variable first — cleaner and equivalent.
