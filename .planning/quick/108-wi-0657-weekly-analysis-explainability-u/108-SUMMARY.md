---
phase: quick-108
plan: "01"
subsystem: fpl-sage-contract
tags: [fpl, contract, explainability, weekly-analysis, pydantic, tdd]
dependency_graph:
  requires: [WI-0652]
  provides: [WI-0657, weekly-explainability-contract]
  affects: [WI-0658]
tech_stack:
  added: []
  patterns: [additive-contract-extension, tdd-red-green, uuid4-receipt-id]
key_files:
  created:
    - cheddar-fpl-sage/tests/test_new_contract_models.py
    - cheddar-fpl-sage/tests/test_weekly_explainability_contract.py
    - cheddar-fpl-sage/tests/test_weekly_relative_risk.py
    - cheddar-fpl-sage/tests/test_planned_api_contracts.py
  modified:
    - cheddar-fpl-sage/backend/models/manual_overrides.py
    - cheddar-fpl-sage/backend/services/contract_transformer.py
decisions:
  - "All new contract fields use Optional with None defaults for strict backward compat"
  - "relative_risk falls back to strategy='mixed' when no rank/ownership context present"
  - "explainability returns a stub dict (not None) when absent from results"
  - "receipt_id is a freshly minted UUID4 on every contract build call for audit traceability"
  - "New test files force-added with git add -f due to test_*.py pattern in .gitignore"
metrics:
  duration: "7m 24s"
  completed: "2026-03-30"
  tasks_completed: 2
  files_changed: 6
  tests_added: 43
---

# Phase quick-108 Plan 01: Weekly Analysis Explainability Contract Summary

**One-liner:** Additive explainability/confidence_band/relative_risk/receipt_id fields injected into build_detailed_analysis_contract using Pydantic models and TDD with graceful fallbacks.

## What Was Built

The weekly FPL Sage analysis contract was upgraded with five additive fields surfacing the "why" behind recommendations:

- **confidence_band** — low/mid/high point estimate range with narrative; stubs to None fields when absent
- **scenario_notes** — list of upside/downside scenario dicts; stubs to empty list when absent
- **explainability** — structured why_this/why_not_alternatives/what_would_change/key_risk_drivers block; stubs to None fields when absent
- **relative_risk** — strategy (safe/attack/mixed), rank_context, ownership_context, guidance; defaults to strategy="mixed" when no context
- **receipt_id** — UUID4 minted fresh on every contract build for audit traceability

All fields are additive. Existing `/analyze/interactive` consumers see no changes to existing keys.

## Files Changed

| File | Change |
|------|--------|
| `backend/models/manual_overrides.py` | Added ConfidenceBand, ScenarioNote, ExplainabilityBlock, RelativeRiskFrame Pydantic models with Optional fields |
| `backend/services/contract_transformer.py` | Added `import uuid`, five helper functions, five new keys injected after "summary" |
| `tests/test_new_contract_models.py` | 18 TDD tests for new Pydantic model instantiation and model_dump round-trips |
| `tests/test_weekly_explainability_contract.py` | 14 tests: explainability key presence, pass-through, graceful fallback |
| `tests/test_weekly_relative_risk.py` | 11 tests: relative_risk strategy fallback, rank_context pass-through, receipt_id UUID4 |
| `tests/test_planned_api_contracts.py` | Extended with 2 new tests: new key presence + existing key preservation (backward compat) |

## Tests Added

- **43 total new tests** across 4 test files
- 18 model-layer tests (all-optional instantiation, field round-trips)
- 14 explainability contract tests (key presence, pass-through, None/missing fallbacks)
- 11 relative_risk + receipt_id tests (strategy default, UUID4 format, uniqueness per call)
- 2 backward compat tests in test_planned_api_contracts.py

## Key Decisions

1. All new Pydantic model fields use `Optional[X] = None` — backward compat for existing consumers.
2. `_build_relative_risk()` returns `strategy="mixed"` as default — safe neutral framing when no rank/ownership data.
3. `_build_explainability()` and `_build_confidence_band()` return stub dicts with None values (not None itself) — ensures consumers can safely access keys without guard checks.
4. `_mint_receipt_id()` called at contract build time (not stored) — provides audit traceability without DB schema changes.
5. New test files placed in `tests/` top-level (matching plan spec) and force-added via `git add -f` due to `test_*.py` gitignore pattern.

## Deviations from Plan

**None - plan executed exactly as written.**

## Discovered Issues (Out of Scope)

**Pre-existing failure:** `tests/test_analyze_api.py::test_post_analyze_can_return_cached_result` fails with `assert 202 == 200`. This is caused by a pre-existing uncommitted change in `backend/routers/analyze.py` that added `_cached_result_meets_fpl_contract()` validation, which causes the test's minimal mock payload `{"team_name": "Cached Team"}` to fail the contract check. This failure is NOT introduced by WI-0657 changes — confirmed by running the test with/without my changes stashed.

Logged to deferred items. Scoped to WI-0658 or a future fix WI.

## Self-Check

- [x] `backend/models/manual_overrides.py` — ConfidenceBand, ScenarioNote, ExplainabilityBlock, RelativeRiskFrame all importable
- [x] `backend/services/contract_transformer.py` — five helpers present, five new keys in payload
- [x] `tests/test_weekly_explainability_contract.py` — 14 tests pass
- [x] `tests/test_weekly_relative_risk.py` — 11 tests pass
- [x] `tests/test_planned_api_contracts.py` — backward compat assertions pass
- [x] Smoke print confirms all five new keys in output payload
- [x] 310 tests pass, 4 skipped, 0 regressions introduced

## Self-Check: PASSED
