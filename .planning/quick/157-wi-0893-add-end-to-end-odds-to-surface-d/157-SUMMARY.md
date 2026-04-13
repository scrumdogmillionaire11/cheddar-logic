---
phase: quick-157
plan: 01
subsystem: worker-gate, api-diagnostics, transform, cards-ui
tags: [observability, drop-reason, diagnostics, worker, transform]
dependency_graph:
  requires: []
  provides:
    - execution-gate drop_reason shape with bounded taxonomy codes
    - API flowDiagnostics drop_summary in dev mode
    - transform_meta.drop_reason threaded to DisplayPlay
    - CardsPageContext diagnosticCards _drop_reason_code/_drop_reason_layer
    - projectionOnly diagnostic bucket distinct from noProjection
  affects:
    - apps/worker/src/jobs/execution-gate.js
    - apps/worker/src/jobs/run_nba_model.js
    - apps/worker/src/jobs/run_nhl_model.js
    - web/src/lib/games/route-handler.ts
    - web/src/lib/game-card/transform/index.ts
    - web/src/components/cards/CardsPageContext.tsx
    - web/src/components/cards/types.ts
    - web/src/lib/types/game-card.ts
    - web/src/components/cards/shared.ts
    - web/src/components/cards/SportDiagnosticsPanel.tsx
    - web/src/__tests__/api-games-missing-data-contract.test.js
tech_stack:
  added: []
  patterns:
    - bounded drop reason taxonomy with layer origin (worker_gate)
    - dev-mode diagnostics aggregation via buildDropSummary helper
    - additive metadata pattern (no existing fields changed)
key_files:
  created: []
  modified:
    - apps/worker/src/jobs/execution-gate.js
    - apps/worker/src/jobs/run_nba_model.js
    - apps/worker/src/jobs/run_nhl_model.js
    - web/src/lib/games/route-handler.ts
    - web/src/lib/game-card/transform/index.ts
    - web/src/components/cards/CardsPageContext.tsx
    - web/src/components/cards/types.ts
    - web/src/lib/types/game-card.ts
    - web/src/components/cards/shared.ts
    - web/src/components/cards/SportDiagnosticsPanel.tsx
    - web/src/__tests__/api-games-missing-data-contract.test.js
decisions:
  - Used additive metadata approach — drop_reason never modifies blocked_by or existing gate logic
  - mapBlockedByToDropReasonCode operates on primary blocked_by entry (first element) for bounded taxonomy
  - parsedDropReasons array collected inline during existing card parse loop to avoid second pass
  - buildDropSummary() defined inline near flowDiagnostics assembly to keep locality
  - projectionOnly bucket is a distinct bucket from noProjection — cards with PROJECTION_ONLY_EXCLUSION or pass_reason_code PROJECTION_ONLY are carved out
  - diagnosticCards map step guarded by diagnosticsEnabled flag to avoid overhead in production
metrics:
  duration: "~35 minutes"
  completed: "2026-04-12"
  tasks: 3
  files: 11
---

# Phase quick-157 Plan 01: WI-0893 End-to-End Drop Reason Ledger Summary

**One-liner:** Adds deterministic worker-gate drop reason taxonomy (MISSING_EDGE / NO_EDGE_AT_CURRENT_PRICE / PROJECTION_ONLY_EXCLUSION etc.) threaded from execution-gate through API diagnostics drop_summary, transform_meta, and CardsPageContext diagnostics surface with projectionOnly bucket distinct from noProjection.

## Objective

Provide end-to-end observability for why odds-backed candidates do not surface. Implements WI-0893: a bounded drop reason taxonomy with layer-origin codes, queryable in API dev-mode diagnostics and visible in CardsPageContext diagnostics mode.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Add normalized drop reason taxonomy to worker gate paths | f2195d4 | execution-gate.js, run_nba_model.js, run_nhl_model.js |
| 2 | Thread drop reasons through API diagnostics and transform contract | 62931e8 | route-handler.ts, transform/index.ts |
| 3 | Surface drop reason in diagnostics mode and add regression fixture | 4857ecb | CardsPageContext.tsx, types.ts, game-card.ts, shared.ts, SportDiagnosticsPanel.tsx, test |

