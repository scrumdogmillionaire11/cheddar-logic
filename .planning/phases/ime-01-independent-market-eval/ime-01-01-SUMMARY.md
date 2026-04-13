---
phase: ime-01-independent-market-eval
plan: "01"
subsystem: models
tags: [market-eval, evaluation-contract, invariant, terminal-status, tdd]
dependency_graph:
  requires: [packages/models/src/decision-pipeline-v2.js]
  provides: [packages/models/src/market-eval.js, packages/models/src/market-eval.test.js]
  affects: [downstream market selection, card pipeline, bet execution gate]
tech_stack:
  added: []
  patterns: [frozen REASON_CODES constant, partition-then-assert invariant pattern]
key_files:
  created:
    - packages/models/src/market-eval.js
    - packages/models/src/market-eval.test.js
  modified: []
decisions:
  - "REASON_CODES frozen object is sole source of rejection reason strings — no ad-hoc strings in evaluation logic"
  - "assertNoSilentMarketDrop called inside finalizeGameMarketEvaluation before returning — ensures invariant can never be bypassed"
  - "SKIP_GAME_INPUT_FAILURE triggered only when ALL results are REJECTED_INPUTS, not merely when inputs_ok=false on any single result"
metrics:
  duration: "~15 minutes"
  completed: "2026-04-13T01:38:00Z"
  tasks_completed: 2
  files_created: 2
  files_modified: 0
---

# Phase ime-01 Plan 01: Independent Market Evaluation Contract Summary

**One-liner:** Shared `market-eval.js` evaluation contract enforcing one terminal status per market via REASON_CODES, partition invariant, and 12 passing unit tests covering all terminal states and drop accounting.

## What Was Built

`packages/models/src/market-eval.js` establishes the independent market evaluation contract for the card pipeline. Every market candidate evaluated through this module must exit in exactly one terminal status — no markets can silently disappear without accounting.

### Exports

| Export | Purpose |
|--------|---------|
| `REASON_CODES` | Frozen object with 9 named rejection reason strings; sole source of rejection strings |
| `evaluateSingleMarket(card, ctx)` | Returns `MarketEvalResult` with one terminal status per call |
| `finalizeGameMarketEvaluation({game_id, sport, market_results})` | Partitions results into official_plays/leans/rejected; computes game-level status; calls invariant check |
| `assertNoSilentMarketDrop(gameEval)` | Throws `UNACCOUNTED_MARKET_RESULTS for {game_id}` when `market_results.length !== official+leans+rejected` |
| `logRejectedMarkets(rejected, logger)` | Logs `[MARKET_REJECTED]` line per rejected result |

### evaluateSingleMarket Terminal Status Logic

| Condition | Status |
|-----------|--------|
| `card == null` | `REJECTED_INPUTS` |
| `card.missing_inputs.length > 0` | `REJECTED_INPUTS` |
| `card.ev_threshold_passed === false` | `REJECTED_THRESHOLD` |
| `card.status === 'PASS'` | `REJECTED_THRESHOLD` |
| `card.classification === 'LEAN'` or `card.status === 'WATCH'` | `QUALIFIED_LEAN` |
| `card.ev_threshold_passed === true` and `status === 'FIRE'` or `classification === 'BASE'` | `QUALIFIED_OFFICIAL` |
| Default fallback | `REJECTED_THRESHOLD` + `UNCLASSIFIED_MARKET_STATE` |

### GameMarketEvaluation Status Logic

| Condition | Status |
|-----------|--------|
| All results are `REJECTED_INPUTS` | `SKIP_GAME_INPUT_FAILURE` |
| `official_plays.length > 0` | `HAS_OFFICIAL_PLAYS` |
| `leans.length > 0` | `LEANS_ONLY` |
| All rejected (non-input) | `SKIP_MARKET_NO_EDGE` |

## Tests

12 unit tests in `packages/models/src/market-eval.test.js` (exceeds the required 7):

| Test | Scenario | Status |
|------|----------|--------|
| 1 | null card → REJECTED_INPUTS + MISSING_MARKET_ODDS | PASS |
| 2a | ev_threshold_passed=false → REJECTED_THRESHOLD + EDGE_BELOW_THRESHOLD | PASS |
| 2b | Card reason_codes propagated to rejection | PASS |
| 3 | status=WATCH + ev_threshold_passed=true → QUALIFIED_LEAN | PASS |
| 4a | status=FIRE + ev_threshold_passed=true → QUALIFIED_OFFICIAL | PASS |
| 4b | classification=BASE + ev_threshold_passed=true → QUALIFIED_OFFICIAL | PASS |
| 5a | finalizeGameMarketEvaluation splits correctly → HAS_OFFICIAL_PLAYS | PASS |
| 5b | LEANS_ONLY when no official plays | PASS |
| 5c | SKIP_MARKET_NO_EDGE when all non-input rejected | PASS |
| 6a | assertNoSilentMarketDrop throws on unbalanced partition | PASS |
| 6b | assertNoSilentMarketDrop does not throw on balanced partition | PASS |
| 7 | All REJECTED_INPUTS → SKIP_GAME_INPUT_FAILURE | PASS |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed null-card guard in buildResult field accessors**

- **Found during:** Task 2 (first test run)
- **Issue:** `buildResult` used pattern `(card && card.edge) !== undefined` — when `card=null`, `(null && null.edge)` evaluates to `null`, which `!== undefined` is true, so the ternary then attempted `null.edge` causing `TypeError: Cannot read properties of null`
- **Fix:** Changed accessors to `card != null && card.edge !== undefined ? card.edge : null` — explicit null check before property access
- **Files modified:** `packages/models/src/market-eval.js`
- **Commit:** 4495eaa

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1: market-eval.js implementation | 9574440 | feat(ime-01-01): create market-eval.js |
| Task 2: unit tests + bug fix | 4495eaa | test(ime-01-01): add 12 unit tests for market-eval.js |

## Self-Check: PASSED

- `packages/models/src/market-eval.js` exists: FOUND
- `packages/models/src/market-eval.test.js` exists: FOUND
- Commit 9574440 exists: FOUND
- Commit 4495eaa exists: FOUND
- `node -e "require('./packages/models/src/market-eval')"` → MODULE LOADS OK
- `npx jest packages/models/src/market-eval.test.js --no-coverage` → 12 passed, 0 failed
- No regressions in packages/models/ (91 tests pass, 0 fail; 2 pre-existing suite failures unrelated to this work)
