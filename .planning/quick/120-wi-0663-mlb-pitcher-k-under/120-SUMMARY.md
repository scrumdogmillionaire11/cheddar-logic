---
phase: quick
plan: "120"
subsystem: mlb-pitcher-k
tags: [mlb, pitcher-k, odds-backed, under, scoring-engine]
requires: []
provides: [mlb-pitcher-k-odds-backed-under-pipeline]
affects: []
tech-stack:
  added: []
  patterns: [TDD-RED-GREEN, env-var-feature-flag]
key-files:
  created: []
  modified:
    - apps/worker/src/models/mlb-model.js
    - apps/worker/src/jobs/run_mlb_model.js
    - apps/worker/src/jobs/__tests__/run_mlb_model.test.js
    - web/src/__tests__/api-games-prop-decision-contract.test.js
    - web/src/__tests__/game-card-transform-market-contract.test.js
    - web/src/__tests__/prop-game-card-contract.test.js
    - packages/data/src/__tests__/validators/card-payload.mlb-pitcher-k.test.js
decisions:
  - ODDS_BACKED mode is gated by PITCHER_KS_MODEL_MODE=ODDS_BACKED env var; default is PROJECTION_ONLY
  - selectPitcherKUnderMarket uses highest-line priority, then best under_price tiebreak, then bookmaker priority
  - When ODDS_BACKED mode set but no strikeout_lines entry found, falls back to PROJECTION_ONLY with MODE_FORCED reason code
metrics:
  duration: "31 minutes"
  completed: "2026-04-03"
---

# Quick Task 120: WI-0663 MLB Pitcher-K UNDER Pipeline Summary

**One-liner:** Wired ODDS_BACKED under-scoring path in MLB pitcher-K engine via `selectPitcherKUnderMarket` + `scorePitcherKUnder` with env-var feature flag and full contract-test coverage.

## What Was Built

### Task 1: ODDS_BACKED Under-Scoring Path (TDD)

Added two new functions to `mlb-model.js`:

**`selectPitcherKUnderMarket(strikeoutLines, pitcherLookupKey, bookmakerPriority)`**
- Selects the best under market entry for a pitcher from `strikeoutLines`
- Priority: highest line → best (closest to zero) `under_price` → bookmaker order
- Filters: line must be ≥ 5.0; returns `null` if no qualifying entry

**ODDS_BACKED branch in `computePitcherKDriverCards`**
- When mode is `ODDS_BACKED` and `selectPitcherKUnderMarket` finds a market: calls `scorePitcherKUnder`, emits PLAY/WATCH/NO_PLAY card with `basis: 'ODDS_BACKED'` and `lean_side: 'UNDER'`
- When mode is `ODDS_BACKED` but no strikeout_lines entry found: falls back to PROJECTION_ONLY with reason code `MODE_FORCED:ODDS_BACKED->PROJECTION_ONLY`
- Exports `selectPitcherKUnderMarket` for external testing

**`resolvePitcherKsMode` updated in `run_mlb_model.js`**
- Now reads `process.env.PITCHER_KS_MODEL_MODE`; returns `'ODDS_BACKED'` if set to that value, otherwise `'PROJECTION_ONLY'`
- `bookmakerPriority` is now passed through to `computePitcherKDriverCards`

### Task 2: Web Contract Tests and Validator Coverage

- **`api-games-prop-decision-contract.test.js`**: Added assertion that `lean_side` flows for pitcher-K ODDS_BACKED cards
- **`game-card-transform-market-contract.test.js`**: Added assertion that transform handles `basis: 'ODDS_BACKED'` for pitcher-K cards
- **`prop-game-card-contract.test.js`**: Fixed pre-existing bug — assertion was checking `'Win condition: {thresholdOutcomeText}'` but source uses template literal `'Win condition: ${thresholdOutcomeText}'` (missing `$`)
- **`card-payload.mlb-pitcher-k.test.js`**: Added ODDS_BACKED payload test asserting `lean_side: 'UNDER'` is accepted

## Test Results

| Test suite | Before | After |
|---|---|---|
| run_mlb_model.test.js | 78 pass / 10 fail | 87 pass / 1 fail* |
| card-payload.mlb-pitcher-k | 18 pass | 19 pass |
| api-games-prop-decision-contract | ✅ pass | ✅ pass |
| game-card-transform-market-contract | ✅ pass | ✅ pass |
| prop-game-card-contract | ❌ fail | ✅ pass |

*The 1 remaining failure (`opponent_contact_profile` in missing_inputs) is a pre-existing issue tracked in WI-0744 — confirmed failing before this task.

## Commits

| Hash | Message |
|---|---|
| addecd5 | test(quick-120): add failing tests for ODDS_BACKED under-scoring path |
| 5dda36e | feat(quick-120): wire ODDS_BACKED under-scoring path end-to-end |
| 7c556e2 | feat(quick-120): wire ODDS_BACKED lean_side into web contract tests and validator |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed prop-game-card-contract test assertion**
- **Found during:** Task 2
- **Issue:** Test assertion checked `source.includes('Win condition: {thresholdOutcomeText}')` but actual source uses template literal `\`Win condition: ${thresholdOutcomeText}\`` — the `$` was missing from the expected string
- **Fix:** Updated assertion to `source.includes('Win condition: ${thresholdOutcomeText}')`
- **Files modified:** `web/src/__tests__/prop-game-card-contract.test.js`
- **Commit:** 7c556e2

**2. [Rule 1 - Bug] PLAY vs WATCH score threshold alignment**
- **Found during:** Task 1 GREEN phase
- **Issue:** Test fixture for "strong under profile" was only yielding WATCH, not PLAY — the `scorePitcherKUnder` NET_SCORE threshold for PLAY requires higher than just a few reason codes
- **Fix:** Updated test fixture to use a declining-K pitcher profile with 5 of last 5 starts under (80%+ hit rate) which yields sufficient net score for PLAY verdict
- **Files modified:** `apps/worker/src/jobs/__tests__/run_mlb_model.test.js`
- **Commit:** 5dda36e

## Next Phase Readiness

- ODDS_BACKED mode is production-ready behind `PITCHER_KS_MODEL_MODE=ODDS_BACKED` env var
- WI-0744 remains open for `opponent_contact_profile` enrichment (the one pre-existing failing test)
- To activate: set `PITCHER_KS_MODEL_MODE=ODDS_BACKED` on worker and ensure `strikeout_lines` is populated in the MLB odds snapshots
