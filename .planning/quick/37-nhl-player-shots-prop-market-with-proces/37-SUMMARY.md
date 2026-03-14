---
phase: quick-37
plan: "01"
subsystem: nhl-player-shots-prop-market
tags: [nhl, props, odds-api, player-shots, db-migration]
dependency_graph:
  requires: [packages/data/src/db.js, packages/data/db/migrations/028_create_odds_ingest_failures.sql]
  provides: [player_prop_lines table, upsertPlayerPropLine, getPlayerPropLine, pull_nhl_player_shots_props.js, real market line lookup in model runner]
  affects: [apps/worker/src/jobs/run_nhl_player_shots_model.js, packages/data/src/db.js]
tech_stack:
  added: []
  patterns: [DB upsert with bookmaker-priority SELECT, env-gated job with dry-run mode, synthetic fallback with explicit source tagging]
key_files:
  created:
    - packages/data/db/migrations/029_create_player_prop_lines.sql
    - apps/worker/src/jobs/pull_nhl_player_shots_props.js
    - docs/NHL_PLAYER_SHOTS_PROP_MARKET.md
  modified:
    - packages/data/src/db.js
    - apps/worker/src/jobs/run_nhl_player_shots_model.js
    - apps/worker/package.json
decisions:
  - "Env-gate the pull job (NHL_SOG_PROP_EVENTS_ENABLED) to prevent accidental Odds API quota burn"
  - "Keep synthetic fallback with explicit market_line_source field so card consumers can distinguish real vs synthetic lines"
  - "Bookmaker priority: DraftKings > FanDuel > BetMGM > any — resolved in DB query ORDER BY CASE"
  - "game_id resolution by time proximity (<4h) + team name prefix matching against games table"
metrics:
  duration: "~15 minutes"
  completed: "2026-03-14"
  tasks_completed: 3
  files_changed: 6
---

# Quick Task 37: NHL Player Shots Prop Market with Process Documentation — Summary

**One-liner:** Real O/U SOG prop lines from The Odds API stored in player_prop_lines table, consumed by model runner with explicit synthetic fallback when no real line available.

## What Was Built

### Task 1: player_prop_lines DB table + functions

Migration `029_create_player_prop_lines.sql` creates the `player_prop_lines` table with:
- Unique index on `(sport, game_id, player_name, prop_type, period, bookmaker)` for upsert semantics
- Lookup index on `(sport, game_id, prop_type)` for model runner queries

Two new functions added to `packages/data/src/db.js` and exported:
- `upsertPlayerPropLine(row)` — inserts or updates a prop line row
- `getPlayerPropLine(sport, gameId, playerName, propType, period)` — returns consensus line with bookmaker priority (DraftKings > FanDuel > BetMGM > any), case-insensitive player name match

### Task 2: Pull job + model runner integration

New job `apps/worker/src/jobs/pull_nhl_player_shots_props.js`:
- Fetches upcoming NHL events from Odds API `/v4/sports/icehockey_nhl/events`
- For each event in 36h window, fetches `player_shots_on_goal` O/U lines per bookmaker
- Resolves canonical `game_id` via time proximity + team name prefix matching against `games` table
- Gated by `NHL_SOG_PROP_EVENTS_ENABLED=true` to prevent accidental quota consumption
- Exports `pullNhlPlayerShotsProps`, supports `--dry-run` flag, follows standard job run pattern

Model runner `run_nhl_player_shots_model.js` changes:
- Imports `getPlayerPropLine` from `@cheddar-logic/data`
- Replaces pure synthetic line generation with real DB lookup + synthetic fallback
- Both full-game and 1P card payloads now include `market_line_source: "odds_api" | "synthetic_fallback"` in the `decision` object
- Logs a warning when falling back to synthetic (useful for monitoring)

npm scripts added to `apps/worker/package.json`:
- `job:pull-nhl-player-shots-props`
- `job:pull-nhl-player-shots-props:dry`

### Task 3: Process documentation

`docs/NHL_PLAYER_SHOTS_PROP_MARKET.md` covers:
- Full data flow diagram (NHL API -> player_shot_logs, Odds API -> player_prop_lines, model runner -> card_payloads)
- Job execution order for a complete NHL card cycle
- Environment variables table with required/optional/default info
- Token cost analysis (~300-500 tokens/month at 2x/day)
- Market line resolution priority explanation
- Model specification (inputs, outputs, edge thresholds)
- Card types table
- DB schema reference
- Known limitations (1P props, player name matching, team abbreviations)

## Verification Results

All 5 final checks passed:
1. `upsertPlayerPropLine` and `getPlayerPropLine` exported as functions
2. Migration 029 file exists
3. Pull job dry-run exits 0
4. Model runner loads without error
5. Process doc contains Data Flow section (1+ match)

## Deviations from Plan

None — plan executed exactly as written.

## Commits

| Task | Commit | Description |
|---|---|---|
| 1 | 5999467 | feat(37-01): add player_prop_lines table and DB functions |
| 2 | 5639b05 | feat(37-01): add NHL player SOG prop pull job and wire real lines into model runner |
| 3 | bc63cc3 | docs(37-01): add NHL player SOG prop market process documentation |

## Self-Check: PASSED

- `/Users/ajcolubiale/projects/cheddar-logic/packages/data/db/migrations/029_create_player_prop_lines.sql` — exists
- `/Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/jobs/pull_nhl_player_shots_props.js` — exists
- `/Users/ajcolubiale/projects/cheddar-logic/docs/NHL_PLAYER_SHOTS_PROP_MARKET.md` — exists
- Commits 5999467, 5639b05, bc63cc3 — all present in git log
