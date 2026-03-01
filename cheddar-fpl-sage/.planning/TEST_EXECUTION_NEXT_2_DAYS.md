# Test Execution Plan (Next 2 Days)

Date: 2026-02-25
Scope: Requirements 2-8 (Requirement 1 auth endpoint deferred)

## Baseline

- Collected tests: 207
- Current failures: 14

## Priority Order

- [x] P0: Unblock CI signal by fixing script-style tests collected by pytest
  - Files:
    - tests/test_manager_name.py
    - tests/test_real_analysis.py
    - tests/test_transformer.py
  - Goal: these are opt-in real API smoke tests, not default CI blockers.

- [x] P1: Lock API contracts for requirements 2/3/4/5/8
  - Suites:
    - tests/test_analyze_api.py
    - tests/api_contract_suite.py
    - tests/test_planned_api_contracts.py
    - tests/tests_new/test_api_endpoints.py
    - tests/tests_new/test_api_integration.py
    - tests/tests_new/test_websocket_progress.py
  - Goal: status flow, health payload, websocket errors, error envelope.

- [x] P2: Add persistence/restart coverage for analysis job state
  - New suite target:
    - tests/tests_new/test_engine_job_persistence.py
  - Goal: Redis + fallback behavior for create/load/update job lifecycle.

- [x] P3: Tighten rate-limit and CORS guardrails
  - Suite:
    - tests/tests_new/test_rate_limiting.py
  - Goal: verify `429`, `Retry-After`, and standardized error payload.

- [x] P4: Implement and test requirement 6 (`GET /user/{user_id}/analyses`)
  - New suite target:
    - tests/tests_new/test_user_analysis_history.py

- [x] P5: Implement and test requirement 7 (`GET /user/{user_id}/performance`)
  - New suite target:
    - tests/tests_new/test_user_performance.py

- [x] P6: Resolve summary-format regressions after API contracts are green
  - Suites:
    - tests/test_section_a_fixes.py
    - tests/tests_new/test_chip_expiry_policy.py
    - tests/tests_new/test_summary_and_injury_filters.py
    - tests/tests_new/test_window_summary.py

## Execution Schedule

## Day 1

- P0 complete and verified.
- P1 API contract suite green.
- P2 scaffolding and persistence tests added.

## Day 2

- P3 guardrail tests added.
- P4/P5 endpoints implemented and contract tests activated.
- P6 summary regressions resolved.

## Commands

```bash
# Full baseline
pytest -q

# Priority 1 contract checks
pytest -q tests/test_analyze_api.py tests/api_contract_suite.py tests/test_planned_api_contracts.py tests/tests_new/test_api_endpoints.py tests/tests_new/test_api_integration.py tests/tests_new/test_websocket_progress.py

# Fast loop for new endpoint tests
pytest -q tests/tests_new/test_user_analysis_history.py tests/tests_new/test_user_performance.py
```

## Deferred (Post-Launch, Not MVP)

- Durable long-term analytics persistence for user history/performance
  - Launch scope keeps Redis + in-memory execution persistence.
  - Post-launch will introduce DB-backed retention for long-horizon analytics.
