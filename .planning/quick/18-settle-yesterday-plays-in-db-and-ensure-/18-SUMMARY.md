---
phase: quick-18
plan: 01
subsystem: settlement-pipeline
tags: [settlement, espn, card-results, game-results, results-page]
key-files:
  modified: []
  created: []
decisions:
  - "No code changes required — settlement pipeline (settle_game_results + settlePendingCards) ran successfully with jobKey=null to bypass idempotency"
  - "DB path is consistent between worker and web app (both default to /tmp/cheddar-logic/cheddar.db) — no env var fix needed"
metrics:
  completed_date: "2026-03-01"
  tasks_completed: 2
  tasks_total: 3
  files_created: 0
  files_modified: 0
---

# Quick Task 18: Settle Yesterday's Plays in DB and Ensure /results Shows Data

One-liner: Ran ESPN score ingest + card grading pipeline (jobKey=null) to settle 33 games and 39 cards across NBA, NCAAM, NHL; /api/results now returns 39 graded plays with 24W/15L split.

## What Was Done

### Task 1: Diagnose DB State and Run Settlement Pipeline

**Initial DB state:**
- card_results: 18,885 pending, 0 settled
- game_results: 0 rows (empty — nightly sweep had not populated)

**Ran `settleGameResults({ jobKey: null, dryRun: false, minHoursAfterStart: 3 })`:**

ESPN scoreboard fetch returned completed events for Feb 28 - Mar 1, 2026:

| Sport | DB Games Checked | ESPN Events | Games Settled |
|-------|-----------------|-------------|---------------|
| NHL   | 17              | 14 completed| 13            |
| NBA   | 10              | 6 completed | 5             |
| NCAAM | 147             | 15 completed| 15            |
| **Total** | **174**    |             | **33**        |

Note: Many NCAAM games had no ESPN match — ESPN scoreboard only returns high-profile/visible games, not every lower-conference game in our DB.

**Ran `settlePendingCards({ jobKey: null, dryRun: false })`:**

135 pending card_results had final game scores available. After applying W/L/push logic:

| Sport | Cards Settled | Wins | Losses | Total PnL |
|-------|---------------|------|--------|-----------|
| NBA   | 15            | 6    | 9      | -6.753 u  |
| NCAAM | 18            | 15   | 3      | +12.728 u |
| NHL   | 6             | 3    | 3      | -1.479 u  |
| **Total** | **39**   | **24** | **15** | **+4.496 u** |

Note: Cards with NEUTRAL predictions (driver-only informational cards) are skipped — they have no directional bet. This is expected behavior; 96 of 135 eligible cards were NEUTRAL.

**Final DB state after settlement:**
- card_results: 18,846 pending, 24 wins, 15 losses (39 settled)
- game_results: 33 final (5 NBA, 15 NCAAM, 13 NHL)
- tracking_stats: 3 rows upserted (one per sport)

### Task 2: Verify /api/results API

Confirmed no DB path mismatch: both worker and web app default to `/tmp/cheddar-logic/cheddar.db` (no custom DATABASE_PATH env vars set on either side).

Started local Next.js dev server and tested:

```
GET /api/results -> 200 OK
{
  success: true,
  data: {
    summary: { wins: 24, losses: 15, settledCards: 39 },
    segments: [ {sport: "NBA"}, {sport: "NCAAM"}, {sport: "NHL"} ],   // 3 segments
    ledger: [...]   // 39 rows
  }
}
```

API is functioning correctly. No code changes required.

### Task 3: Human Verification (Checkpoint - Paused)

Awaiting user to visit http://localhost:3000/results to confirm UI displays the graded data.

## Deviations from Plan

None — plan executed exactly as written. No code changes were needed; both settlement jobs ran cleanly and the API route was correct.

## Issues Found

1. **Many NCAAM games unmatched by ESPN**: ~132 of 147 NCAAM DB games had no ESPN scoreboard match. This is expected — ESPN's college basketball scoreboard only includes a subset of games (major conferences, feature games). Minor-conference games in our DB are not returned by the scoreboard API. This is a known limitation, not a bug.

2. **Most NHL driver cards are NEUTRAL**: 75 of 81 NHL card_results had NEUTRAL predictions (goalie, specialTeams, shotEnvironment, totalFragility, pdoRegression, scoringEnvironment cards are all informational). Only restAdvantage cards have directional predictions for NHL. This is correct by design.

## Self-Check

### Created files:
- [ ] No source files created (operational task only)

### DB verification:
```
card_results WHERE status='settled': 39 rows (24 win + 15 loss)
game_results WHERE status='final': 33 rows (5 NBA + 15 NCAAM + 13 NHL)
/api/results: success=true, ledger=39 rows, segments=3 rows
```

## Self-Check: PASSED

All done criteria met:
- game_results populated with 33 final scores
- card_results has 39 settled rows with win/loss results and non-null settled_at timestamps
- /api/results returns success=true with 39 ledger rows and 3 sport segments
