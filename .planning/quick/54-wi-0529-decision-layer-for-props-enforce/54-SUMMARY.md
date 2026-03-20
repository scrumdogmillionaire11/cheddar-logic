---
phase: 54-wi-0529-decision-layer-for-props-enforce
plan: "01"
subsystem: nhl-player-shots
tags: [props, decision-layer, display-state, transform, WI-0529]
dependency_graph:
  requires: [WI-0527]
  provides: [prop_display_state payload field, PropPlayRow.propDisplayState type, transform status override]
  affects: [web/src/lib/game-card/transform.ts, web/src/lib/types/game-card.ts, apps/worker/src/jobs/run_nhl_player_shots_model.js]
tech_stack:
  added: []
  patterns: [TDD red-green, type-cast for raw ApiPlay fields]
key_files:
  created: []
  modified:
    - apps/worker/src/jobs/run_nhl_player_shots_model.js
    - web/src/lib/types/game-card.ts
    - web/src/lib/game-card/transform.ts
    - apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js
decisions:
  - "prop_display_state uses == null (covers undefined + null) so both isOddsBacked=false and anomaly paths map to PROJECTION_ONLY without dual conditions"
  - "rawPropDisplayState accessed via (play as unknown as Record<string, unknown>) type cast — ApiPlay is the raw DB type and does not carry arbitrary payload fields"
  - "Legacy rows (no prop_display_state key) fall back to resolvePlayDisplayDecision unchanged — no migration required"
metrics:
  duration: "~15 minutes"
  completed: "2026-03-20"
  tasks_completed: 2
  files_modified: 4
  tests_added: 5
  tests_total: 35
---

# Phase 54 Plan 01: WI-0529 Decision Layer for Props (Enforce) Summary

**One-liner:** `computePropDisplayState` three-state helper (PLAY/WATCH/PROJECTION_ONLY) computed from (v2AnomalyDetected, v2OpportunityScore) and wired as primary status signal in transform.ts prop card pipeline.

## What Was Built

### Task 1: computePropDisplayState in model job + PropPlayRow type

Added `computePropDisplayState(v2AnomalyDetected, v2OpportunityScore)` module-level helper in `run_nhl_player_shots_model.js` with the following logic:

```javascript
function computePropDisplayState(v2AnomalyDetected, v2OpportunityScore) {
  if (v2AnomalyDetected || v2OpportunityScore == null) return 'PROJECTION_ONLY';
  if (v2OpportunityScore > 0) return 'PLAY';
  return 'WATCH';
}
```

Written to `payloadData.prop_display_state` immediately after `opportunity_score`. The `== null` check covers both `null` (anomaly) and `undefined`/`null` (no odds price via isOddsBacked=false).

Added `propDisplayState?: 'PLAY' | 'WATCH' | 'PROJECTION_ONLY'` to `PropPlayRow` interface in `game-card.ts`.

### Task 2: transform.ts status override

Replaced the status resolution block in `transformPropGames` with prop_display_state-first logic:

- `prop_display_state = 'PLAY'` → `status = 'FIRE'`
- `prop_display_state = 'WATCH'` → `status = 'WATCH'`
- `prop_display_state = 'PROJECTION_ONLY'` → `status = 'NO_PLAY'`
- `prop_display_state` absent (legacy row) → existing `resolvePlayDisplayDecision` fallback unchanged

`rawPropDisplayState` is also surfaced on the returned `PropPlayRow` as `propDisplayState`.

## Tests Added

5 new tests in `run_nhl_player_shots_model.test.js` (WI-0529 A–E):

| Test | Scenario | Expected |
|------|----------|----------|
| A | v2AnomalyDetected=true (sog_mu=1.4, l5=3.0) | PROJECTION_ONLY |
| B | isOddsBacked=false, no odds pricing, no anomaly | PROJECTION_ONLY |
| C | No anomaly, opportunity_score=0.3 (> 0) | PLAY |
| D | No anomaly, opportunity_score=0 (not > 0) | WATCH |
| E | No anomaly, opportunity_score=-0.1 (< 0) | WATCH |

All 35 model job tests pass. TypeScript compiles with 0 errors.

## Files Modified

- `apps/worker/src/jobs/run_nhl_player_shots_model.js` — `computePropDisplayState` helper + `prop_display_state` in payloadData
- `web/src/lib/types/game-card.ts` — `propDisplayState` optional field on `PropPlayRow`
- `web/src/lib/game-card/transform.ts` — status resolution block replaced + `propDisplayState` on return
- `apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js` — 5 new branch tests

## Commits

- `ff69bc2` — feat(54-01): compute prop_display_state in model job + wire PropPlayRow type
- `4fea1d8` — feat(54-02): wire prop_display_state into transform.ts status resolution

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

Files confirmed present:
- apps/worker/src/jobs/run_nhl_player_shots_model.js — FOUND
- web/src/lib/types/game-card.ts — FOUND
- web/src/lib/game-card/transform.ts — FOUND
- apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js — FOUND

Commits confirmed:
- ff69bc2 — FOUND
- 4fea1d8 — FOUND
