---
phase: 61-wi-0536-canonical-edge-contract-unit-nor
plan: 61
type: quick
tags: [edge-contract, decision-gate, card-factory, decision-pipeline, unit-normalization, auditing]
dependency_graph:
  requires: []
  provides: [canonical-edge-contract, edge-units-auditing, null-edge-semantics]
  affects: [decision-gate, decision-pipeline-v2, decision-publisher, card-factory]
tech_stack:
  added: []
  patterns: [CANONICAL_EDGE_CONTRACT constant, edge_units metadata field, null-over-undefined convention]
key_files:
  created: []
  modified:
    - packages/models/src/decision-gate.js
    - packages/models/src/decision-pipeline-v2.js
    - packages/models/src/card-factory.js
    - apps/worker/src/utils/decision-publisher.js
    - apps/worker/src/utils/__tests__/decision-publisher.v2.test.js
decisions:
  - EDGE_UPGRADE_MIN=0.5 preserved as-is (50 percentage points); documented as decimal_fraction unit but value not changed per WI guard
  - p_fair also changed from undefined to null in card-factory for consistent null semantics
  - CANONICAL_EDGE_CONTRACT.upgrade_min=0.5 mirrors DEFAULTS.EDGE_UPGRADE_MIN exactly for single source of truth
metrics:
  duration: ~12 minutes
  completed: 2026-03-21T02:03:39Z
  tasks_completed: 3
  files_modified: 5
---

# Phase 61 Plan 61: WI-0536 Canonical Edge Contract and Unit Normalization Summary

**One-liner:** Declared CANONICAL_EDGE_CONTRACT (decimal_fraction unit) in decision-gate, fixed edge=undefined→null in card-factory NBA/NHL path, added edge_units metadata to decision events and pipeline output, with 3 new tests covering null-edge, explicit-edge, and decision_v2.edge_units coverage.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Declare CANONICAL_EDGE_CONTRACT in decision-gate | 60bb19d | packages/models/src/decision-gate.js |
| 2 | Fix card-factory edge=undefined→null; add edge_units to pipeline + publisher | c8aff8b | packages/models/src/card-factory.js, packages/models/src/decision-pipeline-v2.js, apps/worker/src/utils/decision-publisher.js |
| 3 | Add canonical edge contract tests | 258b8cc | apps/worker/src/utils/__tests__/decision-publisher.v2.test.js |

## Files Changed

### packages/models/src/decision-gate.js
- Added `CANONICAL_EDGE_CONTRACT` frozen object above `DEFAULTS` block:
  - `unit: 'decimal_fraction'`
  - `description: 'edge = p_fair - p_implied; 0.06 = 6% edge'`
  - `upgrade_min: 0.5`
  - `sources: ['decision_v2.edge_pct', 'payload.edge', 'null']`
- Added JSDoc to `hasFiniteEdge`: "Never treat null/undefined as 0"
- Added JSDoc to `shouldFlip` declaring edge unit contract (decimal_fraction, null required)
- Added inline comment to `EDGE_UPGRADE_MIN` explaining unit (decimal_fraction, 0.5 = 50pp improvement)
- Exported `CANONICAL_EDGE_CONTRACT` from `module.exports`

### packages/models/src/card-factory.js
- `buildBallSportPayload`: changed `edge: undefined` → `edge: Number.isFinite(descriptor.edge) ? descriptor.edge : null`
- `buildBallSportPayload`: changed `p_fair: undefined` → `p_fair: null`
- NBA/NHL cards now pass `null` (not `undefined`) when no edge is computed — `Number.isFinite(null)` correctly returns `false` downstream

### packages/models/src/decision-pipeline-v2.js
- Added `const EDGE_UNITS = 'decimal_fraction'` constant at top of file
- Added `edge_units: EDGE_UNITS` to `buildDecisionV2` return object (alongside `edge_pct`)
- Consumers can now verify they are reading a decimal_fraction field without guessing

### apps/worker/src/utils/decision-publisher.js
- Added `CANONICAL_EDGE_CONTRACT` to destructured require from `@cheddar-logic/models`
- Added `edgeUnits: CANONICAL_EDGE_CONTRACT.unit` to `insertDecisionEvent` call
- Decision events now include `edgeUnits: 'decimal_fraction'` for auditability

### apps/worker/src/utils/__tests__/decision-publisher.v2.test.js
- Extended existing `'publishDecisionForCard treats missing edge as unavailable'` test to also assert `edgeUnits: 'decimal_fraction'` in the event
- New test: `publishDecisionForCard emits edge_units=decimal_fraction in decision event for null-edge card` — NBA null-edge card calls insertDecisionEvent with candEdge: null + edgeUnits
- New test: `publishDecisionForCard emits edge_units=decimal_fraction in decision event for explicit edge` — explicit edge=0.07 → candEdge: 0.07 + edgeUnits
- New test: `applyUiActionFields populates decision_v2.edge_units as decimal_fraction for wave1 payload`

## CANONICAL_EDGE_CONTRACT Shape

```js
Object.freeze({
  unit: 'decimal_fraction',
  description: 'edge = p_fair - p_implied; 0.06 = 6% edge',
  upgrade_min: 0.5,
  sources: ['decision_v2.edge_pct', 'payload.edge', 'null'],
})
```

## New Test Names

1. `publishDecisionForCard emits edge_units=decimal_fraction in decision event for null-edge card`
2. `publishDecisionForCard emits edge_units=decimal_fraction in decision event for explicit edge`
3. `applyUiActionFields populates decision_v2.edge_units as decimal_fraction for wave1 payload`
4. Extended: `publishDecisionForCard treats missing edge as unavailable (not synthetic zero)` — now also asserts `edgeUnits: 'decimal_fraction'`

## Test Run Results

```
Tests: 36 passed, 36 total (33 prior + 3 new)
Test Suites: 1 passed
NBA regression: 6 passed
NHL regression: 10 passed
```

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written. The only minor addition was also fixing `p_fair: undefined → null` in card-factory alongside `edge: undefined → null`, as these are the same class of problem (undefined vs null for absent values). This was noted in the plan's action block.

## Decisions Made

1. **EDGE_UPGRADE_MIN value unchanged**: The threshold 0.5 (= 50 percentage points) is documented as intentionally conservative per WI guard. The `CANONICAL_EDGE_CONTRACT.upgrade_min` mirrors this value.
2. **p_fair also set to null**: Extended the fix beyond `edge` to include `p_fair` since both were `undefined` in the same code block — consistent null semantics across absent numeric fields.
3. **CANONICAL_EDGE_CONTRACT exported from models/index.js via spread**: No change to index.js needed; `...decisionGate` already spreads all exports.

## Self-Check: PASSED

- `packages/models/src/decision-gate.js` — FOUND, CANONICAL_EDGE_CONTRACT exported
- `packages/models/src/decision-pipeline-v2.js` — FOUND, edge_units in return
- `apps/worker/src/utils/decision-publisher.js` — FOUND, edgeUnits in insertDecisionEvent call
- Commits: 60bb19d, c8aff8b, 258b8cc — all present
- `grep 'edge: undefined' packages/models/src/card-factory.js` — no matches
- All 36 tests pass, NBA/NHL regressions pass
