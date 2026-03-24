---
phase: quick-79
plan: "01"
subsystem: decision-pipeline
tags: [quarantine, nba, totals, demotion, feature-flag]
dependency_graph:
  requires: []
  provides: [NBA_TOTAL_QUARANTINE_DEMOTE reason code, QUARANTINE_NBA_TOTAL flag]
  affects: [decision-pipeline-v2, official_status for NBA TOTAL markets]
tech_stack:
  added: [jest in @cheddar-logic/models devDependencies]
  patterns: [post-status demotion gate, pure-function patch module pattern]
key_files:
  created:
    - packages/models/src/__tests__/decision-pipeline-v2-nba-total-quarantine.test.js
  modified:
    - packages/models/src/flags.js
    - packages/models/src/decision-pipeline-v2.patch.js
    - packages/models/src/decision-pipeline-v2.js
    - packages/models/package.json
decisions:
  - "Demotion placed after heavyFavoriteGateFailed block so primary_reason_code resolution already sees demoted status"
  - "Flag defaults true (quarantine ON) without requiring explicit env var; set QUARANTINE_NBA_TOTAL=0 to disable"
  - "applyNbaTotalQuarantine lives in the patch file, not the main pipeline, matching the established patch-module pattern"
metrics:
  duration: "~7 minutes"
  tasks_completed: 3
  files_modified: 5
  completed_date: "2026-03-24"
---

# Phase quick-79 Plan 01: NBA Totals Quarantine (Demote-Tier) Summary

**One-liner:** Reversible NBA totals quarantine using a post-status demotion gate (PLAY→LEAN, LEAN→PASS) gated behind QUARANTINE_NBA_TOTAL flag (defaults ON), emitting NBA_TOTAL_QUARANTINE_DEMOTE reason code.

## What Was Built

An immediate, reversible quarantine for NBA total markets that demotes actionable decision tiers one level in the decision pipeline. The quarantine is a pure function applied as a post-status block after the existing `heavyFavoriteGateFailed` logic, before `primary_reason_code` resolution.

**Key mechanism:** `applyNbaTotalQuarantine({ sport, marketType, officialStatus, priceReasonCodes })` demotes PLAY→LEAN and LEAN→PASS for NBA:TOTAL while leaving PASS, NHL:TOTAL, NBA:SPREAD, and all other sport/market combinations untouched.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add QUARANTINE_NBA_TOTAL flag + applyNbaTotalQuarantine() | 5335206 | flags.js, decision-pipeline-v2.patch.js, test file, package.json |
| 2 | Wire applyNbaTotalQuarantine into decision-pipeline-v2.js | 28443b1 | decision-pipeline-v2.js |
| 3 | Integration regression tests + web test suite | a9f3ab7 | test file (expanded) |

## Verification

All three required test commands pass:

1. `npm --prefix packages/models test -- --testPathPattern=nba-total-quarantine` — 13 tests pass (8 unit + 5 integration)
2. `npm --prefix web run test:card-decision` — passes clean
3. `npm --prefix web run test:decision:canonical` — 32/32 pass

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing infrastructure] Added jest config to @cheddar-logic/models**
- **Found during:** Task 1 (RED phase)
- **Issue:** models package had no test script, jest config, or jest dev dependency; could not run `npm --prefix packages/models test`
- **Fix:** Added jest@^29.7.0 devDependency, `"test": "jest"` script, and inline jest config to package.json
- **Files modified:** packages/models/package.json, packages/models/package-lock.json
- **Commit:** 5335206

## Flag Usage

To disable the quarantine and restore prior NBA TOTAL behavior:

```
QUARANTINE_NBA_TOTAL=0
```

To re-enable (or use the default ON state), either omit the variable or set it to `1`/`true`/`yes`.

## Self-Check: PASSED

- [x] `packages/models/src/flags.js` — FLAGS.QUARANTINE_NBA_TOTAL exists, defaults true
- [x] `packages/models/src/decision-pipeline-v2.patch.js` — applyNbaTotalQuarantine exported
- [x] `packages/models/src/decision-pipeline-v2.js` — WI-0588 comment + demotion block present
- [x] `packages/models/src/__tests__/decision-pipeline-v2-nba-total-quarantine.test.js` — 13 tests pass
- [x] Commits 5335206, 28443b1, a9f3ab7 exist
- [x] WORK_QUEUE/COMPLETE/WI-0588.md moved
