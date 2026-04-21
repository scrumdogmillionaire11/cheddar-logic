---
phase: wi-1024-nba-residual-3a
plan: 01
subsystem: nba-model
tags: [residual-learning, nba, totals, shrinkage, calibration]
dependency_graph:
  requires: [WI-1020, WI-1021, WI-1027]
  provides: [computeNbaResidualCorrection, applyNbaResidualCombinedCeiling]
  affects: [nba-totals-call, nba-total-projection, raw_data.residual_correction]
tech_stack:
  added: []
  patterns: [TDD, hierarchy-segment-selection, bayesian-shrinkage, ceiling-enforcement]
key_files:
  created: []
  modified:
    - apps/worker/src/models/residual-projection.js
    - apps/worker/src/jobs/run_nba_model.js
    - apps/worker/src/models/__tests__/nba-projection-parity.test.js
    - apps/worker/src/__tests__/run-nba-model.test.js
decisions:
  - "Residual correction applied to blendedTotal (post rolling-bias) rather than raw paceAnchorTotal to preserve WI-1020 pipeline invariants"
  - "applyNbaResidualCombinedCeiling exported from residual-projection for testability; runner uses it inline"
  - "Residual stamped on nba-totals-call cards only (NBA_PROJECTION_ACCURACY_CARD_TYPES set)"
metrics:
  completed_date: "2026-04-21"
  tasks: 3
  files_modified: 4
---

# Quick Task 169 / WI-1024 Phase 3A: NBA Residual Learning Layer Summary

**One-liner:** Deterministic 5-level segment hierarchy with Bayesian shrinkage (n/30) and ±5/±6 dual caps for team/pace/band-specific NBA total bias correction.

## What Was Built

### `computeNbaResidualCorrection` (residual-projection.js)

New export added alongside existing `computeResidual`. Implements:

- **5-level segment hierarchy** (first with sufficient samples wins):
  1. `team × paceTier × totalBand × month` — min 15 samples → source: `full`
  2. `team × paceTier × totalBand` — min 15 samples → source: `team_pace_band`
  3. `team × totalBand` — min 15 samples → source: `team_band`
  4. `team` — min 10 samples → source: `team`
  5. Global WI-1020 bias fallback → source: `global`
  - No qualifying segment → `{ correction: 0, source: 'none' }`

- **Shrinkage formula:** `shrinkage = Math.min(1, n / 30)`, `correction = mean_residual * shrinkage + globalBias * (1 - shrinkage)`

- **Segment cap:** clamp to `[-5.0, 5.0]` with `[NBAModel] [RESIDUAL] segment correction clamped` log

- **Parameterized SQL** over `projection_accuracy_line_evals` with `AVG(actual_total - raw_total)` — no LIMIT

- **DB guard:** returns safe fallback `{ correction: 0, source: 'none' }` if db unavailable or query throws

### `applyNbaResidualCombinedCeiling` (residual-projection.js)

Exported helper enforcing `|rollingBias + residualCorrection| <= 6.0`:
```js
allowedResidual = 6.0 * sign(combined) - rollingBias
```
Scales only the residual term; preserves WI-1020 rolling bias exactly.

### NBA Runner (`run_nba_model.js`)

- Imports `computeNbaResidualCorrection` and `applyNbaResidualCombinedCeiling`
- Per-game residual lookup after `teamCtx`, using `rollingBias.bias` as `globalBias`
- Guard: skips residual + logs `[NBAModel] [RESIDUAL] skipped: WI-1020 rolling bias unavailable` when rollingBias is not finite
- Combined ceiling enforced inline before applying to card
- Applied exactly once to `nba-totals-call` projection total: `adjustedTotal = blendedTotal + residualCorrection`
- `raw_data.residual_correction` stamped with `{ correction, source, samples, segment, shrinkage_factor }`

## Deviations from Plan

None — plan executed exactly as written.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 24e6b63b | feat: add computeNbaResidualCorrection to residual-projection module |
| 2 | 3ec5ea86 | feat: wire NBA runner with ceiling and raw_data stamping |
| 3 | 7818c7e3 | feat: dependency-readiness guards and logging contract |

## Test Coverage

- `nba-projection-parity.test.js`: 12 tests (2 pre-existing + 10 new WI-1024 scenarios)
- `run-nba-model.test.js`: 21 tests (15 pre-existing + 6 new WI-1024 scenarios)

All 33 tests pass green.

## Self-Check: PASSED

All files found. All commits verified. Both test suites green (33 total tests).
