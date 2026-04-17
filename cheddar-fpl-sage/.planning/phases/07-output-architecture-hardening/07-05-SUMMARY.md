---
phase: 07-output-architecture-hardening
plan: 05
subsystem: backend-contracts
completed_at: 2026-04-17T16:05:00Z
tags:
  - canonical-cards
  - dashboard
  - api-contract
requires:
  - 07-02
  - 07-04
provides:
  - canonical-first contract transformer paths
  - canonical-first dashboard assembly paths
affects:
  - cheddar-fpl-sage/backend/services/contract_transformer.py
  - cheddar-fpl-sage/backend/routers/dashboard.py
  - cheddar-fpl-sage/tests/test_analyze_api.py
  - cheddar-fpl-sage/tests/tests_new/test_api_endpoints.py
tech_stack:
  added: []
  patterns:
    - Canonical card metrics extraction helpers
    - Compatibility fallbacks for legacy fields
key_files:
  created:
    - .planning/phases/07-output-architecture-hardening/07-05-SUMMARY.md
  modified:
    - backend/services/contract_transformer.py
    - backend/routers/dashboard.py
    - tests/test_analyze_api.py
    - tests/tests_new/test_api_endpoints.py
    - config/team_config.json
decisions:
  - Contract and dashboard transformations now source canonical cards first, then compatibility fields.
  - Dashboard weak-signal/risk summaries include weekly retrospective drift flags when available.
metrics:
  duration: "~35m implementation + verification"
  tasks_completed: 2
  files_touched: 5
  verification_commands:
    - PYTHONPATH=. pytest tests/test_analyze_api.py -q
    - PYTHONPATH=. pytest tests/tests_new/test_api_endpoints.py -q
---

# Phase 07 Plan 05: Downstream Canonical Consumer Migration Summary

Canonical-card ownership was extended to downstream contract/dashboard consumers so API payload assembly no longer re-derives transfer, chip, and captain logic from mixed legacy blobs.

## Tasks Completed

1. Task 1: Convert contract transformer to consume canonical cards

- Updated transformer extraction to prefer `gameweek_plan`, `transfer_recommendation`, `captaincy`, `chip_strategy`, `squad_state`, `weekly_review`, and `decision_confidence` card payloads.
- Preserved behavior compatibility with legacy fallback fields for external clients.
- Added API regression coverage in `tests/test_analyze_api.py` for canonical card-driven status payload rendering.
- Verification passed: `PYTHONPATH=. pytest tests/test_analyze_api.py -q`.
- Commit: `db18b592`.

1. Task 2: Convert dashboard router to canonical-card sourcing

- Replaced dashboard assembly paths to consume canonical card metrics directly (gameweek, transfer targets, chip/captain advice, team weaknesses).
- Added canonical helper functions and compatibility fallback logic for running/legacy payloads.
- Added dashboard endpoint regression coverage in `tests/tests_new/test_api_endpoints.py`.
- Verification passed: `PYTHONPATH=. pytest tests/tests_new/test_api_endpoints.py -q`.
- Commit: `db18b592`.

## Additional Verification

- Contract inspection script validated detailed + dashboard contract output wiring from canonical cards.
- Observed expected quick actions and captain recommendation values in generated contract output.

## Deviations from Plan

### Auto-fixed Issues

None.

### Execution Notes

- A single existing implementation commit (`db18b592`) already contained both task file groups when continuation resumed.
- That commit also included `config/team_config.json`, which is outside the 07-05 plan file list.

## Auth Gates

None.

## Deferred Issues

None.

## Self-Check: PASSED

- FOUND: .planning/phases/07-output-architecture-hardening/07-05-SUMMARY.md
- FOUND: db18b592
