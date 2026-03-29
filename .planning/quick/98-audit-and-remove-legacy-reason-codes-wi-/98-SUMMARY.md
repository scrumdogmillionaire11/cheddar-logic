---
phase: quick-98
plan: 01
subsystem: web/types, web/transform, worker/tests
tags: [cleanup, legacy-removal, types, reason-codes]
dependency_graph:
  requires: []
  provides: [clean-CanonicalPlay-interface, clean-reason-codes-set]
  affects: [web/src/lib/types/canonical-play.ts, web/src/lib/game-card/transform/reason-codes.ts, web/src/lib/types/game-card.ts]
tech_stack:
  added: []
  patterns: [grep-audit-before-delete, pre-existing-failure-isolation]
key_files:
  created: []
  modified:
    - web/src/lib/game-card/transform/reason-codes.ts
    - web/src/lib/types/canonical-play.ts
    - web/src/lib/types/game-card.ts
    - apps/worker/src/__tests__/fixtures/pipeline-card-payload/ncaam-pass-unrepairable-legacy.json
    - apps/worker/src/__tests__/integration/pipeline-card-payload.test.js
    - WORK_QUEUE/WI-0624.md
decisions:
  - "Pre-existing test failures (run-mlb-model.dual-run, sync_nhl_sog_player_ids) confirmed unrelated to this change — documented in WI-0624 completion note, not treated as regressions"
  - "CanonicalPlay legacy block removed cleanly — no callers required migration (transform/index.ts uses ApiPlay not CanonicalPlay for evidenceOnlyPlays; wave1DecisionPlay field accesses passed tsc without changes)"
metrics:
  duration: 12m
  completed_date: "2026-03-29"
  tasks_completed: 3
  files_changed: 6
---

# Phase quick-98 Plan 01: Audit and Remove Legacy Reason Codes (WI-0624) Summary

**One-liner**: Removed all 5 legacy reason codes (PASS_UNREPAIRABLE_LEGACY, LEGACY_REPAIR, etc.) from type definitions, guard sets, test fixtures — zero live emissions confirmed via full codebase audit.

## Tasks Completed

| Task | Name | Commit | Key Files |
| ---- | ---- | ------ | --------- |
| 1 | Full audit — confirm no live emission of the 5 legacy codes | 3113e2f | WORK_QUEUE/WI-0624.md |
| 2 | Remove legacy code references from type files and test fixtures | 6a9bc50 | reason-codes.ts, canonical-play.ts, game-card.ts, ncaam-pass-unrepairable-legacy.json, pipeline-card-payload.test.js |
| 3 | Verify TypeScript and worker tests pass | 1d33c5c | WORK_QUEUE/WI-0624.md |

## What Was Done

### Task 1 — Audit

Ran full grep across all `.ts`, `.js`, `.json` files (excluding node_modules, .next, WORK_QUEUE, docs, _bmad-output) for all 5 legacy codes:
- `PROXY_LEGACY_MARKET_INFERRED`
- `LEGACY_REPAIR`
- `LEGACY_TITLE_INFERENCE_USED`
- `PASS_UNREPAIRABLE_LEGACY`
- `REPAIRED_LEGACY_CARD`

Result: Zero live emission paths. `transform.ts` and `decision-pipeline-v2.js` were clean. Only 4 active references found — all type annotations, guard entries, or test fixtures. No hardening required.

### Task 2 — Removals

Four targeted changes:

1. **`reason-codes.ts`** — Removed `PASS_UNREPAIRABLE_LEGACY` (and its 2 backward-compat comments) from `NO_ACTIONABLE_IGNORE_REASON_CODES`. Set now contains only `PASS_MISSING_MARKET_TYPE`.

2. **`canonical-play.ts`** — Removed the entire LEGACY COMPATIBILITY block from the `CanonicalPlay` interface: `status`, `market`, `pick`, `lean`, `reason_codes`, `tags`. No callers required migration — `transform/index.ts` operates on `ApiPlay[]` (not `CanonicalPlay`) for evidence loops, and TypeScript passed with zero errors.

3. **`game-card.ts`** — Updated comment on `CanonicalApiPlay.reason_codes` line 266 from `"LEGACY_REPAIR"` example to `"PASS_DATA_ERROR"`.

4. **Test fixture + test** — `ncaam-pass-unrepairable-legacy.json`: renamed top-level key `legacy_play` → `play`, updated `reason_codes` from `["PASS_UNREPAIRABLE_LEGACY", "PASS_MISSING_MARKET_TYPE"]` to `["PASS_MISSING_MARKET_TYPE"]`. Test assertions updated to match.

### Task 3 — Verification

- `npx tsc --noEmit --project web/tsconfig.json` exits 0
- `npm --prefix apps/worker test`: 834 passed, 10 skipped, 3 failed — pre-existing failures confirmed via git stash before/after comparison (same 3 failures existed before any changes)

## Deviations from Plan

None — plan executed exactly as written. TypeScript compilation passed without requiring caller migration (the plan anticipated possible caller fixes but they were not needed).

## Decisions Made

**Decision 1**: Pre-existing test failures not treated as regressions.
The 3 failing tests (`run-mlb-model.dual-run`, `sync_nhl_sog_player_ids` x2) exist identically before and after this change. Verified by git stash isolation. Documented in WI-0624 completion note.

**Decision 2**: No caller migration needed for CanonicalPlay legacy field removal.
Despite `transform/index.ts` appearing to access `.reason_codes` and `.tags` on play objects, those objects are typed as `ApiPlay` (not `CanonicalPlay`), so removal of the CanonicalPlay legacy block had no TypeScript impact.

## Self-Check: PASSED

Files confirmed present:
- web/src/lib/game-card/transform/reason-codes.ts — FOUND
- web/src/lib/types/canonical-play.ts — FOUND
- web/src/lib/types/game-card.ts — FOUND
- apps/worker/src/__tests__/fixtures/pipeline-card-payload/ncaam-pass-unrepairable-legacy.json — FOUND
- apps/worker/src/__tests__/integration/pipeline-card-payload.test.js — FOUND

Commits confirmed:
- 3113e2f: chore(quick-98): audit legacy reason codes
- 6a9bc50: feat(quick-98): remove all 5 legacy reason codes
- 1d33c5c: chore(quick-98): mark WI-0624 complete
