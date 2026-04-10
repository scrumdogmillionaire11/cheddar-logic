---
phase: WI-0819
plan: 1
subsystem: betting-execution
tags: [kelly, stake-sizing, edge-calculator, nba, nhl, mlb, payload]
status: complete
completed: 2026-04-10
duration: "~40 minutes"

dependency-graph:
  requires: [WI-0813]
  provides: [kelly_fraction, kelly_units on PLAY/LEAN card payloads]
  affects: [WI-0826, WI-0829]

tech-stack:
  added: []
  patterns: [quarter-Kelly formula, advisory-only sizing signal, null-guard for negative-EV]

key-files:
  created: []
  modified:
    - packages/models/src/edge-calculator.js
    - packages/models/src/__tests__/edge-calculator.test.js
    - apps/worker/src/jobs/run_nba_model.js
    - apps/worker/src/jobs/run_nhl_model.js
    - apps/worker/src/jobs/run_mlb_model.js

decisions:
  - id: D1
    decision: "Use kellyStake(p_fair, price) — returns null/null when p_fair or price absent"
    rationale: "MLB prop cards don't populate p_fair; graceful null is cleaner than conditional injection."
  - id: D2
    decision: "WI acceptance criterion for kellyStake(0.55, -110) ≈ 0.0025 was incorrect"
    rationale: "Correct math gives ~0.0138 (5.5% full Kelly × 0.25 = 1.38%). Test updated to match."

metrics:
  tests-added: 10
  tests-total-pass: "19/19 node:test edge-calculator; 19/19 NBA; 35/35 NHL; 95/95 MLB"
---

# Phase WI-0819 Plan 1: Quarter-Kelly Stake Fraction Summary

**One-liner:** Quarter-Kelly stake sizing via `kellyStake(pFair, americanOdds)` → `kelly_fraction` + `kelly_units` on every PLAY/LEAN card payload across NBA, NHL, MLB.

## What Was Built

Added an advisory `kelly_fraction` and `kelly_units` field to every PLAY and LEAN card payload so users have a quantitative bet sizing signal derived from model edge rather than guessing.

### `kellyStake()` function — `packages/models/src/edge-calculator.js`

Full Kelly: $f^* = \frac{p \cdot b - q}{b}$   
Quarter-Kelly: $f = 0.25 \times \min(f^*, 0.25)$

- Converts American odds → decimal odds internally
- Clamps full Kelly at 25% bankroll before applying the 0.25 multiplier
- Returns `{ kelly_fraction: null, kelly_units: null }` for negative EV, invalid inputs
- Exported via `module.exports`

### Card payload attachment

| Model | Insertion point | Status field used |
|-------|----------------|-------------------|
| NBA (`run_nba_model.js`) | After WI-0835 sigma annotation loop | `decision_v2.official_status` |
| NHL (`run_nhl_model.js`) | Before WI-0817 write transaction | `decision_v2.official_status` |
| MLB (`run_mlb_model.js`) | After WI-0835 sigma annotation | `status/action/classification` |

PASS cards always carry `kelly_fraction: null, kelly_units: null`.

No validator changes needed — all card schemas use `.passthrough()`.

## Tests Added

`packages/models/src/__tests__/edge-calculator.test.js` — 10 new tests:
- Slight favourite at juice → small positive fraction
- Break-even at juice → null (negative EV)
- Strong edge → positive conservative fraction
- Large favourite with huge edge → capped at ≤ 0.0625
- Large underdog → positive fraction
- Invalid pFair (0, 1, NaN) → null
- Invalid americanOdds (0, NaN) → null
- `kelly_units = kelly_fraction × 100` sanity check

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] WI acceptance criterion for `kellyStake(0.55, -110)` was mathematically wrong**

- **Found during:** Test RED phase
- **Issue:** WI spec said `kelly_fraction ≈ 0.0025`, but correct quarter-Kelly at p=0.55, -110 is `~0.0138` (full Kelly =5.5%, ×0.25 = 1.375%)
- **Fix:** Updated test assertion to `0.01 < kelly_fraction < 0.03`
- **Files modified:** `packages/models/src/__tests__/edge-calculator.test.js`

## Human Verification Required

1. Run NBA model on game-day: query a PLAY card from `card_payloads` and confirm `kelly_fraction` is non-null and in range 0.001–0.06.
2. Query a PASS card and confirm `kelly_fraction = null`.
3. Verify `kelly_units ≈ kelly_fraction × 100`.

_Completed: 2026-04-10 | Agent: GitHub Copilot (pax-executor)_
