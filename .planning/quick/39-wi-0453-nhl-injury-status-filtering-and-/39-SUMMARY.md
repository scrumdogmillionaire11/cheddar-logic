---
phase: 39-wi-0453-nhl-injury-status-filtering-and
plan: 01
subsystem: nhl-props-pipeline
tags: [nhl, injury-filtering, prop-market, hardening, docs]
tech-stack:
  added: []
  patterns:
    - injury-status-fail-open
    - deterministic-synthetic-fallback
    - canonical-game-id-resolution
    - opponent-factor-from-team-metrics-cache
key-files:
  created:
    - apps/worker/src/jobs/__tests__/pull_nhl_player_shots.test.js
    - apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js
    - packages/data/db/migrations/030_add_player_availability.sql
    - docs/PROP_MARKET_EXPANSION_GUIDE.md
  modified:
    - apps/worker/src/jobs/pull_nhl_player_shots.js
    - apps/worker/src/jobs/run_nhl_player_shots_model.js
    - apps/worker/src/jobs/run_nhl_model.js
    - docs/NHL_PLAYER_SHOTS_PROP_MARKET.md
decisions:
  - "Injury check is fail-open: if neither payload.status nor payload.currentTeamRoster.statusCode is present, player proceeds normally"
  - "Synthetic fallback uses Math.round(mu * 2) / 2 — no Math.random — deterministic across all runs"
  - "1P cards gated by NHL_SOG_1P_CARDS_ENABLED env flag, default off (1P Odds API market unreliable)"
  - "setCurrentRunId moved outside cardsCreated > 0 conditional — always called on success path"
  - "resolveCanonicalGameId wraps game_id_map lookup in try/catch since table may not exist; falls back to time+team proximity"
metrics:
  duration: "~8 minutes"
  completed: "2026-03-14T19:57:36Z"
  tasks_completed: 3
  files_created: 4
  files_modified: 4
---

# Quick Task 39: WI-0453/WI-0454 — NHL Injury Filtering, Model Hardening, Expansion Guide Summary

**One-liner:** Automated injury filtering via NHL API status check, 7 hardening gaps closed in the SOG model runner, and a reusable prop market expansion guide.

---

## What Was Changed Per File

### `apps/worker/src/jobs/pull_nhl_player_shots.js`

Added `checkInjuryStatus(payload)` function after `resolvePlayerName`. Inspects two payload fields in priority order:

1. `payload.status` — direct status string
2. `payload.currentTeamRoster.statusCode` — roster-level status code

Injury keywords matched via case-insensitive substring: `"injur"`, `"ltir"`, `"scratch"`, `"suspend"`, `"inactive"`. `"ir"` is matched as exact value only (to avoid false positives on words like "first"). Fail-open: if neither field exists, returns `{ skip: false }` so the player proceeds.

In the player loop, `checkInjuryStatus(payload)` is called after `fetchPlayerLanding` returns but before `buildLogRows`. If skip is true, logs:

```
[NHLPlayerShots] Skipping {playerName} ({playerId}): status={reason}
```

The `NHL_SOG_EXCLUDE_PLAYER_IDS` check remains upstream of the `fetchPlayerLanding` call, so it still fires before any API hit.

### `apps/worker/src/jobs/run_nhl_player_shots_model.js`

All 7 hardening gaps addressed:

**Gap 2 — 32-team map:** `TEAM_ABBREV_TO_NAME` expanded from 5 entries to all 32 NHL teams (ANA, BOS, BUF, CGY, CAR, CHI, COL, CBJ, DAL, DET, EDM, FLA, LAK, MIN, MTL, NSH, NJD, NYI, NYR, OTT, PHI, PIT, SEA, SJS, STL, TBL, TOR, UTA, VAN, VGK, WSH, WPG). Startup warning logged per-player loop if `team_abbrev` is not found in the map.

**Gap 3 — Deterministic synthetic fallback:** `Math.round(mu * 2) / 2` replaces `Math.round((mu + (Math.random() - 0.5) * 1.0) * 2) / 2` for full-game, and similarly for 1P. Logs `[synthetic-fallback] line=X is deterministic (no real line available)` after assignment.

**Gap 4 — opponentFactor from team_metrics_cache:** Query `shots_against_pg / league_avg_shots_against_pg` for the opponent team. Falls back to `1.0` with debug log if no row or table unavailable. `paceFactor` remains `1.0` with TODO comment.

**Gap 5 — 1P flag:** `const sog1pEnabled = process.env.NHL_SOG_1P_CARDS_ENABLED === 'true'` computed once before the game loop. Entire 1P card creation block wrapped in `if (sog1pEnabled) { ... }`.

**Gap 6 — resolveCanonicalGameId:** New helper function queries `game_id_map` first (try/catch since table may not exist), then falls back to time+team proximity match in `games` table (within 15 minutes = 0.010416 julian days). Returns original `gameId` on any error. Called at top of per-game loop; `resolvedGameId` used in all card `id` and `gameId` fields.

**Gap 7 — setCurrentRunId always called:** Moved from inside `if (cardsCreated > 0)` to the success path after `markJobRunSuccess`. Wrapped in try/catch. Also called in the early-exit path when no games are found.

**Task 1 (WI-0453) skip log:** The existing `if (l5Games.length < 5) { continue; }` guard now logs: `[run-nhl-player-shots-model] Skipping {player_name} ({player_id}): fewer than 5 recent game logs (possible injury/absence)`.

### `apps/worker/src/jobs/run_nhl_model.js`

Added a comment block above the `resolveGoalieState` call (line ~1173) documenting the degradation path:

> UNKNOWN starter_state → adjustment_trust='NEUTRALIZED' → goalie driver weight zeroed, NOT total confidence. This is the sound path for unconfirmed or injured goalies.

