---
phase: WI-0953
plan: 01
type: standard
autonomous: true
wave: 1
depends_on: ["WI-0950"]
requirements: []
---

# Plan: WI-0953-01 — Odds Snapshot Timestamp Provenance and Integrity Enforcement

**Objective:** Implement timestamp provenance tracking from odds ingest through runner execution. Create `resolveSnapshotAge` helper with explicit 4-level fallback chain, emit structured `TIMESTAMP_DIAGNOSTIC` logs for all resolution paths, detect monotonic violations, add 10 comprehensive test cases, and wire provenance metadata into execution envelope.

## Context

From [WORK_QUEUE/WI-0953.md](../../../WORK_QUEUE/WI-0953.md):

- Odds snapshot age must be deterministically resolved using explicit fallback chain (captured_at → pulled_at → updated_at → NOW())
- All resolution events must emit structured diagnostics for audit trail
- Execution envelope must include snapshot_timestamp metadata (raw fields + provenance)
- Depends on WI-0950 freshness contract being in place
- 10 test cases required covering valid, missing, malformed, and non-monotonic scenarios

## Tasks

### Task 1: Create resolveSnapshotAge helper in packages/data/src/db/odds.js

**Type:** auto

Create new exported helper function with these responsibilities:

- Input: `snapshotRow` object with captured_at, pulled_at, updated_at fields
- Implement 4-level fallback chain with validation at each step:
  - Level 1: captured_at (valid if not null, ISO 8601, UTC timezone, not future)
  - Level 2: pulled_at (if captured_at null/invalid)
  - Level 3: updated_at (if both above null/invalid)
  - Level 4: NOW() (last resort, status=DEGRADED)
- Detect non-monotonic violations (future timestamps, pulled < captured, updated < pulled)
- Return object:
  ```javascript
  {
    resolved_timestamp: string (ISO 8601 UTC),
    resolved_age_ms: number,
    source_field: string ("captured_at" | "pulled_at" | "updated_at" | "now"),
    status: string ("VALID" | "DEGRADED" | "MALFORMED" | "MONOTONIC_VIOLATION"),
    fields_inspected: object with each field's validation result,
    fallback_chain_executed: boolean,
    violations: array of violation descriptions,
    diagnostic: full diagnostic object for logging
  }
  ```
- Emit `[TIMESTAMP_DIAGNOSTIC]` structured log with JSON diagnostic object

**Files:**
- Modify: packages/data/src/db/odds.js

**Verification:**
- `node --check packages/data/src/db/odds.js`
- Function callable and returns expected shape

### Task 2: Wire resolveSnapshotAge into pull_odds_hourly.js ingest path

**Type:** auto

Update `pull_odds_hourly.js` to use the resolver:

- Import `resolveSnapshotAge` from packages/data/src/db/odds.js
- In the ingest path, after fetching odds snapshot, call `resolveSnapshotAge(snapshotRow)` for each snapshot
- Capture the diagnostic and emit `[TIMESTAMP_DIAGNOSTIC]` log
- Store resolved timestamp + provenance in snapshot for runner use
- Do NOT block on MONOTONIC_VIOLATION; log and continue

**Files:**
- Modify: apps/worker/src/jobs/pull_odds_hourly.js

**Verification:**
- `node --check apps/worker/src/jobs/pull_odds_hourly.js`
- Run ingest job and confirm `[TIMESTAMP_DIAGNOSTIC]` logs appear in output

### Task 3: Wire resolveSnapshotAge into run_mlb_model.js runner path

**Type:** auto

Update MLB runner to attach timestamp provenance to execution envelope:

- Import `resolveSnapshotAge` from packages/data/src/db/odds.js
- At execution envelope construction, resolve snapshot age from loaded odds
- Add `snapshot_timestamp` sub-object to execution_envelope (distinct from freshness_decision)
- Emit `[TIMESTAMP_DIAGNOSTIC]` log for the resolved timestamp
- Attach diagnostic to payload for audit

**Files:**
- Modify: apps/worker/src/jobs/run_mlb_model.js

**Verification:**
- `node --check apps/worker/src/jobs/run_mlb_model.js`
- Run MLB job and confirm execution_envelope includes snapshot_timestamp field

### Task 4: Wire resolveSnapshotAge into run_nhl_model.js runner path

**Type:** auto

Update NHL runner (same as MLB):

- Import `resolveSnapshotAge` from packages/data/src/db/odds.js
- At execution envelope construction, resolve snapshot age from loaded odds
- Add `snapshot_timestamp` sub-object to execution_envelope
- Emit `[TIMESTAMP_DIAGNOSTIC]` log for the resolved timestamp