## What Was Built

### Worker Gate Taxonomy (Task 1)

Added `mapBlockedByToDropReasonCode(blocked_by)` to `execution-gate.js` mapping the primary blocked_by entry to bounded codes:

- `NO_EDGE_COMPUTED` → `MISSING_EDGE`
- `NET_EDGE_INSUFFICIENT:*` → `NO_EDGE_AT_CURRENT_PRICE`
- `MODEL_STATUS_*` → `MODEL_STATUS_GATE`
- `CALIBRATION_KILL_SWITCH` → `CALIBRATION_GATE`
- `CONFIDENCE_BELOW_THRESHOLD:*` → `CONFIDENCE_GATE`
- `STALE_SNAPSHOT:*` → `STALE_SNAPSHOT_GATE`
- `NOT_BET_ELIGIBLE` → `NOT_BET_ELIGIBLE`
- `NOT_EXECUTABLE_PATH` → `PROJECTION_ONLY_EXCLUSION`
- default → `UNKNOWN_GATE`

`evaluateExecution()` now returns `drop_reason: { drop_reason_code, drop_reason_layer: 'worker_gate' }` on blocked, `null` on pass. Both NBA and NHL model runners attach `execution_gate.drop_reason` on all exit paths (early-exit and post-gateResult).

### API Diagnostics (Task 2)

In `route-handler.ts`:
- `parsedDropReasons` array accumulated during the existing card parse loop
- `buildDropSummary()` helper groups by code, counts, preserves layer
- `flowDiagnostics.drop_summary` exposed when `isDev`
- `execution_gate` optional field added to `Play` interface

In `transform/index.ts`:
- `execution_gate` optional field added to `ApiPlay` interface
- All three `transform_meta` blocks include `drop_reason` field

### Diagnostics Surface (Task 3)

- `TransformMeta` interface extended with optional `drop_reason` field
- `SportBuckets` and `DiagnosticBucket` types include `projectionOnly`
- `sportDiagnostics` memo routes `PROJECTION_ONLY_EXCLUSION` / `pass_reason_code === 'PROJECTION_ONLY'` to `projectionOnly` bucket instead of `noProjection`
- `diagnosticCards` memo adds `projectionOnly` filter case and maps `_drop_reason_code` + `_drop_reason_layer` onto entries when `diagnosticsEnabled`
- `BUCKET_LABELS` and `SportDiagnosticsPanel` updated to include projectionOnly column

### Regression Test

`api-games-missing-data-contract.test.js` extended with:
- Fixture A (survivor): `execution_gate.drop_reason === null`, no blocking reason code
- Fixture B (dropped): `drop_reason_code === 'NO_EDGE_AT_CURRENT_PRICE'`, `drop_reason_layer === 'worker_gate'`
- Source-level assertions for `_drop_reason_code` in CardsPageContext and `drop_summary` in route-handler

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Added projectionOnly to BUCKET_LABELS and SportDiagnosticsPanel**
- **Found during:** Task 3 (build failure)
- **Issue:** TypeScript build failed — `DiagnosticBucket` is now wider than `BUCKET_LABELS` record keys, and `SportDiagnosticsPanel` did not render the new bucket
- **Fix:** Extended `BUCKET_LABELS` record type and value with `projectionOnly: 'Projection only'`; added projectionOnly column header and bucket key to `SportDiagnosticsPanel` iteration; updated totalBlocked sum to include `projectionOnly`
- **Files modified:** web/src/components/cards/shared.ts, web/src/components/cards/SportDiagnosticsPanel.tsx
- **Commit:** 4857ecb

## Self-Check

- [x] All task commits present: f2195d4, 62931e8, 4857ecb
- [x] execution-gate.js exports mapBlockedByToDropReasonCode
- [x] route-handler.ts contains drop_summary
- [x] transform/index.ts contains drop_reason (5 occurrences)
- [x] CardsPageContext.tsx contains _drop_reason_code and _drop_reason_layer
- [x] Test passes: node --import tsx/esm web/src/__tests__/api-games-missing-data-contract.test.js
- [x] npm --prefix web run build succeeds with no type errors
