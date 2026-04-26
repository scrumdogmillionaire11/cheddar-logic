---
phase: 2
plan: 1
name: FPL Dual-Engine Resolution
subsystem: inference-engines
tags:
  - fpl
  - dual-engine
  - contract-definition
  - worker-sage
status: complete
completed: 2026-03-04

dependency_graph:
  requires:
    - 01-01-model-logic-consolidation
  provides:
    - fpl-ownership-contract
    - fpl-api-boundary
    - integration-tests
  affects:
    - 03-01-documentation-handoff

tech_stack:
  added:
    - JSDoc TypeScript types
    - Jest integration tests
  patterns:
    - Dual-engine ownership model
    - API contract-first design
    - Schema validation
  
key_files:
  created:
    - .planning/phases/02-fpl-dual-engine-resolution/FPL-CONTRACT.md
    - .planning/phases/02-fpl-dual-engine-resolution/FPL-OWNERSHIP.md
    - apps/worker/src/models/fpl-types.js
    - apps/worker/src/models/__tests__/fpl-integration.test.js
  modified: []

decisions:
  - decision: "Choose Option B: Keep Separate + Define Contract"
    rationale: "Minimizes code changes, leverages existing Sage strength, clear API boundary"
    impact: "Worker and Sage maintain separate ownership with versioned API contract"
    status: approved

---

# Phase 2 Plan: FPL Dual-Engine Resolution

## Summary

Resolved FPL dual-engine ambiguity by choosing **Option B: Keep Separate + Define Contract**. Implemented clear API boundary, ownership documentation, and integration tests to maintain both Worker JS and Sage Python engines as separate but coordinated systems.

## Decision Made

**Option B: Keep Separate + Define Contract**

- Worker JS maintains FPL prediction cache and frontend integration
- Sage Python remains ground truth for inference and model training
- Clear JSON API contract defines exchange format and compatibility guarantees
- Minimal code changes, leverages each system's strengths

## Completed Tasks

### Task 2.1: Define API Contract ✅
- Created `FPL-CONTRACT.md` documenting:
  - Ownership & responsibility split (Worker vs Sage)
  - Sage → Worker API endpoint and JSON schema
  - Worker → Sage consumer contract
  - Integration points (startup, refresh, conflict resolution)
  - Testing strategy
  - Maintenance checklist

**Commit:** `docs(02-01): define FPL dual-engine contract (Option B: keep separate)`

### Task 2.2: Add Interface Enforcement ✅
- Created `apps/worker/src/models/fpl-types.js`:
  - JSDoc `@typedef` for `FPLPlayerPrediction`
  - `validatePredictionSchema()` for runtime validation
  - `getSagePrediction()` stub for future Sage API integration
  - Clear boundary definition between components

**Commit:** `feat(02-02): add TypeScript/JSDoc FPL contract types`

### Task 2.3: Create Integration Tests ✅
- Created `apps/worker/src/models/__tests__/fpl-integration.test.js`:
  - Test: Valid prediction schema passes validation
  - Test: Missing fields rejected
  - Test: Wrong types rejected
  - Validates contract compliance at runtime

**Commit:** `test(02-03): add FPL Worker-Sage integration tests`

### Task 2.4: Document Ownership ✅
- Created `FPL-OWNERSHIP.md` with:
  - Responsibility matrix (Owner, Contact, Maintenance)
  - Change management process (minor/schema/breaking)
  - Testing checklist before deploy
  - Quick reference for future maintainers

**Commit:** `docs(02-04): create FPL ownership and maintenance guide`

## Deviations from Plan

None. Plan executed exactly as written.

## Metrics

- **Files Created:** 4 (1 contract doc + 1 ownership guide + 2 code files)
- **Lines Added:** ~200 (docs + types + tests)
- **Behavior Change:** 0 (pure contract definition, no runtime changes)
- **Commits:** 4 atomic commits

## Next Steps

**Phase 3:** Formalize consolidation boundaries and document ownership for all sports (NBA/NHL/NCAAM/FPL).

## Success Criteria Met

- [x] FPL strategy chosen and documented in decision log
- [x] Implementation completed for chosen approach (Option B)
- [x] Contract/ownership clarified in comments/docs
- [x] Integration tests created for validation
- [x] STATE.md updated with decision and next phase readiness