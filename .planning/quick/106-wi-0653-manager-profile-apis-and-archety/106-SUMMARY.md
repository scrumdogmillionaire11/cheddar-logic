---
phase: quick
plan: 106-wi-0653-manager-profile-apis-and-archety
subsystem: cheddar-fpl-sage/backend
tags: [fpl-sage, manager-profile, archetype, fastapi, pydantic]
dependency_graph:
  requires: [WI-0652]
  provides: [WI-0653, manager-profile-api]
  affects: [WI-0654, WI-0659]
tech_stack:
  added: []
  patterns: [FastAPI APIRouter, Pydantic BaseModel, in-memory singleton service, TDD red-green]
key_files:
  created:
    - cheddar-fpl-sage/backend/models/profile_api_models.py
    - cheddar-fpl-sage/backend/services/profile_service.py
    - cheddar-fpl-sage/backend/routers/profiles.py
    - cheddar-fpl-sage/tests/test_profile_service.py
    - cheddar-fpl-sage/tests/test_profiles_api.py
  modified:
    - cheddar-fpl-sage/backend/routers/__init__.py
    - cheddar-fpl-sage/backend/main.py
decisions:
  - "In-memory store (dict) accepted per WI-0653 scope; Redis/DB persistence deferred to later WI"
  - "ARCHETYPE_RULES evaluated in strict priority order: Set-and-Hold > Aggressive Hunter > Value/Flex Builder > Balanced Climber > Safe Template (default)"
  - "profile_service module-level singleton reused across requests; tests instantiate fresh ProfileService() per setup_method to avoid cross-test pollution"
metrics:
  duration_seconds: 201
  completed_date: "2026-03-30"
  tasks_completed: 2
  tasks_total: 2
  files_created: 5
  files_modified: 2
---

# Quick Task 106 / WI-0653: Manager Profile APIs and Archetype Mapping — Summary

**One-liner:** FastAPI POST/GET/PATCH profile endpoints with deterministic five-archetype mapping via priority-ordered rules and per-archetype constraint defaults, backed by an in-memory singleton store.

---

## Objective

Implement manager profile CRUD APIs with a fixed onboarding question set that maps answers to one of five archetypes and emits per-archetype constraint defaults consumed by WI-0654 (draft builder) and WI-0659 (product shell).

---

## Files Created

| File | Purpose |
|------|---------|
| `backend/models/profile_api_models.py` | OnboardingAnswers, ManagerConstraints, ProfileCreateRequest, ProfilePatchRequest, ManagerProfile Pydantic models |
| `backend/services/profile_service.py` | map_answers_to_archetype, derive_constraints, ProfileService class, profile_service singleton |
| `backend/routers/profiles.py` | APIRouter: POST "", GET "/{user_id}", PATCH "/{user_id}" |
| `tests/test_profile_service.py` | 19 unit tests: archetype mapping, constraint derivation, CRUD |
| `tests/test_profiles_api.py` | 14 integration tests: all endpoints, status codes, immutability checks |

## Files Modified

| File | Change |
|------|--------|
| `backend/routers/__init__.py` | Added profiles_router import and __all__ entry |
| `backend/main.py` | Imported profiles_router and wired with app.include_router(profiles_router, prefix=settings.API_V1_PREFIX) |

---

## Archetype Mapping Rules (Priority Order)

| Priority | Archetype | Trigger Condition |
|----------|-----------|-------------------|
| 1 | Set-and-Hold | transfer_frequency="never" AND risk_tolerance="low" |
| 2 | Aggressive Hunter | risk_tolerance="high" AND transfer_frequency="often" AND differential_appetite="high" |
| 3 | Value/Flex Builder | budget_focus="high" AND bench_priority="low" |
| 4 | Balanced Climber | medium on >= 2 of: risk_tolerance, transfer_frequency, differential_appetite |
| 5 | Safe Template | Default fallback (all other combinations) |

---

## Constraint Defaults Per Archetype

| Archetype | risk | bench_preference | differentials | uncertainty_tolerance | early_transfer_tolerance |
|-----------|------|-----------------|---------------|-----------------------|-------------------------|
| Set-and-Hold | low | high | false | low | false |
| Aggressive Hunter | high | low | true | high | true |
| Value/Flex Builder | medium | low | false | medium | false |
| Balanced Climber | medium | medium | false | medium | false |
| Safe Template | low | high | false | low | false |

---

## API Endpoints

| Method | Path | Status Codes | Description |
|--------|------|-------------|-------------|
| POST | /api/v1/profiles | 201, 409, 422 | Create profile; 409 on duplicate user_id |
| GET | /api/v1/profiles/{user_id} | 200, 404 | Retrieve profile by user_id |
| PATCH | /api/v1/profiles/{user_id} | 200, 404 | Update answers; re-derives archetype; preserves user_id + created_at |

---

## Test Results

- **test_profile_service.py**: 19/19 passed
- **test_profiles_api.py**: 14/14 passed
- **Total**: 33/33 passed
- **Lint**: py_compile clean on all three new backend modules

---

## WI-0653 Acceptance Criteria Check

| Criterion | Status |
|-----------|--------|
| POST /api/v1/profiles creates profile with archetype assigned | DONE |
| GET /api/v1/profiles/{user_id} returns 200 for known, 404 for unknown | DONE |
| PATCH /api/v1/profiles/{user_id} updates preferences, preserves user_id and created_at | DONE |
| Archetype mapping is deterministic | DONE — pure function, no side effects |
| Five archetypes covered | DONE — Safe Template, Balanced Climber, Aggressive Hunter, Value/Flex Builder, Set-and-Hold |
| Per-archetype constraint defaults emitted | DONE — ARCHETYPE_CONSTRAINTS dict |
| No LLM interpretation — fixed rules only | DONE — Literal enum answers, rule-based only |

---

## Commits

| Hash | Message |
|------|---------|
| 86cd68d | feat(106-wi-0653-01): profile models, service, archetype mapping, and unit tests |
| 19187bd | feat(106-wi-0653-02): profiles router, main.py wiring, and API integration tests |

---

## Deviations from Plan

None — plan executed exactly as written.

---

## Self-Check: PASSED

- [x] `backend/models/profile_api_models.py` exists
- [x] `backend/services/profile_service.py` exists
- [x] `backend/routers/profiles.py` exists
- [x] `tests/test_profile_service.py` exists (19 tests pass)
- [x] `tests/test_profiles_api.py` exists (14 tests pass)
- [x] Commit 86cd68d exists
- [x] Commit 19187bd exists
