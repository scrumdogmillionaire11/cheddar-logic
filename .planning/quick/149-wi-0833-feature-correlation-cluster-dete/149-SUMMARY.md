---
phase: quick-149
plan: "01"
subsystem: audit/ci
tags: [correlation, ci-gate, feature-integrity, wI-0833]
dependency_graph:
  requires: [WI-0823, packages/models/src/feature-correlation.js]
  provides: [apps/worker/src/audit/feature_correlation_check.js, correlation_suppressions.json]
  affects: [worker CI job worker-tests]
tech_stack:
  added: []
  patterns: [three-tier-threshold, suppression-allowlist, git-log-expiry-check, testable-variant-pattern]
key_files:
  created:
    - apps/worker/src/audit/feature_correlation_check.js
    - apps/worker/src/audit/fixtures/correlation_suppressions.json
    - apps/worker/src/__tests__/feature-correlation-check.test.js
  modified: []
decisions:
  - "Use runCheckWithGitLog(gitLogOutput?) testable variant to avoid mocking child_process in tests"
  - "Correct relative path to feature-correlation.js is ../../../../packages/models/src/feature-correlation (4 levels up from apps/worker/src/audit/ and from apps/worker/src/__tests__/)"
  - "INFO-tier test arrays: x*0.5 + sin(x*1.5)*4 gives r=0.718; ALERT-tier: x + sin(x*2)*5 gives r=0.8496 — both verified deterministic"
metrics:
  duration_minutes: 12
  completed_date: "2026-04-11T16:36:43Z"
  tasks_completed: 2
  files_created: 3
  files_modified: 0
---

# Quick Task 149: WI-0833 Feature Correlation CI Gate Summary

**One-liner:** Three-tier Pearson r CI gate (INFO/ALERT/CRITICAL) with WI-string suppression expiry, auto-picked up by worker-tests job via `__tests__/` placement.

## What Was Built

### apps/worker/src/audit/feature_correlation_check.js

CommonJS module implementing the three-tier correlation check:

- `runCheck(sport, featureMatrix, featureNames, suppressions)` — delegates to `runCheckWithGitLog` with live git log
- `runCheckWithGitLog(sport, featureMatrix, featureNames, suppressions, gitLogOutput)` — pure/testable variant; accepts git log as string to avoid mocking
- `runBuildGate(results)` — throws `Error` listing all violations if `results.violations.length > 0`; returns `true` if clean

Tier logic:
| Tier | |r| range | Outcome |
|---|---|---|
| INFO | 0.60 – 0.79 | warnings[] only, never fails |
| ALERT | 0.80 – 0.89 | violations[] unless valid non-expired suppression |
| CRITICAL | >= 0.90 | violations[] always — suppressions ignored |

Suppression expiry: if `expires_after_wi` field is set, the git log output is searched for that WI string. If found, suppression is expired and the pair becomes a violation. `execSync` failure (non-git env) is caught; suppression is treated as unexpired (CI-safe).

### apps/worker/src/audit/fixtures/correlation_suppressions.json

Single entry: NHL `goalie_gsax` + `homeGoalieSavePct` suppressed pending WI-0823 unification, with `expires_after_wi: "WI-0823"`. WI-0823 is confirmed merged in git log — this suppression is intentionally expired. Any NHL goalie correlation at ALERT level will now fail the build, enforcing the unified signal path.

### apps/worker/src/__tests__/feature-correlation-check.test.js

8 Jest tests covering all success criteria. Picked up automatically by `testMatch: ['**/__tests__/**/*.test.js']` in worker jest config — no CI YAML changes needed.

## Test Results

```
PASS src/__tests__/feature-correlation-check.test.js
  feature_correlation_check — tier classification
    ✓ Test 1 — INFO pair: |r| ≈ 0.70 appears in warnings, not violations
    ✓ Test 2 — ALERT without suppression: |r| ≈ 0.83 appears in violations as ALERT
    ✓ Test 3 — ALERT with valid non-expired suppression: pair is NOT a violation
    ✓ Test 4 — CRITICAL always fails even when matching suppression present
  feature_correlation_check — suppression expiry
    ✓ Test 5 — Expired WI suppression: expires_after_wi="WI-0823" in git log → violation
  feature_correlation_check — runBuildGate
    ✓ Test 6 — runBuildGate throws when violations present, message contains feature names
    ✓ Test 7 — runBuildGate returns true when no violations
  feature_correlation_check — MLB synthetic fixture
    ✓ Test 8 — MLB xwoba_vs_hand + iso identical arrays → r=1.0 → CRITICAL violation

Tests: 8 passed, 8 total
```

Full worker suite: 126 suites passed, 1544 tests passed, 0 regressions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Incorrect relative path in plan spec**

- **Found during:** Task 1 (first test run)
- **Issue:** Plan spec said `require('../../packages/models/src/feature-correlation')`. Both `apps/worker/src/audit/` and `apps/worker/src/__tests__/` are 4 directory levels from the monorepo root, so the correct path is `../../../../packages/models/src/feature-correlation`.
- **Fix:** Updated both `feature_correlation_check.js` and the test file to use the correct 4-level relative path.
- **Files modified:** feature_correlation_check.js, feature-correlation-check.test.js

**2. [Rule 1 - Bug] Incorrect synthetic data formulas**

- **Found during:** Task 2 (first test run — sanity assertion throw)
- **Issue:** Plan spec's formula `x * 0.7 + Math.sin(x) * 2` for INFO tier gives r=0.941 (CRITICAL, not INFO). Plan's ALERT formula `x * 0.95 + Math.sin(x * 0.5) * 2.5` over 30 samples gives r=0.977 (CRITICAL, not ALERT).
- **Fix:** Computed correct deterministic formulas: INFO → `x * 0.5 + Math.sin(x * 1.5) * 4` (r=0.718); ALERT → `x + Math.sin(x * 2) * 5` (r=0.8496). Both verified stable before committing.
- **Files modified:** feature-correlation-check.test.js

## Commits

| Task | Commit | Message |
|---|---|---|
| Task 1 | a720f72 | feat(quick-149): feature correlation CI gate + suppression enforcement |
| Task 2 | aa2a9fc | test(quick-149): 8 Jest tests for feature correlation CI gate |

## Self-Check: PASSED

- FOUND: apps/worker/src/audit/feature_correlation_check.js
- FOUND: apps/worker/src/audit/fixtures/correlation_suppressions.json
- FOUND: apps/worker/src/__tests__/feature-correlation-check.test.js
- FOUND: commit a720f72
- FOUND: commit aa2a9fc
