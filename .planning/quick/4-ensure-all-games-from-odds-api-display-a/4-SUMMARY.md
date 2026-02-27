---
phase: quick-4
plan: 01
subsystem: web-ui
tags: [api, ui, games, odds, dashboard]
dependency_graph:
  requires: []
  provides: [GET /api/games, /cards page showing all games]
  affects: [web/src/app/cards/page.tsx]
tech_stack:
  added: []
  patterns: [CTE with ROW_NUMBER for latest-per-group, LEFT JOIN for optional odds]
key_files:
  created:
    - web/src/app/api/games/route.ts
  modified:
    - web/src/app/cards/page.tsx
decisions:
  - Used hasOdds check (any non-null odds field) to determine if odds object should be returned vs null
  - Formatted moneyline with last word of team name to keep lines compact
  - Kept pre-existing /api/cards route untouched — games route is additive
metrics:
  duration: 73s
  completed: 2026-02-27T23:30:04Z
  tasks_completed: 2
  files_created: 1
  files_modified: 1
---

# Quick Task 4: Ensure All Games from Odds API Display — Summary

**One-liner:** New GET /api/games route (CTE + LEFT JOIN for latest odds per game) feeds a redesigned /cards page that shows all 25+ ingested games instead of only model-card-backed ones.

---

## What Was Built

### Task 1: GET /api/games route

Created `web/src/app/api/games/route.ts` as a Next.js App Router route handler.

The route uses a CTE with `ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY captured_at DESC)` to select the single latest odds snapshot per game, then LEFT JOINs to the `games` table so games with no odds snapshots still appear.

Window: `game_time_utc >= datetime('now', '-24 hours')` catches in-progress games. Results sorted `ASC` by game time, capped at 200 rows.

Response shape is camelCase (`gameId`, `homeTeam`, `awayTeam`, etc.) with an `odds` object that is `null` when no snapshot exists.

Pattern matches the existing `/api/cards/route.ts`: `initDb` + `getDatabase` + `closeDatabase` from `@cheddar-logic/data`, try/catch/finally.

### Task 2: Updated /cards page

Replaced `/api/cards?limit=100` fetch with `/api/games` in `web/src/app/cards/page.tsx`.

Updated interfaces from `CardData` to `GameData` matching the new response shape.

Card rendering:
- Title: "{awayTeam} @ {homeTeam}"
- Sport badge (uppercase), status badge if status != 'scheduled'
- Game time in local format via existing `formatDate` helper
- Odds section: moneyline (home/away), O/U total, odds capture timestamp
- "No odds data" italic note when `odds` is null

Page title updated to "Games", subtitle shows live game count. 30-second auto-refresh preserved.

---

## Files Created / Modified

| File | Action |
|------|--------|
| `web/src/app/api/games/route.ts` | Created — GET /api/games handler |
| `web/src/app/cards/page.tsx` | Modified — now fetches from /api/games |

---

## Key Decisions

1. **hasOdds guard**: `odds` is returned as `null` if all odds fields are null, not an empty object. This lets the UI render "No odds data" cleanly without checking each field.

2. **Compact moneyline display**: Shows last word of team name (e.g., "Bruins +150 / Leafs -180") to keep the odds row readable within the card width.

3. **Pre-existing /api/cards left unchanged**: The new route is purely additive. The old `/api/cards` endpoint still works for any consumers of card_payloads data.

4. **Pre-existing TypeScript error not fixed**: The `.next/dev/types` error about `/api/cards/[gameId]/route` params typing is a Next.js 15 async-params migration issue that predates this task and is out of scope per deviation Rule scope boundary.

---

## Verification

- Route `web/src/app/api/games/route.ts` compiles without errors (pre-existing `.next/dev/types` error is in an unrelated route).
- `/cards` page fetches from `/api/games` (confirmed by `fetch('/api/games')` in source).
- LEFT JOIN ensures games with no odds snapshots appear.
- CTE ROW_NUMBER pattern ensures only 1 odds row per game.
- 30-second auto-refresh interval preserved.

---

## Deviations from Plan

None - plan executed exactly as written.

---

## Commits

| Task | Hash | Message |
|------|------|---------|
| Task 1 | 9f380d9 | feat(quick-4): add GET /api/games route joining games + latest odds |
| Task 2 | e89ec1c | feat(quick-4): update /cards page to show all games from /api/games |
