---
phase: quick-10
plan: 10
subsystem: web-api, docs
tags: [filter, settlement, audit, games-api]
dependency_graph:
  requires: []
  provides: [today-forward-games-filter, settlement-audit]
  affects: [web/src/app/api/games/route.ts, docs/SETTLEMENT_AUDIT.md]
tech_stack:
  added: []
  patterns: [sqlite-datetime-modifier, settlement-tracking]
key_files:
  modified:
    - web/src/app/api/games/route.ts
  created:
    - docs/SETTLEMENT_AUDIT.md
decisions:
  - "Use SQLite datetime('now', 'start of day') to anchor filter at midnight UTC — cleaner than -24h rolling window and eliminates yesterday's completed games"
  - "Settlement audit documents 3 precise gaps (no game ingest, no card settlement logic, no tracking_stats compute) with concrete action plan for each"
metrics:
  duration: 71s
  completed: 2026-02-28T12:11:43Z
  tasks_completed: 2
  files_modified: 1
  files_created: 1
---

# Phase quick-10 Plan 10: Filter /api/games to Today-Forward and Write Settlement Audit Summary

**One-liner:** SQLite `start of day` filter eliminates yesterday's completed games from /cards; settlement audit maps 3 concrete gaps blocking projection settlement from working end-to-end.

---

## What Was Done

### Task 1: Tighten /api/games filter to today-forward only

Changed the WHERE clause in `web/src/app/api/games/route.ts` from:
```sql
WHERE g.game_time_utc >= datetime('now', '-24 hours')
```
to:
```sql
WHERE g.game_time_utc >= datetime('now', 'start of day')
```

Also updated the JSDoc comment at the top of the file from:
```
Query window: game_time_utc >= now - 24 hours (catches in-progress games)
```
to:
```
Query window: game_time_utc >= midnight today UTC (today + future games only)
```

The `-24 hours` rolling window was bleeding yesterday's completed games (games that started 2026-02-27 and appeared in cards view on 2026-02-28 morning). The `start of day` modifier anchors to midnight UTC, so only today's games and future games appear.

**Commit:** `4ce1c78`

### Task 2: Write settlement tracking audit

Created `docs/SETTLEMENT_AUDIT.md` with full gap analysis of the settlement pipeline. Key findings from the code audit:

**What is wired (working):**
- `insertCardPayload()` in `packages/data/src/db.js` automatically calls `insertCardResult()` with `status: 'pending'` on every card insert — confirmed by reading the implementation at line 820-832 of db.js
- Schema is complete: `card_results`, `game_results`, `tracking_stats` all exist with proper indexes and foreign keys (migrations 007, 008, 009)
- `upsertGameResult()` function exists in db.js and is correctly implemented

**What is missing (3 gaps):**
1. **Gap 1 (CRITICAL):** No job calls `upsertGameResult()` — `game_results` table has zero rows
2. **Gap 2 (CRITICAL):** No job reads completed `game_results` and settles `card_results` from `pending` to `win/loss/push`
3. **Gap 3 (DOWNSTREAM):** No job aggregates settled data into `tracking_stats`

The audit also documents win/loss/pnl settlement logic and recommended action plan for each gap.

**Commit:** `72274c0`

---

## Files Changed

| File | Change |
|------|--------|
| `web/src/app/api/games/route.ts` | WHERE clause: `-24 hours` → `start of day`; JSDoc comment updated |
| `docs/SETTLEMENT_AUDIT.md` | Created — 85 lines, full settlement gap analysis |

---

## Decisions Made

1. **`datetime('now', 'start of day')` over alternatives:** SQLite's `start of day` modifier resolves to midnight UTC of the current day. This is exactly the right boundary — no games from yesterday bleed through, and all of today's games (including early ones) appear. Alternative of passing a computed timestamp from application code would add complexity with no benefit.

2. **Audit format chosen:** Structured markdown with tables (What Exists, What Is Wired, What Is Missing) rather than prose — easier to scan and actionable. Each gap has a concrete "Required:" action block.

---

## Deviations from Plan

None — plan executed exactly as written.

---

## Self-Check: PASSED

- [x] `web/src/app/api/games/route.ts` WHERE clause reads `datetime('now', 'start of day')`
- [x] `docs/SETTLEMENT_AUDIT.md` exists with all sections (Gap 1, Gap 2, Gap 3, What Is Wired, Settlement Logic, Recommended Next Steps)
- [x] Commit `4ce1c78` exists — Task 1
- [x] Commit `72274c0` exists — Task 2
- [x] No other files modified