No logic changes.

### `packages/data/db/migrations/030_add_player_availability.sql`

New `player_availability` table:

```sql
CREATE TABLE IF NOT EXISTS player_availability (
  player_id INTEGER NOT NULL,
  sport TEXT NOT NULL DEFAULT 'NHL',
  status TEXT NOT NULL,
  status_reason TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (player_id, sport)
);
```

Primary key is `(player_id, sport)` so each player has one row per sport; use `INSERT OR REPLACE` to update on re-check.

### `docs/PROP_MARKET_EXPANSION_GUIDE.md` (new)

Full-content guide with 6 sections:

1. **The 4-File Pattern** — pull job, model runner, npm scripts, and doc file contracts
2. **Registration Checklist** — `ACTIVE_SPORT_CARD_TYPE_CONTRACT`, `CORE_RUN_STATE_SPORTS` in games and cards routes
3. **Odds API Market Keys** — table covering NHL SOG, NBA (points/rebounds/assists/threes), MLB Ks, NFL pass yards
4. **Edge Classification Thresholds** — NHL SOG reference values, calibration process, warning not to reuse thresholds without validation
5. **Token Cost Planning** — formula, NHL SOG example (~300-500 tokens/month), env flag gating rules
6. **Known Limitations** — NHL SOG reference implementation limitations (static player list, 1P reliability, opponentFactor, paceFactor, name matching, injury filtering scope)

### `docs/NHL_PLAYER_SHOTS_PROP_MARKET.md`

- Added `## Injury Check` section (after Data Flow) documenting payload field inspection, skip log format, fail-open behavior, and manual override
- Added `## 1P Cards` section explaining default-off and unreliable 1P Odds API market
- Added `NHL_SOG_EXCLUDE_PLAYER_IDS` and `NHL_SOG_1P_CARDS_ENABLED` to environment variables table

---

## Injury Check Implementation

Two payload fields are checked in priority order:

1. `payload.status` — if present and contains an injury keyword, skip. If present but not an injury keyword, player is active (no further checks).
2. `payload.currentTeamRoster.statusCode` — fallback if `payload.status` is absent.

If neither field is present, player proceeds (fail-open). This prevents accidental silencing of players due to API field changes.

Injury keywords use substring match (case-insensitive): `"injur"`, `"ltir"`, `"scratch"`, `"suspend"`, `"inactive"`. `"ir"` is exact-match only.

---

## 32-Team Map Confirmation

All 32 NHL teams are in `TEAM_ABBREV_TO_NAME`:

ANA, BOS, BUF, CAR, CGY, CHI, CBJ, COL, DAL, DET, EDM, FLA, LAK, MIN, MTL, NJD, NSH, NYI, NYR, OTT, PHI, PIT, SEA, SJS, STL, TBL, TOR, UTA, VAN, VGK, WSH, WPG

Note: `UTA` (Utah Hockey Club) was added — this is the team that relocated from Arizona for the 2024-25 season. `ARI` (Arizona Coyotes) is intentionally omitted as the team no longer exists.

---

## opponentFactor Query and Fallback

Query (per-game, per-player):

```sql
SELECT shots_against_pg, league_avg_shots_against_pg
FROM team_metrics_cache
WHERE LOWER(team_abbrev) = LOWER(?) AND LOWER(sport) = 'nhl'
LIMIT 1
```

The opponent is `awayTeam` if the player is on the home team, `homeTeam` otherwise. `isHome` is determined by matching `player.team_abbrev` against `homeTeam` directly and via `TEAM_ABBREV_TO_NAME`.

If `league_avg_shots_against_pg > 0` and a row exists: `opponentFactor = shots_against_pg / league_avg_shots_against_pg`. Otherwise falls back to `1.0` with a debug log. The DB query is wrapped in try/catch so a missing or differently-schemed `team_metrics_cache` table does not crash the job.

---

## Test Coverage Summary

**`pull_nhl_player_shots.test.js` — 11 tests:**
- Injured player skipped, `upsertPlayerShotLog` not called, "Skipping" in log
- Player with no status field proceeds normally (fail-open), `upsertPlayerShotLog` called
- `NHL_SOG_EXCLUDE_PLAYER_IDS` excludes player before `fetch` is called
- Parameterized: all 7 injury status strings cause skip (injured, IR, LTIR, Injured Reserve, scratched, suspended, inactive)
- `currentTeamRoster.statusCode` with IR value causes skip

**`run_nhl_player_shots_model.test.js` — 4 tests:**
- Player with 3 logs (< 5) is skipped, no card, "fewer than 5" in log
- `setCurrentRunId` called even when 0 cards created (COLD edge, 5 logs)
- 1P cards NOT generated when `NHL_SOG_1P_CARDS_ENABLED` is unset (even with HOT 1P edge)
- Deterministic formula: `Math.round(3.2 * 2) / 2 === 3` across 10 iterations

---

## Deviations from Plan

None — plan executed exactly as written.

---

## Self-Check: PASSED

All files confirmed to exist:
- FOUND: apps/worker/src/jobs/pull_nhl_player_shots.js
- FOUND: apps/worker/src/jobs/run_nhl_player_shots_model.js
- FOUND: packages/data/db/migrations/030_add_player_availability.sql
- FOUND: apps/worker/src/jobs/__tests__/pull_nhl_player_shots.test.js
- FOUND: apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js
- FOUND: docs/PROP_MARKET_EXPANSION_GUIDE.md

All commits confirmed:
- FOUND: dc29b56 (Tasks 1 + 2 — injury filtering, model hardening, migration, tests)
- FOUND: a03c027 (Task 3 — docs)
