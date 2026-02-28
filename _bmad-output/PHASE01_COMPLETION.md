# Shared-Data Migration Summary

**Status:** Phase 1 Complete ✅  
**Date:** 2026-02-27  
**Agent:** BMad Master

## What Was Done

Absorbed shared-data repo into cheddar-logic monorepo as persistence + adapter layer (not a service).

### Folder Structure

```
cheddar-logic/
├── packages/
│   ├── data/
│   │   ├── db/migrations/
│   │   │   ├── 001_create_job_runs.sql
│   │   │   ├── 002_create_games.sql
│   │   │   └── 003_create_odds_snapshots.sql
│   │   ├── src/
│   │   │   ├── db.js           ← DB client (queries, inserts, etc)
│   │   │   └── migrate.js      ← Migration runner
│   │   ├── index.js
│   │   ├── package.json        ← better-sqlite3
│   │   └── README.md
│   └── adapters/
│       ├── odds-fetcher.js     ← Fetches from shared-data, persists to DB
│       ├── index.js
│       └── package.json
└── apps/
    └── worker/
        ├── src/jobs/
        │   └── pull_odds_hourly.js  ← Runnable job with job_run tracking
        ├── package.json
        └── README.md
```

### Database Schema

**job_runs** — Track execution of all scheduled/manual jobs
```sql
id TEXT PRIMARY KEY           -- e.g., job-pull-odds-2026-02-27T07:00:00-abc123
job_name TEXT NOT NULL        -- e.g., pull_odds_hourly
status TEXT NOT NULL          -- running | success | failed
started_at TEXT NOT NULL      -- ISO 8601 UTC
ended_at TEXT                 -- ISO 8601 UTC (when status != running)
error_message TEXT            -- If failed
created_at TEXT NOT NULL      -- System timestamp
```

**games** — Game metadata (teams, start times, sport)
```sql
id TEXT PRIMARY KEY
sport TEXT NOT NULL
game_id TEXT NOT NULL UNIQUE
home_team TEXT NOT NULL
away_team TEXT NOT NULL
game_time_utc TEXT NOT NULL   -- ISO 8601 UTC
status TEXT NOT NULL          -- scheduled | live | final
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

**odds_snapshots** — Point-in-time odds captures
```sql
id TEXT PRIMARY KEY
game_id TEXT NOT NULL         -- Foreign key to games
sport TEXT NOT NULL
captured_at TEXT NOT NULL     -- ISO 8601 UTC (when odds were fetched)
h2h_home REAL
h2h_away REAL
total REAL
spread_home REAL
spread_away REAL
moneyline_home INTEGER
moneyline_away INTEGER
raw_data TEXT                 -- Full odds object (JSON stringified)
job_run_id TEXT               -- Foreign key to job_runs (links to which fetch this came from)
created_at TEXT NOT NULL
```

### API Changes (Data Flow)

**Before (shared-data):**
```
The Odds API → odds-fetcher → odds-cache.json → external models read JSON files
```

**After (cheddar-logic):**
```
The Odds API 
    ↓
shared-data/lib/odds-fetcher           ← Reused unchanged
    ↓
@cheddar-logic/adapters/odds-fetcher   ← Normalizes & persists
    ↓
@cheddar-logic/data/db.js              ← DB client
    ↓
SQLite odds_snapshots + job_runs       ← Canonical storage
    ↓
External models / web → Query DB directly (not JSON files)
```

### Running the Job

**Install:**
```bash
cd packages/data && npm install
cd ../adapters && npm install
cd ../../apps/worker && npm install
```

**Run:**
```bash
npm run job:pull-odds
```

**Expected output:**
- Creates SQLite DB at `$DATABASE_PATH` (default: `/tmp/cheddar-logic/cheddar.db`)
- Runs migrations (idempotent)
- Creates job_run record
- Fetches NHL, NBA, MLB odds via shared-data odds-fetcher
- Inserts odds_snapshots for each game
- Marks job_run as success
- Exit code 0

**Verify:**
```bash
sqlite3 /tmp/cheddar-logic/cheddar.db \
  "SELECT sport, COUNT(*) FROM odds_snapshots GROUP BY sport;"
```

### What This Enables

✅ **Sport runners** — Can now be pure functions: `(odds) → model outputs → persist to model_outputs table`

✅ **Web rendering** — Can display stored card payloads without re-running inference

✅ **Scheduling** — Decoupled from logic; can run from cron, systemd, Lambda, or daemon

✅ **Idempotency** — Automatic via job_run tracking; safe to retry on failure

✅ **Data hygiene** — Single source of truth; no more JSON files or multiple caches

✅ **Cross-repo coupling eliminated** — Everything imports from monorepo packages

### What Did NOT Change

- **shared-data repo behavior** — odds-fetcher logic untouched (same API calls, same formatting)
- **Environment variables** — Still uses shared-data env vars (API keys, timezone, etc)
- **API endpoints** — No breaking changes (this is infrastructure, not a service)
- **Backwards compatibility** — Old code can still read from shared-data while migration completes

### Next Phase (When Ready)

1. **Add more tables** — `model_outputs`, `card_payloads`
2. **Create sport runners** — NHL/NBA models that read from DB → write outputs
3. **Create web routes** — Render card_payloads from DB
4. **Archive shared-data** — Freeze to read-only once all consumers migrated

### Deployment Notes

**Current:** Worker job runs on demand (`npm run job:pull-odds`)

**To automate:**
- Add to cron: `0 */1 * * * cd /path/to/cheddar-logic/apps/worker && npm run job:pull-odds`
- Or systemd timer + service unit
- Or Lambda function (package job as zip, set DATABASE_PATH to RDS endpoint)

**Database backup:**
- SQLite file is at `$DATABASE_PATH`
- Standard backup: `cp cheddar.db cheddar.db.backup`
- Or use sqlite3 dump: `sqlite3 cheddar.db ".dump" > backup.sql`

---

**Ready to proceed to Phase 2: Add model_outputs + card_payloads tables?**
