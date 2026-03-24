---
phase: mlb-model-port
plan: 03
subsystem: inference
tags: [mlb, inference, scheduler, pitcher-stats, enrichment]

# Dependency graph
requires:
  - phase: mlb-model-port
    provides: "mlb-model.js with computeMLBDriverCards, pull_mlb_pitcher_stats job"
provides:
  - "MLB branch in getInference calling computeMLBDriverCards (is_mock=false when pitcher data present)"
  - "enrichMlbPitcherData helper in run_mlb_model.js enriching odds snapshots from DB"
  - "pull_mlb_pitcher_stats queued as pre-model job before run_mlb_model in T-minus loop"
  - "computeMLBDriverCards exported from models/index.js"
affects: [mlb-model-port, run_mlb_model, schedulers]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pre-model job chaining: queueXxxBeforeModel pattern mirrors Soccer/NHL in main.js T-minus loop"
    - "Enrichment helper pattern: enrichMlbPitcherData wraps oddsSnapshot, falls back gracefully on DB error"
    - "MLB branch gates on mlbCards.length > 0 before returning is_mock=false, falls through to mock constant otherwise"

key-files:
  created: []
  modified:
    - apps/worker/src/models/index.js
    - apps/worker/src/jobs/run_mlb_model.js
    - apps/worker/src/schedulers/main.js

key-decisions:
  - "Use team-name lookup (WHERE team = ? AND date(updated_at) = date('now')) for pitcher enrichment instead of mlb_id on odds snapshot — simpler, no schema change needed"
  - "Attach total_line and f5_line from top-level odds snapshot fields into raw_data.mlb inside enrichMlbPitcherData so computeMLBDriverCards can read them without accessing top-level fields"
  - "Wire pitcher stats as T-minus pre-model job (matching soccer/NHL pattern) rather than a fixed-time cron — ensures pitchers are fresh for every T-minus trigger"
  - "MLB inference falls through to mock constant when computeMLBDriverCards returns empty array (no pitcher data) — graceful degradation preserved"

patterns-established:
  - "Pre-model job helper: queueMlbPitcherStatsBeforeModel follows same shape as queueSoccerPropIngestBeforeModel"
  - "Enrichment graceful fallback: catch block returns original oddsSnapshot unchanged so game loop never fails on DB errors"

requirements-completed: []

# Metrics
duration: 2min
completed: 2026-03-24
---

# Phase mlb-model-port Plan 03: Wire MLB Inference Pipeline Summary

**MLB end-to-end inference wired: computeMLBDriverCards called from getInference, pitcher data enriched from DB before model.infer, pull_mlb_pitcher_stats registered as pre-model T-minus job**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-03-24T00:06:11Z
- **Completed:** 2026-03-24T00:08:26Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments
- `getInference('MLB', ...)` now calls `computeMLBDriverCards` and returns `is_mock: false` when pitcher data is present in `raw_data.mlb`
- `run_mlb_model.js` enriches each odds snapshot with pitcher stats from `mlb_pitcher_stats` (by team + today's date) before calling `model.infer`
- `pull_mlb_pitcher_stats` is queued as a pre-model job in the T-minus loop in `main.js`, following the same `queueXxxBeforeModel` pattern used by Soccer and NHL

## Task Commits

Each task was committed atomically:

1. **Task 1: Add computeMLBDriverCards to models/index.js** - `4a2bfb7` (feat)
2. **Task 2: Add pitcher enrichment in run_mlb_model.js** - `7374b32` (feat)
3. **Task 3: Register pull_mlb_pitcher_stats in scheduler** - `f7bb9a7` (feat)

## Files Created/Modified
- `apps/worker/src/models/index.js` - Added require for mlb-model, MLB branch in getInference, computeMLBDriverCards export
- `apps/worker/src/jobs/run_mlb_model.js` - Added getDatabase import, enrichMlbPitcherData helper, enrichment call in game loop
- `apps/worker/src/schedulers/main.js` - Added pullMlbPitcherStats require, queueMlbPitcherStatsBeforeModel function, MLB call in T-minus loop

## Decisions Made
- Team-name lookup chosen over mlb_id lookup for pitcher enrichment: `WHERE team = ? AND date(updated_at) = date('now')`. Simpler, no schema change needed.
- `total_line` and `f5_line` attached inside `enrichMlbPitcherData` from top-level odds snapshot fields, giving `computeMLBDriverCards` all inputs it needs via `raw_data.mlb`.
- Pitcher stats wired as T-minus pre-model job (not a fixed daily cron) so they're always fresh before each inference window fires.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Pre-existing test failures in `decision-publisher.v2.test.js` (6 failures, 2 suites) confirmed present before changes — not introduced by this plan.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- End-to-end MLB inference path is complete and wired
- Strikeout prop lines (`strikeout_lines.home/away`) remain null until player prop lines table is populated (out of scope for this WI — noted in plan)
- F5 and strikeout cards will fire once `pull_mlb_pitcher_stats` runs and populates `mlb_pitcher_stats` with today's probable pitchers

---
*Phase: mlb-model-port*
*Completed: 2026-03-24*
