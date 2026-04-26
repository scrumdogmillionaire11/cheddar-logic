---
phase: WI-0950
plan: 01
type: standard
autonomous: true
wave: 1
depends_on: []
requirements: []
---

# Plan: WI-0950-01 — Execution Gate Freshness Contract Implementation

**Objective:** Replace hardcoded 5-minute absolute freshness threshold with cadence-aligned contract. Implement three-tier freshness logic (FRESH / STALE_VALID / EXPIRED), export contract for dependent WIs, retire duplicate constants, add comprehensive boundary tests.

## Context

From [WORK_QUEUE/WI-0950.md](../../../WORK_QUEUE/WI-0950.md):

- Current system blocks valid edges due to unrealistic 5-minute stale threshold ignoring scheduler reality
- Solution: align gate to known odds-pull cadence (60m) + grace window (1.25x = 75m) + hard-max (120m)
- Four files to touch: execution-gate.js, new execution-gate-freshness-contract.js, execution-gate.test.js, check_pipeline_health.js
- Result: no silent edge loss, observability via structured logging

## Tasks

### Task 1: Create execution-gate-freshness-contract.js

**Type:** auto

Create new contract module exporting:

- `ExecutionFreshnessContract` type with fields: cadenceMinutes, graceMultiplier, hardMaxMinutes, allowStaleIfNoNewOdds
- Sport-specific defaults: MLB, NHL, NBA (all 60m cadence, 1.25x grace, 120m hardMax)
- `getContractForSport(sport)` helper
- `parseContractFromEnv()` to parse EXECUTION_FRESHNESS_CONTRACT env var, with warning on malformed
- Documented rationale for each constant

**Files:**
- Create: apps/worker/src/jobs/execution-gate-freshness-contract.js

**Verification:**
- `node --check apps/worker/src/jobs/execution-gate-freshness-contract.js`
- Exports exist and are callable

### Task 2: Implement Three-Tier Freshness Logic in execution-gate.js

**Type:** auto

Update `evaluateExecution()` function:

- Import `getContractForSport` from contract module
- Calculate thresholds: cadenceMs, thresholdMs, hardMaxMs
- Implement three-tier logic: FRESH (no block), STALE_VALID (block only if flag false), EXPIRED (always block)
- Update blocked_by reasons to distinguish VALID_WITHIN_CADENCE vs EXPIRED_HARDMAX
- Add `freshness_decision` to return object with metadata
- Preserve all existing gate logic

**Files:**
- Modify: apps/worker/src/jobs/execution-gate.js

**Verification:**
- `node --check apps/worker/src/jobs/execution-gate.js`

### Task 3: Add Boundary Tests to execution-gate.test.js

**Type:** auto

Add 9 new boundary test cases:

1. FRESH 30s → PASS
2. FRESH 30m → PASS
3. STALE_VALID at 60m → PASS
4. STALE_VALID at 60m 1s → PASS
5. STALE_VALID at 75m → PASS
6. STALE_VALID at 90m with flag → PASS
7. STALE_VALID at 120m → PASS
8. EXPIRED at 121m → FAIL
9. EXPIRED at 130m → FAIL

Each test verifies tier value and blocked_by_freshness flag.

**Files:**
- Modify: apps/worker/src/jobs/__tests__/execution-gate.test.js

**Verification:**
- `npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/execution-gate.test.js`

### Task 4: Update check_pipeline_health.js to Use Contract

**Type:** auto

- Import `getContractForSport` from contract module
- Retire local MODEL_FRESHNESS_MAX_AGE_MINUTES definition
- Replace usages with contract.hardMaxMinutes * 4
- Add inline comment cross-referencing contract file

**Files:**
- Modify: apps/worker/src/jobs/check_pipeline_health.js

**Verification:**
- `node --check apps/worker/src/jobs/check_pipeline_health.js`
- Grep for MODEL_FRESHNESS_MAX_AGE_MINUTES returns 0 results

### Task 5: Integration Tests — Existing Model Runners

**Type:** auto

Verify no regressions in runner job tests:

- run_mlb_model.test.js
- run_nhl_model.test.js
- calibration.test.js

**Files:**
- No modifications (verify only)

**Verification:**
- All existing model tests pass

## Success Criteria

- All files compile without errors
- Contract module exports callable helpers with sport-specific defaults
- Three-tier logic unambiguously distinguishes STALE_VALID from EXPIRED
- Nine boundary tests provide coverage
- Structured logging includes freshness_decision with tier metadata
- check_pipeline_health.js imports contract, retires local constant
- All existing gate tests pass (no regressions)
- All runner job tests pass (no regressions)

## Notes

- Contract Export: getContractForSport(sport) is the single source of truth for all freshness thresholds
- Anti-Silencing: allowStaleIfNoNewOdds=true is the critical rule preventing valid edges from being suppressed
- Env Var Override: EXECUTION_FRESHNESS_CONTRACT env var allows ops to hotpatch thresholds without redeployment
- Logging: [EXECUTION_GATE_FRESHNESS] log line per decision for observability
