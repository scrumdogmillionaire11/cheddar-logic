---
phase: quick-74
plan: "01"
subsystem: nhl-shots-model
tags: [nhl, opportunity-score, play-direction, already-complete]
requires: []
provides: ["closure record for WI-0575 quick-74 planning session"]
affects: []
tech-stack:
  added: []
  patterns: []
key-files:
  created:
    - .planning/quick/74-wi-0575-fix-opportunity-score-direction-/74-SUMMARY.md
  modified: []
decisions:
  - "No code changes made — WI-0575 was fully implemented in quick-71 (commits ca802d1 + 782c07a)"
metrics:
  duration: "< 5 minutes"
  completed: "2026-03-23"
---

# Phase quick-74 Plan 01: WI-0575 Direction Bug — Already Complete

**One-liner:** No-op planning session. WI-0575 was fully implemented in quick-71; this session confirms the fix is live and closes the planning ledger entry.

## Status

WI-0575 (direction-aware `opportunity_score` in `projectSogV2` + `projectBlkV1`) was completed in quick-71.

- Commits: `ca802d1` (model fix), `782c07a` (job runner wiring)
- WI file: `WORK_QUEUE/COMPLETE/WI-0575.md`
- SUMMARY: `.planning/quick/71-wi-0575-opportunity-score-always-compute/71-SUMMARY.md`

## Fix Confirmed Live

`grep "play_direction === 'UNDER'" apps/worker/src/models/nhl-player-shots.js` returns two matches:
- Line ~517 in `projectSogV2`
- Line ~745 in `projectBlkV1`

Both functions now branch on `play_direction`:
- `UNDER` → `edge_under_pp + ev_under + (market_line - mu)`
- `OVER` (default) → `edge_over_pp + ev_over + (mu - market_line)`

## No Code Changes

This session made no code modifications. All implementation is in quick-71.
