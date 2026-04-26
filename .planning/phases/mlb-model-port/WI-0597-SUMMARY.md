---
phase: 3
plan: WI-0597
subsystem: mlb-model
tags: [mlb, pitcher-k, odds-ingestion, player-prop-lines, scheduler]

dependency-graph:
  requires: [WI-0595, WI-0596]
  provides: [pitcher_strikeouts prop lines in player_prop_lines, ODDS_BACKED mode guard, scheduler slot]
  affects: [WI-0598, WI-0599, WI-0600]

tech-stack:
  added: []
  patterns: [two-step game_id resolver, ODDS_BACKED mode guard, prop pull job template]

key-files:
  created:
    - apps/worker/src/jobs/pull_mlb_pitcher_strikeout_props.js
    - apps/worker/src/jobs/__tests__/pull_mlb_pitcher_strikeout_props.test.js
  modified:
    - apps/worker/src/schedulers/main.js
    - apps/worker/package.json
    - env.example

decisions:
  - id: D1
    decision: Pull job defaults OFF (MLB_PITCHER_K_PROP_EVENTS_ENABLED=false); both flag and ODDS_BACKED mode required
    rationale: Avoid unexpected Odds API token spend during PROJECTION_ONLY phase; opt-in for ODDS_BACKED activation

metrics:
  duration: 45m
  completed: 2026-03-26
---

# Phase 3 WI-0597: Pitcher K Odds Pull and Dual-Mode Runtime Wiring Summary

**One-liner:** MLB pitcher_strikeouts prop pull job from Odds API per-event endpoint with two-step game_id resolution and ODDS_BACKED/PROJECTION_ONLY mode guard in scheduler.

## What Was Delivered

- **`pull_mlb_pitcher_strikeout_props.js`** — new pull job that fetches `pitcher_strikeouts` O/U lines from the Odds API `/v4/sports/baseball_mlb/events/{id}/odds` endpoint. Parses pitcher names, lines, and American prices into `player_prop_lines` table rows. Ladder lines (multiple thresholds for same pitcher) are preserved as separate rows.

- **Two-step `resolveGameId`** — exact normalized team name match (±1h window) then 6-char prefix fallback (±4h window), matching the pattern established in `pull_nhl_player_shots_props.js`. Emits `console.warn` on fallback usage.

- **Mode guard** — pull job skips entirely unless both `MLB_PITCHER_K_PROP_EVENTS_ENABLED=true` AND `PITCHER_KS_MODEL_MODE=ODDS_BACKED` are set. PROJECTION_ONLY mode gets a clean no-op log, never an API call.

- **Scheduler wiring** — `queueMlbPitcherKPropIngestBeforeModel()` queued after weather and before model run for each MLB game T-minus window. Gated by `ENABLE_MLB_PITCHER_K_PROP_PULL` flag. Logged in startup config dump.

- **`package.json`** — `job:pull-mlb-pitcher-strikeout-props` script added.

- **`env.example`** — `MLB_PITCHER_K_PROP_EVENTS_ENABLED`, `PITCHER_KS_MODEL_MODE`, `MLB_PITCHER_K_PROP_SLEEP_MS` documented with full mode semantics description.

## Tests

14 passing tests:
- `parseEventPropLines`: Over/Under parsing, multi-bookmaker, ladder lines, decimal odds normalization, two-pitcher responses, skip-bad-outcomes, empty response, wrong market
- `resolveGameId`: step-1 exact match, case-insensitive, step-2 fallback, warn emission, null on no match

## Deviations from Plan

None — plan executed exactly as written.

## Decisions Made

| Decision | Rationale |
|---|---|
| Default OFF (`MLB_PITCHER_K_PROP_EVENTS_ENABLED=false`) | Prevent token spend until operator ready for ODDS_BACKED activation |
| Require both flags (event flag + mode flag) | Avoids pull running without engine to consume the lines |
