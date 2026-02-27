# Cheddar-Logic — System State

**Last activity:** 2026-02-27 — Quick task 4 complete (All games from odds API display on /cards page via new /api/games route)

---

## Current System Status

**Phase:** Pre-Ship Hardening (all migration phases complete, deploying to production)

**Risk Level:** Low — biggest former risk (fake ingest / no real games) resolved.

---

## Architecture (Locked In)

### Monorepo Structure

```
apps/
  worker/       → scheduler + ingest + model execution
  web/          → UI
packages/
  data/         → DB layer (sql.js + migrations + idempotency helpers)
  odds/         → provider fetch + normalization (NO DB writes)
```

- **No external odds service** — odds live inside the monorepo as a package
- Single DB, single scheduler, no microservices, no cross-repo runtime dependencies

---

## Domain Separation (Critical Boundary)

### A) Sports Betting Engine
- NHL, NBA, MLB, NFL, Soccer betting models (future)
- Depends on odds, runs on fixed windows + T-minus windows
- Uses job_key idempotency
- Reads from `games` + `odds_snapshots`

### B) FPL-SAGE (Fantasy)
- Deadline-driven, NOT game-time driven
- Currently disabled in scheduler
- Will use its own scheduling logic later

---

## Database Layer (Stable)

### Migrations Applied (5 total)
- `games` table — business key = `game_id`, stable PK = `id`
- `odds_snapshots`
- `job_runs`
- `job_key` column added with index
- Foreign keys enabled (`PRAGMA foreign_keys = ON`)

### Stable Game ID Rule (Important)
```
id = game-{sport-lower}-{game_id}
```
- Deterministic. DO NOT update `id` on conflict.
- Conflict key = `game_id`.

---

## Idempotency System (Fully Implemented)

All jobs support:
```js
async function runXModel({ jobKey = null, dryRun = false })
```

Pattern:
1. `shouldRunJobKey(jobKey)` gate
2. `insertJobRun(name, id, jobKey)`
3. Execute
4. Mark success/failure

Second run with same jobKey → `skipped: true`

**Verified idempotent:** NHL, NBA, MLB, NFL, pull_odds_hourly

---

## Odds Ingest (Real — Step D Complete)

Flow:
1. Fetched via `@cheddar-logic/odds`
2. Normalized to strict shape
3. Upserted into `games`
4. Inserted into `odds_snapshots`

Adapter does NOT write to DB. `pull_odds_hourly` is authoritative.

**Proof snapshot (2026-02-27):**
- gamesUpserted: 22, snapshotsInserted: 22, success=true
- DB counts: games=25, odds_snapshots=28
- IDs stable across repeated ingest

---

## Scheduler Logic (Hardened)

- TZ = America/New_York
- Fixed windows: 0900, 1200
- T-minus windows: T-120, T-90, etc.
- Tolerance band: ±5 min

**Important:** T-120 triggers only when `minutes_to_start` is within [115, 125]. A game 150 min away should NOT trigger.

---

## Horizon Filtering (Stale Protection)

Model jobs use `getOddsWithUpcomingGames()` which filters:
```
game_time_utc > now AND game_time_utc <= now + 36 hours
```
Prevents old game IDs, stale model runs, phantom T-minus windows.

---

## What Is Working

- Odds ingest writes real games + snapshots
- Game IDs are stable
- Scheduler idempotency works
- Model jobs skip on duplicate jobKey
- T-minus logic works correctly
- No adapter DB writes
- No fake seed dependency

---

## What Is NOT Done Yet

- FPL deadline scheduler
- Soccer betting models
- Production monitoring
- ~~Strict normalization threshold failure guard~~ DONE (quick-1)
- Service-level isolation (not needed yet)

---

## System Flow (End-to-End)

```
Odds Provider
    ↓
@cheddar-logic/odds (normalize only)
    ↓
pull_odds_hourly (idempotent)
    ↓
games + odds_snapshots tables
    ↓
Scheduler tick → computeDueJobs()
    ↓
run_{sport}_model({ jobKey })
    ↓
model_outputs + cards
```

Everything flows through DB. No model touches provider APIs directly.

---

## Critical Rules for Agents

- DO NOT reintroduce DB writes in adapter layer
- DO NOT use UUIDs for game IDs
- DO NOT bypass jobKey gate
- DO NOT mix FPL scheduling with betting scheduler
- DO NOT "fix" T-120 behavior based on misunderstanding minutes math

---

## Blockers/Concerns

None currently. System is structurally sound and ready for pre-ship hardening.

---

## Quick Tasks Completed

| # | Description                                                                       | Date       | Commit  | Directory                                                    |
|---|-----------------------------------------------------------------------------------|------------|---------|--------------------------------------------------------------|
| 1 | Pre-ship hardening: contract check, stable ID test, job-key audit, T-120 docs     | 2026-02-27 | 42692e9 | .planning/quick/1-pre-ship-hardening-contract-checks-stabl/  |
| 2 | NHL drivers fanout: per-driver cards, welcomeHome meta-driver, validator schema   | 2026-02-27 | ad0d4ce | .planning/quick/2-convert-nhl-drivers-into-individual-payl/  |
| 3 | Wire /fpl page to cheddar-fpl-sage: Next.js rewrites proxy + relative API URL    | 2026-02-27 | 932cbff | .planning/quick/3-wire-cheddar-fpl-sage-frontend-to-localh/  |
| 4 | Show all odds-API games on /cards: new /api/games route (CTE+LEFT JOIN) + /cards redesign    | 2026-02-27 | e89ec1c | .planning/quick/4-ensure-all-games-from-odds-api-display-a/  |
