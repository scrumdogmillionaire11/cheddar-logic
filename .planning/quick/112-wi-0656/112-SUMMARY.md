---
phase: quick
plan: 112
subsystem: cheddar-fpl-sage / draft-analysis
tags: [fpl, draft, audit, compare, api, tdd]
dependency_graph:
  requires: [WI-0654, WI-0655]
  provides: [WI-0656]
  affects: [WI-0659]
tech_stack:
  added: []
  patterns: [FastAPI router, Pydantic model_validator, archetype-weighted scoring, TDD RED/GREEN]
key_files:
  created:
    - cheddar-fpl-sage/backend/models/draft_analysis_api_models.py
    - cheddar-fpl-sage/backend/services/draft_audit.py
    - cheddar-fpl-sage/backend/services/draft_compare.py
    - cheddar-fpl-sage/backend/routers/draft_analysis.py
    - cheddar-fpl-sage/tests/test_draft_audit.py
    - cheddar-fpl-sage/tests/test_draft_compare.py
    - cheddar-fpl-sage/tests/test_draft_analysis_api.py
  modified:
    - cheddar-fpl-sage/backend/routers/__init__.py
    - cheddar-fpl-sage/backend/main.py
    - cheddar-fpl-sage/backend/exceptions.py
    - WORK_QUEUE/WI-0656.md
decisions:
  - Risk dimensions (fragility, correlation_exposure, exit_liquidity, time_to_fix) use inverted score for label thresholds — high raw score = bad outcome, label derived from 1-score
  - Archetype weighting uses a dict lookup for compare_drafts() winner determination — extensible without if-else chains
  - Session-based compare raises 422 requiring a prior /generate call — deferred until WI-0654's build persistence is confirmed
  - CompareRequest model_validator enforces either both session IDs or both inline builds — no mixed input
metrics:
  duration: ~35 minutes
  completed: "2026-03-30"
  tasks_completed: 2
  files_created: 7
  files_modified: 4
---

# Quick Task 112: WI-0656 — Draft Audit Scoring and Comparison APIs Summary

Draft audit scoring + comparison APIs: 8-dimension deterministic profile-aware squad scorer + archetype-weighted comparison engine, 38 tests, 2 new endpoints registered under /api/v1/draft-sessions.

## What Was Built

### Endpoints Registered

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/draft-sessions/{session_id}/audit` | Score a DraftBuild across 8 dimensions |
| POST | `/api/v1/draft-sessions/compare` | Compare two builds, return winner + deltas |

### Files Created

| File | Purpose |
|------|---------|
| `draft_analysis_api_models.py` | AuditRequest, AuditDimension, AuditResponse, CompareRequest (with model_validator), CompareDelta, CompareResponse |
| `draft_audit.py` | `score_audit(build, archetype) -> AuditResponse` — 8 deterministic dimension scorers |
| `draft_compare.py` | `compare_drafts(build_a, build_b, archetype) -> CompareResponse` — archetype-weighted winner |
| `draft_analysis.py` | FastAPI router with /audit and /compare endpoints |
| `test_draft_audit.py` | 14 tests: structure, philosophy_fit, fragility, correlation, captaincy, labels, determinism |
| `test_draft_compare.py` | 9 tests: winner determination, tie detection, archetype shift, delta structure |
| `test_draft_analysis_api.py` | 15 tests: 200/404/422 paths, archetype-aware commentary, response shapes |

### Test Count

- **38 tests total** across 3 test files
- **489 total tests** in the full suite — **0 regressions**

## Key Scoring Design Decisions

### Dimension Formulas

| Dimension | Formula | Risk or Positive? |
|-----------|---------|-------------------|
| `structure` | 1.0 - position_slot_penalty | Positive |
| `philosophy_fit` | Archetype-specific formula on differential/ownership fractions | Positive |
| `captaincy_strength` | avg(top 3 form×price) / 104.0 | Positive |
| `template_exposure` | fraction of starters with ownership_pct > 20 | Positive (context-dependent) |
| `fragility` | fraction of starters with is_differential or form < 4.0 | Risk (inverted for label) |
| `correlation_exposure` | max_club_count/11 + progressive penalty above 3 | Risk (inverted for label) |
| `exit_liquidity` | fraction of all 15 players with price < 6.0 | Risk (inverted for label) |
| `time_to_fix` | (locked_count + banned_hints) / 15 | Risk (inverted for label) |

### Archetype Weighting Strategy

`compare_drafts()` uses a static `_ARCHETYPE_WEIGHTS` dict keyed by archetype name. Each entry maps all 8 dimension names to float weights. Winner determination computes weighted vote totals:

- **Safe Template / Set-and-Hold**: weight structure, fragility, template_exposure (1.5×)
- **Aggressive Hunter**: weight philosophy_fit, captaincy_strength, exit_liquidity (1.5×)
- **Value/Flex Builder**: weight exit_liquidity (2.0×), time_to_fix (1.5×), philosophy_fit (1.5×)
- **Balanced Climber**: all weights equal (1.0×)

Same squad pair audited under Safe Template vs Aggressive Hunter produces:
- Different `philosophy_fit` commentary (template-focused vs ceiling-chasing language)
- Potentially different overall winner

### Label Inversion Pattern

For risk dimensions, `dim.score` is the raw risk measure (higher = worse). The label is derived from `1 - score` so that "0.0 fragility = strong (low risk)" and "0.9 fragility = weak (high risk)". This keeps downstream consumers able to compare scores numerically while labels remain intuitive.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Pydantic v2 validation error handler crashed on model_validator errors**
- **Found during:** Task 2 — test_compare_422_no_squads_or_sessions
- **Issue:** `exceptions.py` `validation_exception_handler` passed raw `errors` list (containing `ValueError` objects in `ctx` fields) to `JSONResponse`, causing `TypeError: Object of type ValueError is not JSON serializable`
- **Fix:** Added `_sanitize_validation_errors()` helper in `exceptions.py` that converts non-JSON-serializable `ctx` values to strings before serialization
- **Files modified:** `cheddar-fpl-sage/backend/exceptions.py`
- **Commit:** e3d02a4

**2. [Rule 1 - Bug] Test import issue: `from tests.test_draft_audit import _build_differential_squad` failed**
- **Found during:** Task 1 GREEN phase
- **Issue:** Cross-test import used a module path that resolves incorrectly from pytest's cwd
- **Fix:** Inlined the fixture as `_build_differential_squad_local()` in `test_draft_compare.py`
- **Files modified:** `cheddar-fpl-sage/tests/test_draft_compare.py`
- **Commit:** 1c10592

### Plan Adjustments

**Session-based compare deferred (design decision, not deviation):** The plan specified loading generated builds from sessions for the compare endpoint. Since WI-0654's build persistence stores constraints but not a generated DraftBuild snapshot, session-based compare raises 422 with a clear message directing callers to use inline squads or /generate first. This is documented in the endpoint and test coverage is adjusted accordingly (`test_compare_by_sessions` verifies the 422 behavior).

## Self-Check: PASSED

- All 7 created files: FOUND
- Commits 1c10592 and e3d02a4: FOUND
- 38 new tests passing, 489 total suite passing (0 regressions)
