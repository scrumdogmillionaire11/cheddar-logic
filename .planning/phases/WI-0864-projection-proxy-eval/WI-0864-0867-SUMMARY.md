---
phase: WI-0864-projection-proxy-eval
plan: WI-0864/0865/0866/0867
subsystem: model-accuracy
tags: [projection, proxy-eval, sqlite, worker, web-api, typescript]
requires: []
provides: [projection_proxy_evals table, proxy-line grading logic, worker settlement integration, web accuracy API]
affects: [settle_projections, projection_evaluator, packages/data, web API]
tech-stack:
  added: []
  patterns: [proxy-line grading, per-game tier scoring, consensus bonus, SQLite aggregation]
key-files:
  created:
    - packages/data/db/migrations/069_projection_proxy_evals.sql
    - packages/data/src/db/projection-accuracy.js
    - apps/worker/src/jobs/run_projection_accuracy_report.js
    - web/src/app/api/results/projection-accuracy/route.ts
    - web/src/lib/types/projection-accuracy.ts
  modified:
    - packages/data/index.js
    - apps/worker/src/audit/projection_evaluator.js
    - apps/worker/src/audit/__tests__/projection_evaluator.test.js
    - apps/worker/src/jobs/settle_projections.js
    - apps/worker/src/jobs/__tests__/settle_projections.test.js
    - web/src/types/cheddar-logic-data.d.ts
decisions:
  - "proxy-line grading uses half-integer lines only (no pushes): MLB_F5_TOTAL=[3.5,4.5], NHL_1P_TOTAL=[1.5]"
  - "consensus_bonus applies only to first row per game to avoid double-counting in SUM queries"
  - "proxy eval insert is non-fatal: settlement completes even if proxy eval write fails"
  - "run_projection_accuracy_report not scheduled — on-demand only (scheduler registration in follow-on WI)"
metrics:
  duration: "~90 minutes"
  completed: "2026-04-10"
---

# Phase WI-0864/0865/0866/0867: Projection Proxy Eval Sprint Summary

**One-liner:** Proxy-line grading for MLB F5 and NHL 1P projections — DB schema, grading logic, settlement integration, and web accuracy API route.

## Objective

Build the full stack for tracking whether model projections correctly favor OVER/UNDER at canonical proxy lines (3.5/4.5 for MLB F5, 1.5 for NHL 1P): schema → grading logic → settlement write → accuracy read API.

## Execution Summary

**Wave 1 (parallel, WI-0864 + WI-0865):**
- Created `069_projection_proxy_evals.sql` migration with per-game × per-line rows, UNIQUE(card_id, proxy_line) constraint, and 2 indexes
- Created `packages/data/src/db/projection-accuracy.js` with 4 functions: `insertProjectionProxyEval`, `batchInsertProjectionProxyEvals`, `getProjectionProxyEvals`, `getProjectionAccuracySummary`
- Re-exported all 4 from `packages/data/index.js`
- Added proxy-line grading constants and 7 functions to `projection_evaluator.js`: `classifyProxyEdge`, `gradeProxyMarket`, `scoreTierResult`, `resolveAgreementGroup`, `computeConsensusBonus`, `buildProjectionProxyMarketRows`, plus `CARD_TYPE_TO_FAMILY` mapping
- Fixed `MLB_PITCHER_K: return null` stub → `resolveMlbPitcherKActualValue(row)` reading `actual_result.pitcher_ks`
- Added 27 unit tests (all pass)

**Wave 2 (WI-0866 → WI-0867):**
- Wired `batchInsertProjectionProxyEvals` into `settle_projections.js` after `nhl-pace-1p` and `mlb-f5` settlement (non-fatal guard)
- Created `run_projection_accuracy_report.js` on-demand report job
- Added 4 proxy eval integration tests to `settle_projections.test.js` (26/26 pass)
- Created `web/src/app/api/results/projection-accuracy/route.ts` with GET, `?family=`, `?days=` params, 400 validation, ADR-0002-compliant read-only DB access
- Created `web/src/lib/types/projection-accuracy.ts` TypeScript interfaces
- Added `getProjectionAccuracySummary` to `cheddar-logic-data.d.ts`
- `npx tsc --noEmit`: 0 errors

## Test Results

| Suite | Result |
|---|---|
| projection_evaluator.test.js | 27/27 pass |
| settle_projections.test.js | 26/26 pass |
| packages/data db-modules-smoke | 17/17 pass |
| Full worker suite | 1413/1413 pass (112/115 suites; 3 skipped pre-existing) |
| tsc --noEmit | 0 errors |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test spec had incorrect tier for NHL 1P STRONG**
- **Found during:** WI-0865 test execution
- **Issue:** WI-0865 test spec said `proj=1.85, line=1.5` → "OVER STRONG WIN". Edge is 0.35 which is LEAN (0.25–0.50 band), not STRONG (≥0.75).
- **Fix:** Corrected test expectation to `tier: 'LEAN'`
- **Files modified:** `apps/worker/src/audit/__tests__/projection_evaluator.test.js`
- **Commit:** c2ebbd0

**2. [Rule 3 - Blocking] Pre-commit hook rejected require() in JSDoc comment**
- **Found during:** WI-0866 commit
- **Issue:** `run_projection_accuracy_report.js` JSDoc had `require('./apps/worker/src/jobs/run_projection_accuracy_report')` in an example comment. Pre-commit hook regex matched it as a broken require() path.
- **Fix:** Replaced with `node apps/worker/src/jobs/run_projection_accuracy_report.js` in plain text
- **Files modified:** `apps/worker/src/jobs/run_projection_accuracy_report.js`
- **Commit:** ec39a38

## Next Phase Readiness

- `projection_proxy_evals` table will be populated from the next settlement cycle after this branch merges
- `run_projection_accuracy_report.js` is ready for scheduler registration (follow-on WI)
- `GET /api/results/projection-accuracy` is live but has no UI page (follow-on WI)
- No blockers identified

## Human Verification Required

1. Live settlement test: Run `settle_projections` with an MLB F5 or NHL 1P card in the settlement window; verify `projection_proxy_evals` receives 2 rows (MLB) or 1 row (NHL)
2. API smoke: `curl localhost:3000/api/results/projection-accuracy` after first settlement cycle; expect `families` array with non-zero `total_games`
3. Accuracy report on-demand: `node apps/worker/src/jobs/run_projection_accuracy_report.js` should emit `event: PROJECTION_ACCURACY_REPORT` JSON lines without error
