---
phase: pass-reason-integrity
plan: "01"
subsystem: models
tags: [market-eval, contract, provenance, pass-no-edge, tdd]

# Dependency graph
requires: []
provides:
  - "Extended MarketEvalResult contract with 6 provenance fields: inputs_status, evaluation_status, raw_edge_value, threshold_required, threshold_passed, block_reasons"
  - "assertLegalPassNoEdge() exported enforcer that throws ILLEGAL_PASS_NO_EDGE on contract violations"
  - "SKIP_GAME_MIXED_FAILURES game-level status for mixed evaluation scenarios"
  - "assertNoSilentMarketDrop now calls assertLegalPassNoEdge on every result"
affects:
  - "pass-reason-integrity-02"
  - "pass-reason-integrity-03"
  - "health-monitor"
  - "discord-alerts"
  - "web-api"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Provenance fields on every MarketEvalResult enable downstream consumers to distinguish EDGE_COMPUTED from NO_EVALUATION"
    - "assertLegalPassNoEdge hard-throw pattern: called in assertNoSilentMarketDrop for every result"
    - "TDD: RED commit per scenario group, GREEN commit per task"

key-files:
  created:
    - "packages/models/src/__tests__/market-eval.test.js"
  modified:
    - "packages/models/src/market-eval.js"

key-decisions:
  - "buildResult() provenance defaults: inputs_status=COMPLETE, evaluation_status=NO_EVALUATION — conservative defaults require callers to explicitly supply EDGE_COMPUTED"
  - "PASS card with PASS_NO_EDGE gets evaluation_status=EDGE_COMPUTED (edge was computed, failed threshold); all other PASS pass_reason_codes get NO_EVALUATION (evaluation never ran)"
  - "SKIP_GAME_MIXED_FAILURES upgrades SKIP_MARKET_NO_EDGE only — if any rejected result has NO_EVALUATION, it means some candidates were never evaluated; this is a stricter signal than pure no-edge"
  - "test file placed in src/__tests__/ (jest testMatch) not src/ — stale src/market-eval.test.js left in place but not executed by Jest"

patterns-established:
  - "assertLegalPassNoEdge(result): check reason_codes for PASS_NO_EDGE, then validate provenance triple (evaluation_status=EDGE_COMPUTED, inputs_status=COMPLETE, raw_edge_value <= 0)"
  - "buildResult extra object carries all provenance; each evaluateSingleMarket path sets its own provenance explicitly"

requirements-completed:
  - PRI-CONTRACT-01
  - PRI-CONTRACT-02
  - PRI-CONTRACT-03

# Metrics
duration: 25min
completed: 2026-04-18
---

# Phase pass-reason-integrity Plan 01: MarketEvalResult Contract Extension Summary

**MarketEvalResult extended with 6 provenance fields making PASS_NO_EDGE a derived truth; assertLegalPassNoEdge hard-throw enforcer installed; SKIP_GAME_MIXED_FAILURES wired for mixed-evaluation game outcomes**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-04-18T00:00:00Z
- **Completed:** 2026-04-18T00:25:00Z
- **Tasks:** 2 (both TDD)
- **Files modified:** 2

## Accomplishments
- Extended `buildResult()` with `inputs_status`, `evaluation_status`, `raw_edge_value`, `threshold_required`, `threshold_passed`, `block_reasons` — every evaluation path now emits correct provenance
- Exported `assertLegalPassNoEdge()` which throws `ILLEGAL_PASS_NO_EDGE` when a result carries `PASS_NO_EDGE` but has a positive edge, NO_EVALUATION status, or MISSING inputs
- `assertNoSilentMarketDrop` calls `assertLegalPassNoEdge` on each result, closing the integrity gap
- `SKIP_GAME_MIXED_FAILURES` added to `VALID_STATUSES` (10th entry) and wired into `finalizeGameMarketEvaluation`
- 24 tests passing (15 pre-existing + 9 new scenarios F/F2/F3/G/G2/G3/K/L/VALID_STATUSES)

## Task Commits

Each task was committed atomically (TDD: RED then GREEN):

1. **Task 1 RED — Scenarios F/F2/F3 failing tests** - `35eb323a` (test)
2. **Task 1 GREEN — buildResult() 6 provenance fields** - `66f8db26` (feat)
3. **Task 2 RED — Scenarios G/G2/G3/K/L failing tests** - `31759095` (test)
4. **Task 2 GREEN — assertLegalPassNoEdge + SKIP_GAME_MIXED_FAILURES** - `696c8a6a` (feat)

_Note: TDD tasks have separate RED and GREEN commits per task._

## Files Created/Modified
- `packages/models/src/__tests__/market-eval.test.js` - Created in correct Jest testMatch location; 24 test scenarios covering full provenance contract
- `packages/models/src/market-eval.js` - Extended buildResult(), evaluateSingleMarket() provenance per path, assertLegalPassNoEdge(), VALID_STATUSES update, finalizeGameMarketEvaluation() SKIP_GAME_MIXED_FAILURES logic, updated exports

## Decisions Made
- buildResult() provenance defaults use `evaluation_status: 'NO_EVALUATION'` — conservative; callers must opt into `EDGE_COMPUTED` explicitly
- `PASS` card with `pass_reason_code === 'PASS_NO_EDGE'` is treated as `EDGE_COMPUTED` (edge was computed and was non-positive); all other `pass_reason_codes` yield `NO_EVALUATION` with `block_reasons`
- `SKIP_GAME_MIXED_FAILURES` only upgrades from `SKIP_MARKET_NO_EDGE`; games with qualified plays or leans are unaffected
- test file placed in `src/__tests__/` to match jest `testMatch` config; original `src/market-eval.test.js` (in wrong location) left in place since it is not executed by Jest

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Test file in wrong directory for Jest**
- **Found during:** Task 1 (RED phase setup)
- **Issue:** `src/market-eval.test.js` existed in `src/` but jest `testMatch` is `**/__tests__/**/*.test.js`; file was never executed
- **Fix:** Copied file to `src/__tests__/market-eval.test.js` and fixed import path (`./market-eval` → `../market-eval`)
- **Files modified:** `packages/models/src/__tests__/market-eval.test.js` (created)
- **Verification:** `npx jest --testPathPattern="market-eval"` found and ran 15 pre-existing tests
- **Committed in:** `35eb323a` (Task 1 RED commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Required for test discovery — no scope creep. The stale `src/market-eval.test.js` is harmless (not executed) but may confuse future devs; deferred to cleanup.

## Issues Encountered
None beyond the test file location deviation.

## Next Phase Readiness
- Contract layer is complete and enforced. Plans 02–03 can now add provenance-aware model fixes with confidence that `assertLegalPassNoEdge` will catch any regression.
- `assertLegalPassNoEdge` is exported and callable by all downstream consumers (health monitor, Discord, web API).
- `SKIP_GAME_MIXED_FAILURES` is in `VALID_STATUSES`; any consumer validating game status must handle this value.

---
*Phase: pass-reason-integrity*
*Completed: 2026-04-18*
