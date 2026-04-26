---
phase: "WI-1108"
plan: "Phase 2: Runner Integration"
type: "auto"
autonomous: true
wave: 1
depends_on: ["WI-1108-PHASE1"]
---

# WI-1108 Phase 2: Runner Integration

## Objective

Integrate extracted helpers into runners while maintaining byte-for-byte parity and zero impact on betting outcomes.

## Context

**Completed in Phase 1:**
- settlement-annotation.js extracted (490 LOC, 12 functions + 3 primitives)
- recovery-flow.js extracted (280 LOC, 5 core functions)
- settlement-annotation.test.js created (29 tests, all passing)
- All 210 baseline + new tests passing
- Commit: b9baf6b3

**This phase:**
- Remove inline implementations from settle_pending_cards.js and run_mlb_model.js
- Import helpers and re-export from __private
- Verify fixture tests for parity
- Document integration outcome

## Success Criteria

- [ ] settle_pending_cards.js imports settlement-annotation helpers
- [ ] All settlement functions in __private re-export from helpers
- [ ] run_mlb_model.js imports recovery-flow helpers
- [ ] All existing 210 tests pass (no regressions)
- [ ] All fixture tests confirm byte-for-byte parity
- [ ] No TODO/FIXME markers introduced
- [ ] All commits follow task_commit_protocol

---

## Tasks

### Task 1: Update settle_pending_cards.js imports

**Type:** `auto`

**Description:**
Add import statement for settlement-annotation helpers at top of settle_pending_cards.js.

**Expected behavior:**
- Adds single require line: `const settlementAnnotation = require('./helpers/settlement-annotation');`
- Placed after existing package imports

**Verification:**
- File loads without syntax errors
- Import resolves correctly

---

### Task 2: Update settle_pending_cards.js __private exports

**Type:** `auto`

**Description:**
Update __private exports to re-export settlement-annotation functions instead of defining them inline.

**Functions to re-export from helpers:**
- normalizeSettlementPeriod
- extractSettlementPeriod
- deriveAndMergePeriodToken
- readFirstPeriodScores
- resolveDecisionBasisForSettlement
- normalizePlayerName
- resolvePlayerShotsActualValue
- gradeMlbPitcherKMarket
- gradeNhlPlayerShotsMarket
- gradeLockedMarket
- resolveSettlementMarketBucket
- computePnlUnits
- computePnlOutcome
- assertLockedMarketContext
- resolveNhlShotsSettlementContext
- resolvePitcherKProjectionSettlement
- resolveMlbPitcherKActualValue

**Expected behavior:**
- Changes each export from inline function to `settlementAnnotation.functionName`
- Example: `gradeLockedMarket: settlementAnnotation.gradeLockedMarket,`

**Verification:**
- All 210 tests still pass (no behavior change)
- Functions remain accessible from settle_pending_cards.__private

---

### Task 3: Remove inline settlement implementations from settle_pending_cards.js

**Type:** `auto`

**Description:**
Delete all inline function definitions that are now imported from settlement-annotation.js.

**Functions to remove:**
- All 17 functions listed in Task 2

**Expected behavior:**
- ~1700 LOC deleted (lines 48-1947 approx)
- settle_pending_cards.js shrinks from ~3100 LOC to ~1400 LOC
- Only core runner logic remains

**Verification:**
- All 210 tests still pass (same behavior, cleaner code)
- No undefined reference errors

---

### Task 4: Update run_mlb_model.js imports

**Type:** `auto`

**Description:**
Add import statement for recovery-flow helpers at top of run_mlb_model.js.

**Expected behavior:**
- Adds single require line: `const recoveryFlow = require('./helpers/recovery-flow');`
- Placed after existing package imports

**Verification:**
- File loads without syntax errors
- Import resolves correctly

---

### Task 5: Integrate recovery-flow into run_mlb_model.js execution flow

**Type:** `auto`

**Description:**
Replace inline recovery decision logic with call to `applyExecutionGateWithStaleRecoveryToMlbPayload()`.

**Expected behavior:**
- Locates current inline recovery logic (approx lines 588-750)
- Replaces with call to recovery-flow function with proper dependency injection
- Passes required callbacks: applyGateFn, appendReasonCodeFn, refreshOddsFn, dedupCache
- Maintains identical retry behavior and outcome

**Verification:**
- All 210 tests pass (no behavior change)
- Recovery logic remains functionally equivalent

---

### Task 6: Run full test suite

**Type:** `auto`

**Description:**
Execute all tests to confirm no regressions.

**Expected behavior:**
```
npm --prefix apps/worker run test -- \
  src/jobs/__tests__/settle_pending_cards.market-contract.test.js \
  src/jobs/__tests__/settle_pending_cards.ordering-guard.test.js \
  src/jobs/__tests__/run_mlb_model.test.js \
  src/jobs/helpers/__tests__/settlement-annotation.test.js \
  --runInBand
```

Result: 210/210 tests pass (0 failures, 0 regressions)

**Verification:**
- All suites pass
- No new errors or warnings
- Execution time ~1-2 seconds

---

### Task 7: Verify fixture parity

**Type:** `auto`

**Description:**
Create lightweight fixture tests to confirm pre/post outputs are byte-for-byte identical.

**Expected behavior:**
- Run controlled test fixtures through both inline and extracted versions
- Compare settlement outputs, P&L calculations, recovery decisions
- Document any discrepancies

**Verification:**
- All fixture comparisons pass (identical outputs)
- No behavioral drift detected

---

### Task 8: Final commit and cleanup

**Type:** `auto`

**Description:**
Commit integration work with proper message documenting parity guarantee.

**Expected behavior:**
- Git add all modified files
- Commit with message: `refactor(WI-1108): integrate settlement + recovery helpers into runners`
- Document: lines removed, tests passing, parity verified

**Verification:**
- Commit appears in git log
- All changes staged and committed

---

## Output Specification

**Generated files:**
- None (integration only)

**Modified files:**
- apps/worker/src/jobs/settle_pending_cards.js (imports helpers, re-exports, deletes inline code)
- apps/worker/src/jobs/run_mlb_model.js (imports helpers, integrates recovery flow)

**Test status:**
- 210/210 passing (settle_pending_cards, run_mlb_model, settlement-annotation tests)

**Commits:**
1. Task 1-3: `refactor(WI-1108): import settlement helpers + remove inline impls from settle_pending_cards`
2. Task 4-5: `refactor(WI-1108): import recovery helpers + integrate into run_mlb_model`
3. Task 6-8: `test(WI-1108): verify parity + finalize integration`

---

## Acceptance

This phase is complete when:
- ✅ All 210 tests pass (no regressions)
- ✅ All inline implementations removed
- ✅ Fixture tests confirm byte-for-byte parity
- ✅ No TODO/FIXME markers in touched files
- ✅ Integration commits recorded

**Outcome:** WI-1108 fully delivered with verified zero behavioral impact and ~1.7K LOC refactored into maintainable helper modules.
