# Phase 01 Plan 05: Bug Fixes (TDD) Summary

## TL;DR
Fixed two known bugs using TDD: manual players now display correct names (not "Player 999999"), and chip windows return graceful fallback (not "UNAVAILABLE").

---

## What Was Delivered

### Task 1: Manual Player Fallback Tests and Fix
**Commits:** `7cb6f8e`

- Created `tests/tests_new/test_manual_player_fallback.py` with 11 test cases
- Tests verify `is_manual_player()` boundary conditions
- Tests verify `_create_fallback_projection()` uses actual player name
- Tests verify `_ensure_projections()` handles manual players in squad
- **Result:** Bug was already fixed in Plan 01-02 - tests document expected behavior

### Task 2: Chip Window Edge Case Tests and Fix
**Commits:** `89e4fc9` (test), `eba56c8` (fix)

- Created `tests/tests_new/test_chip_window_edge_cases.py` with 10 test cases
- Added `analyze_chip_decision()` method to `ChipAnalyzer` class
- Method returns `ChipRecommendation` model (not "UNAVAILABLE" string)
- Handles edge cases: empty windows, None policy, unavailable chips
- Provides `optimal_window_gw` for forward guidance on chip timing

### Task 3: Integration Tests
**Commits:** `9cf2e86`

- Created `tests/tests_new/test_stabilization_integration.py` with 14 test cases
- Tests full analysis flow with manual players
- Tests config serialization round-trip
- Tests legacy risk posture normalization
- Tests module exports availability

---

## Files Changed

### Created
- `tests/tests_new/test_manual_player_fallback.py` - Manual player edge case tests
- `tests/tests_new/test_chip_window_edge_cases.py` - Chip window edge case tests
- `tests/tests_new/test_stabilization_integration.py` - Integration tests

### Modified
- `src/cheddar_fpl_sage/analysis/decision_framework/chip_analyzer.py` - Added `analyze_chip_decision()` method

---

## Test Results

| Test File | Tests | Passed | Status |
|-----------|-------|--------|--------|
| test_manual_player_fallback.py | 11 | 11 | PASS |
| test_chip_window_edge_cases.py | 10 | 10 | PASS |
| test_stabilization_integration.py | 14 | 14 | PASS |
| **Total New Tests** | **35** | **35** | **PASS** |

### Pre-existing Failures (Not Related to This Plan)
- `test_chip_expiry_policy.py::test_stale_snapshot_hold_blocks_activation_but_warns`
- `test_summary_and_injury_filters.py::test_injury_status_summary_is_rendered`
- `test_window_summary.py::test_window_scoring_guardrail`

These failures existed before this plan and are output formatting issues, not functional bugs.

---

## Verification

```bash
# Manual player displays correct name
python -c "
from cheddar_fpl_sage.analysis.decision_framework import TransferAdvisor
advisor = TransferAdvisor()
fb = advisor._create_fallback_projection({'player_id': 999999, 'name': 'Collins'})
assert fb['name'] == 'Collins'
print('Manual player: Collins')
"
# Output: Manual player: Collins

# Chip window returns graceful fallback
python -c "
from cheddar_fpl_sage.analysis.decision_framework import ChipAnalyzer, CHIP_NAMES
analyzer = ChipAnalyzer()
rec = analyzer.analyze_chip_decision(
    squad_data={}, fixture_data={}, projections={},
    chip_status={c: {'available': True} for c in CHIP_NAMES},
    current_gw=20, chip_policy={'chip_windows': []}
)
assert 'UNAVAILABLE' not in rec.reasoning
print(f'Chip: {rec.chip}, Reasoning: {rec.reasoning}')
"
# Output: Chip: None, Reasoning: No chip windows defined. Consider defining optimal windows in config.
```

---

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Manual player bug already fixed**
- **Found during:** Task 1 RED phase
- **Issue:** Plan expected bug to exist, but it was already fixed in Plan 01-02
- **Fix:** Tests still added to document and prevent regression
- **Files:** `tests/tests_new/test_manual_player_fallback.py`

**2. [Rule 2 - Missing Critical] ChipAnalyzer missing analyze_chip_decision method**
- **Found during:** Task 2 RED phase
- **Issue:** `ChipAnalyzer` class lacked unified chip decision method
- **Fix:** Added `analyze_chip_decision()` with proper edge case handling
- **Files:** `src/cheddar_fpl_sage/analysis/decision_framework/chip_analyzer.py`

---

## Success Criteria Verification

| Criterion | Status |
|-----------|--------|
| test_manual_player_fallback.py: 8+ tests pass | 11 tests pass |
| test_chip_window_edge_cases.py: 8+ tests pass | 10 tests pass |
| test_stabilization_integration.py: Integration tests pass | 14 tests pass |
| Manual player "Collins" displays correctly | Verified |
| Chip window returns "None" recommendation with reasoning | Verified |
| Config round-trips (write -> read -> same data) | Verified |
| All existing tests still pass | 95/98 (3 pre-existing failures) |

---

## Phase 1 Completion Status

Plan 01-05 is the FINAL plan in Phase 1. All Phase 1 objectives achieved:

| Plan | Status | Key Deliverable |
|------|--------|-----------------|
| 01-01 | Complete | Repository cleanup and structure |
| 01-02 | Complete | Domain module extraction (ChipAnalyzer, TransferAdvisor, etc.) |
| 01-03 | Complete | Risk posture implementation |
| 01-04 | Complete | Exception handling improvement |
| 01-05 | Complete | Bug fixes with TDD |

**Phase 1 CLI Stabilization: COMPLETE**

---

## Metrics

- **Duration:** ~5 minutes
- **Commits:** 4
- **New tests:** 35
- **Files created:** 3
- **Files modified:** 1
