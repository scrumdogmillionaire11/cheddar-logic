---
phase: quick-162
plan: "01"
subsystem: worker/models, worker/schedulers, web/components
tags: [dead-code, cleanup, tech-debt]
dependency_graph:
  requires: []
  provides: [clean-projections-exports, clean-quota-exports, clean-web-transform-import]
  affects: [apps/worker/src/models/projections.js, apps/worker/src/schedulers/quota.js, apps/worker/src/schedulers/main.js, web/src/components/cards/CardsPageContext.tsx]
tech_stack:
  added: []
  patterns: []
key_files:
  modified:
    - apps/worker/src/models/projections.js
    - apps/worker/src/models/__tests__/nba-projection-parity.test.js
    - apps/worker/src/models/__tests__/projections-gate.test.js
    - apps/worker/src/schedulers/quota.js
    - apps/worker/src/schedulers/main.js
    - web/src/components/cards/CardsPageContext.tsx
  deleted:
    - apps/worker/src/jobs/_archive/run_nfl_model.js
    - web/src/lib/game-card/transform.ts
decisions:
  - "Updated projections-gate.test.js (not in original plan scope) to replace 6 projectNBA behavioral tests with 1 absence assertion — required to make test suite pass after function deletion"
metrics:
  duration: "~15 minutes"
  completed: "2026-04-18"
  tasks_completed: 3
  files_changed: 8
---

# Quick Task 162: Dead Code Removal Sweep — Deprecated Exports Summary

**One-liner:** Deleted `projectNBA` function+export, `hasFreshOddsForModels` function+export, stale `_archive/run_nfl_model.js`, and `transform.ts` re-export shim; updated all test assertions and the CardsPageContext import path.

## Tasks Completed

| # | Task | Commit |
|---|------|--------|
| 1 | Delete projectNBA and hasFreshOddsForModels dead code | 24f0821a |
| 2 | Delete archive file, remove transform.ts shim, fix CardsPageContext import | b2b4e8c3 |
| 3 | Manual validation grep checks (no code changes) | — |

## Verification Results

- `grep "projectNBA\b" apps/worker/src --include="*.js"` — only test-assertion references remain (no production function body or export)
- `grep "hasFreshOddsForModels" apps/worker/src/schedulers/main.js` — returns nothing (PASS)
- `ls apps/worker/src/jobs/_archive/run_nfl_model.js` — No such file or directory (PASS)
- `ls web/src/lib/game-card/transform.ts` — No such file or directory (PASS)
- `npm --prefix apps/worker test -- projections-gate.test.js --runInBand` — 4/4 PASS
- `npm --prefix apps/worker test -- nba-projection-parity.test.js --runInBand` — 2/2 PASS
- `npm --prefix web run build` — exits 0, no type errors

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] projections-gate.test.js also called projectNBA directly**
- **Found during:** Task 1 verification
- **Issue:** `projections-gate.test.js` had a 6-test describe block invoking `projectNBA(...)` directly; deleting the function caused 6 test failures on first run
- **Fix:** Replaced the entire `projectNBA — WI-0820 input gate` describe block with a single absence-assertion test (`projectNBA is no longer exported`)
- **Files modified:** `apps/worker/src/models/__tests__/projections-gate.test.js`
- **Commit:** 24f0821a (included in same Task 1 commit)

## Self-Check: PASSED

- `apps/worker/src/models/projections.js` — exists, no `projectNBA` export
- `apps/worker/src/schedulers/quota.js` — exists, no `hasFreshOddsForModels` export
- `apps/worker/src/schedulers/main.js` — exists, no `hasFreshOddsForModels` import
- `apps/worker/src/jobs/_archive/run_nfl_model.js` — deleted (confirmed)
- `web/src/lib/game-card/transform.ts` — deleted (confirmed)
- `web/src/components/cards/CardsPageContext.tsx` — imports from `@/lib/game-card/transform/index`
- Commit 24f0821a — confirmed in git log
- Commit b2b4e8c3 — confirmed in git log
