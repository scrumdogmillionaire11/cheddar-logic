---
phase: quick
plan: 53
subsystem: nhl-shots-pipeline
tags: [nhl, shots, pp-toi, tdd, bugfix, enrichment]
dependency_graph:
  requires: []
  provides: [ppToi-in-rawData, real-toi_proj_pp-in-projectSogV2]
  affects: [pull_nhl_player_shots, run_nhl_player_shots_model, projectSogV2]
tech_stack:
  added: []
  patterns: [TDD red-green, rawData enrichment pipeline, safe numeric guard]
key_files:
  created: []
  modified:
    - apps/worker/src/jobs/pull_nhl_player_shots.js
    - apps/worker/src/jobs/run_nhl_player_shots_model.js
    - apps/worker/src/jobs/__tests__/pull_nhl_player_shots.test.js
    - apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js
decisions:
  - "Safe fallback: ppToi=null in enrichedRawData becomes toi_proj_pp=0 in model (no regression for non-PP players or legacy rows)"
  - "Guard: Number.isFinite(rawData.ppToi) && rawData.ppToi > 0 prevents NaN/null/0 from leaking into projectSogV2"
metrics:
  duration: "~20 minutes"
  completed: "2026-03-20"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 4
  tests_added: 6
  tests_total_after: 61
---

# Quick Task 53: Fix PP TOI Gap — Replace Hardcoded toi_proj_pp: 0

**One-liner:** Real PP TOI (avgPpToi from NHL API subSeason) now flows from pull→store→projectSogV2, replacing the hardcoded zero that suppressed PP-heavy player shot projections.

## What Was Done

PP-heavy players (power play units 1 and 2) were being systematically underprojected because `toi_proj_pp` was hardcoded to `0` in `run_nhl_player_shots_model.js`. The fix is a two-part pipeline:

1. **pull_nhl_player_shots.js** now extracts `featuredStats.regularSeason.subSeason.avgPpToi` at fetch time and stores it as `ppToi` in `enrichedRawData` (the JSON blob saved to `player_shot_logs.raw_data`).

2. **run_nhl_player_shots_model.js** now reads `ppToi` from `rawData` on the model run and passes it as `toi_proj_pp` to `projectSogV2`. A finite/positive guard ensures legacy rows (where `ppToi` is absent) still get `toi_proj_pp: 0`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Enrich rawData with ppToi in pull_nhl_player_shots.js | 863b617 | pull_nhl_player_shots.js, pull_nhl_player_shots.test.js |
| 2 | Read ppToi from rawData and wire into projectSogV2 | 20ee178 | run_nhl_player_shots_model.js, run_nhl_player_shots_model.test.js |

## Implementation Details

### Task 1: computeSeasonPpToi

Added immediately after `computeSeasonShotsPer60` in pull_nhl_player_shots.js:

```javascript
function computeSeasonPpToi(payload) {
  const sub = payload?.featuredStats?.regularSeason?.subSeason;
  if (!sub) return null;
  if (!sub.avgPpToi || typeof sub.avgPpToi !== 'string' || !sub.avgPpToi.includes(':')) {
    return null;
  }
  const parsed = parseToiMinutes(sub.avgPpToi);
  return Number.isFinite(parsed) ? parsed : null;
}
```

`enrichedRawData` now includes `ppToi: computeSeasonPpToi(payload)`.

### Task 2: rawData extraction + projectSogV2 wiring

Extended the rawData extraction block to read `ppToi` with a safe guard:
```javascript
ppToi = Number.isFinite(rawData.ppToi) && rawData.ppToi > 0 ? rawData.ppToi : 0;
```

Replaced `toi_proj_pp: 0` with `toi_proj_pp: ppToi` in the `projectSogV2` call.

## Tests Added

| Test | File | Verifies |
|------|------|---------|
| computeSeasonPpToi: avgPpToi "2:30" → 2.5 | pull_nhl_player_shots.test.js | Correct MM:SS parsing |
| computeSeasonPpToi: avgPpToi "0:00" → 0.0 | pull_nhl_player_shots.test.js | Zero PP players |
| computeSeasonPpToi: no avgPpToi → null | pull_nhl_player_shots.test.js | Missing field safe fallback |
| computeSeasonPpToi: no subSeason → null | pull_nhl_player_shots.test.js | No featuredStats safe fallback |
| Test G: ppToi:2.5 in rawData → toi_proj_pp:2.5 | run_nhl_player_shots_model.test.js | PP wiring end-to-end |
| Test H: legacy raw_data:{} → toi_proj_pp:0 | run_nhl_player_shots_model.test.js | No regression for legacy rows |

**Total tests after:** 61 (31 + 30 across both suites)

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

### Files exist:
- apps/worker/src/jobs/pull_nhl_player_shots.js: MODIFIED
- apps/worker/src/jobs/run_nhl_player_shots_model.js: MODIFIED
- apps/worker/src/jobs/__tests__/pull_nhl_player_shots.test.js: MODIFIED
- apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js: MODIFIED

### Commits:
- 863b617: feat(quick-53): enrich rawData with ppToi from avgPpToi in pull_nhl_player_shots.js
- 20ee178: feat(quick-53): wire ppToi from rawData into projectSogV2 toi_proj_pp — replace hardcoded 0

### Old TODO removed:
- "PP TOI not yet tracked" comment: REMOVED

## Self-Check: PASSED
