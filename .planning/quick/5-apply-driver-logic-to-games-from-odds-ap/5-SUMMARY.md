---
phase: quick-5
plan: "01"
subsystem: driver-model-pipeline
tags: [nhl, nba, ncaam, card-payloads, api, ui, driver-cards]
dependency_graph:
  requires: [quick-4]
  provides: [/api/games-plays, /cards-driver-plays]
  affects: [web/src/app/api/games/route.ts, web/src/app/cards/page.tsx]
tech_stack:
  added: []
  patterns: [LEFT JOIN card_payloads, plays Map grouping, tier badge rendering]
key_files:
  created: []
  modified:
    - web/src/app/api/games/route.ts
    - web/src/app/cards/page.tsx
decisions:
  - "Variadic spread for SQL IN clause binding: cardsStmt.all(...gameIds) — matches sql.js Statement.all(...params) signature"
  - "plays field defaults to empty array [] on games with no cards — additive, no existing fields removed"
  - "Tier badge colors: SUPER=green, BEST=blue, WATCH=yellow, null=none"
metrics:
  duration: "~8 minutes"
  completed: "2026-02-27"
  tasks_completed: 3
  files_modified: 2
---

# Quick-5: Apply Driver Logic to Games from Odds API — Summary

One-liner: NHL (85 cards, 5 driver types) and NBA (4 cards) model jobs populated card_payloads; /api/games now returns plays[] per game via LEFT JOIN; /cards page renders tier-colored Driver Plays section with prediction, confidence, and reasoning.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Run model jobs for NHL/NBA/NCAAM | — (DB write, no code change) | card_payloads (89 rows) |
| 2 | Extend /api/games to return driver play calls | 285daf0 | web/src/app/api/games/route.ts |
| 3 | Show play calls on /cards page | 56ca96b | web/src/app/cards/page.tsx |

## What Was Done

### Task 1: Model Jobs Executed

Ran three model jobs against currently ingested games:
- `node apps/worker/src/jobs/run_nhl_model.js` — 17 NHL games, 85 cards (5 driver types each: goalie, special-teams, shot-environment, total-fragility, pdo-regression)
- `node apps/worker/src/jobs/run_nba_model.js` — 8 NBA games, 4 cards (blowout-risk only for games with spread >= 8)
- `node apps/worker/src/jobs/run_ncaam_model.js` — 0 NCAAM games in 36h horizon (expected, exits 0)

Final card_payloads totals:
- NHL: 85 cards (5 types x 17 games)
- NBA: 4 cards (blowout-risk with spread threshold)
- NCAAM: 0 (no upcoming games)

### Task 2: /api/games Plays JOIN

Added to `web/src/app/api/games/route.ts`:
- `Play` interface with 8 fields: cardType, cardTitle, prediction, confidence, tier, reasoning, evPassed, driverKey
- `CardPayloadRow` interface for DB typing
- Second query after games query: `SELECT ... FROM card_payloads WHERE game_id IN (?) AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY created_at DESC`
- Uses variadic spread `cardsStmt.all(...gameIds)` — matches sql.js Statement signature
- Groups results into `Map<string, Play[]>` keyed by game_id
- `JSON.parse(payload_data)` wrapped in try/catch — malformed rows skipped silently
- `plays: playsMap.get(row.game_id) ?? []` on every game object

Result: 25 total games returned, 18 with `plays.length > 0`

### Task 3: /cards Driver Plays Section

Updated `web/src/app/cards/page.tsx`:
- Added `Play` interface (matches route.ts)
- Added `plays: Play[]` to `GameData` interface
- `getTierBadge()` helper: SUPER=green, BEST=blue, WATCH=yellow, null=none
- `getPredictionBadge()` helper: HOME=indigo, AWAY=orange, NEUTRAL=gray
- "Driver Plays" section renders below odds when `plays.length > 0`
- Each play: tier badge + prediction badge + confidence % + card title + reasoning text
- Uses `game.plays ?? []` guard for safe handling of undefined

## Verification Results

1. NHL model: exit 0, cardsGenerated=85
2. NBA model: exit 0, cardsGenerated=4
3. NCAAM model: exit 0, cardsGenerated=0 (no upcoming games — expected)
4. GET /api/games: includes `plays` array on every game object
5. 18 of 25 games have `plays.length > 0` with full prediction/confidence/tier/reasoning
6. TypeScript: zero errors in route.ts and page.tsx (only pre-existing .next/dev/types error unrelated to these files)

## Deviations from Plan

None — plan executed exactly as written. Task 1 had no file changes (DB population only); committed as DB state change with no source commit needed.

## Self-Check: PASSED

Files modified exist and contain expected patterns:
- `web/src/app/api/games/route.ts` — contains `card_payloads`, `Play` interface, `plays` in response
- `web/src/app/cards/page.tsx` — contains `plays`, `getTierBadge`, `Driver Plays` section

Commits verified:
- 285daf0: feat(quick-5): extend /api/games to return driver play calls per game
- 56ca96b: feat(quick-5): render driver play calls on /cards page

End-to-end flow confirmed: odds ingest -> model jobs -> card_payloads -> /api/games plays JOIN -> /cards Driver Plays section.