**Files:**
- Modify: apps/worker/src/jobs/run_nhl_model.js

**Verification:**
- `node --check apps/worker/src/jobs/run_nhl_model.js`
- Run NHL job and confirm execution_envelope includes snapshot_timestamp field

### Task 5: Add 10 test cases to pull_odds_hourly.test.js

**Type:** auto

Add 10 boundary test cases to pull_odds_hourly test suite:

1. **Valid captured_at** — age from captured_at, status=VALID, no fallback
2. **Missing captured_at** — fallback to pulled_at, status=DEGRADED
3. **Both captured_at, pulled_at null** — fallback to updated_at, status=DEGRADED
4. **All null** — use NOW(), status=DEGRADED, age_ms ≈ 0
5. **Malformed ISO (date-only)** — captured_at="2026-04-15", fallback triggered, status=MALFORMED
6. **Malformed Unix epoch** — captured_at="1713200400", parse fails, status=MALFORMED
7. **Future timestamp** — captured_at future, rejected, status=MONOTONIC_VIOLATION
8. **Timezone normalization** — captured_at in IST, normalized to UTC, age calculated correctly
9. **Non-monotonic order** — captured, pulled, updated out of order, status=MONOTONIC_VIOLATION
10. **Near-zero age** — age_ms ~50ms when snapshot captured recently, status=VALID

Each test verifies diagnostic emission and fallback behavior.

**Files:**
- Modify: apps/worker/src/jobs/__tests__/pull_odds_hourly.test.js

**Verification:**
- `npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/pull_odds_hourly.test.js 2>&1 | grep -E "(PASS|FAIL|Tests:)"`

### Task 6: Add timestamp provenance tests to run_mlb_model.test.js

**Type:** auto

Add tests verifying snapshot_timestamp metadata in execution envelope:

- Test that snapshot_timestamp is attached to execution envelope
- Test that resolved_timestamp, resolved_age_ms, and resolved_source are present
- Test that diagnostic is present and structured correctly
- Verify MLB runner emits `[TIMESTAMP_DIAGNOSTIC]` logs

**Files:**
- Modify: apps/worker/src/jobs/__tests__/run_mlb_model.test.js

**Verification:**
- `npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/run_mlb_model.test.js 2>&1 | grep -E "(PASS|FAIL|Tests:)"`

### Task 7: Add timestamp provenance tests to run_nhl_model.test.js

**Type:** auto

Add tests verifying snapshot_timestamp metadata in execution envelope (same as MLB):

- Test that snapshot_timestamp is attached to execution envelope
- Test that resolved_timestamp, resolved_age_ms, and resolved_source are present
- Test that diagnostic is present and structured correctly
- Verify NHL runner emits `[TIMESTAMP_DIAGNOSTIC]` logs

**Files:**
- Modify: apps/worker/src/jobs/__tests__/run_nhl_model.test.js

**Verification:**
- `npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/run_nhl_model.test.js 2>&1 | grep -E "(PASS|FAIL|Tests:)"`

## Verification

After all tasks complete:

1. `npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/pull_odds_hourly.test.js src/jobs/__tests__/run_mlb_model.test.js src/jobs/__tests__/run_nhl_model.test.js` — all tests pass
2. Run `npm --prefix apps/worker run job:pull-odds` and verify `[TIMESTAMP_DIAGNOSTIC]` logs in output
3. Run MLB/NHL model jobs and verify `[TIMESTAMP_DIAGNOSTIC]` logs + snapshot_timestamp in execution_envelope
4. Inspect 10 recent payloads and confirm timestamp provenance fields present for all rows

## Success Criteria

- [x] resolveSnapshotAge helper exported and callable
- [x] All 7 source/test files modified per task scope
- [x] 10 boundary test cases added covering all scenarios (valid, missing, malformed, monotonic violations)
- [x] `[TIMESTAMP_DIAGNOSTIC]` logs emitting from ingest and runner paths
- [x] Execution envelope includes snapshot_timestamp metadata (distinct from freshness_decision)
- [x] All tests pass (CI green)
- [x] Manual validation: payloads inspected, diagnostics verified, no silent timestamp fallbacks

## Output Specification

After execution, confirm:

1. **Code changes:** All 7 files modified with timestamp resolution wiring
2. **Logs emitting:** Sample `[TIMESTAMP_DIAGNOSTIC]` logs from ingest and runner for each status (VALID, DEGRADED, MALFORMED, MONOTONIC_VIOLATION)
3. **Payload samples:** 2+ MLB + NHL execution envelopes with snapshot_timestamp metadata
4. **Test results:** All 10 cases passing; CI test suite green
