---
phase: quick-163
plan: "01"
subsystem: web/game-card/transform
tags: [typescript, dead-code, interface, refactor]
dependency_graph:
  requires: []
  provides: [canonical-ApiPlay-export]
  affects: [web/src/lib/game-card/transform/index.ts, web/src/lib/game-card/transform/legacy-repair.ts]
tech_stack:
  added: []
  patterns: [import-type-for-circular-safe-type-sharing]
key_files:
  modified:
    - web/src/lib/game-card/transform/index.ts
    - web/src/lib/game-card/transform/legacy-repair.ts
decisions:
  - Use `import type` (not plain `import`) to safely erase the dependency at compile time under isolatedModules=true and avoid circular module graph with index.ts
metrics:
  duration: "~5 minutes"
  completed: "2026-04-19"
  tasks_completed: 3
  files_modified: 2
---

# Phase quick-163 Plan 01: Fix Duplicate ApiPlay Interface in Legacy-Repair Summary

**One-liner:** Exported canonical `ApiPlay` from `transform/index.ts` and replaced the 88-line manually-synced local copy in `legacy-repair.ts` with `import type { ApiPlay } from './index'`.

## What Was Done

The `ApiPlay` interface existed in two places: as the canonical definition in `transform/index.ts` (with ~15 more optional fields) and as a manually-maintained copy in `legacy-repair.ts`. The copies had silently diverged.

This plan unified them:

1. Added `export` keyword to `ApiPlay` in `transform/index.ts` (line 153).
2. Added `import type { ApiPlay } from './index'` to the import block in `legacy-repair.ts`.
3. Deleted the entire 88-line local `ApiPlay` interface declaration plus its "must stay structurally compatible" comment from `legacy-repair.ts`.
4. Removed now-unused `CanonicalMarketType` and `DecisionV2` imports that were only referenced by the deleted local interface.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | `621bcbfd` | feat(quick-163-01): export ApiPlay from transform/index.ts |
| 2 | `7500ce6c` | feat(quick-163-01): replace local ApiPlay in legacy-repair.ts with import type |

## Verification Results

- `grep "export interface ApiPlay" web/src/lib/game-card/transform/index.ts` — matched at line 153
- `grep "interface ApiPlay" web/src/lib/game-card/transform/legacy-repair.ts` — no match (local declaration gone)
- `grep "import type.*ApiPlay" web/src/lib/game-card/transform/legacy-repair.ts` — matched `import type { ApiPlay } from './index'`
- `npm --prefix web run build` — exited 0, no TypeScript errors
- `npx tsx --test web/src/lib/game-card/transform/legacy-repair.test.ts` — 1 test passed, 0 failed

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing cleanup] Removed now-unused CanonicalMarketType and DecisionV2 imports**
- **Found during:** Task 2
- **Issue:** After deleting the local `ApiPlay` interface, `CanonicalMarketType` and `DecisionV2` were imported but no longer referenced in `legacy-repair.ts`. `ExpressionStatus` is still used by function bodies.
- **Fix:** Consolidated the two import lines into one: `import type { ExpressionStatus } from '../../types'`
- **Files modified:** `web/src/lib/game-card/transform/legacy-repair.ts`
- **Commit:** `7500ce6c` (included in Task 2 commit)

## Self-Check: PASSED

- [x] `web/src/lib/game-card/transform/index.ts` modified — confirmed `export interface ApiPlay` at line 153
- [x] `web/src/lib/game-card/transform/legacy-repair.ts` modified — confirmed local interface deleted, import type added
- [x] Commit `621bcbfd` exists
- [x] Commit `7500ce6c` exists
- [x] Build green
- [x] legacy-repair tests green (1/1 pass)
