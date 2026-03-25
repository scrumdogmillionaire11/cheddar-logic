---
phase: mlb-model-port
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/data/db/migrations/040_create_mlb_pitcher_stats.sql
  - apps/worker/src/jobs/pull_mlb_pitcher_stats.js
autonomous: true
must_haves:
  truths:
    - "mlb_pitcher_stats table exists in DB with correct schema (id, mlb_id UNIQUE, era, whip, k_per_9, innings_pitched, recent_k_per_9, recent_ip, updated_at)."
    - "pull_mlb_pitcher_stats job fetches today's probable pitchers from statsapi.mlb.com, computes recent_k_per_9 and recent_ip from last 5 starts, upserts to DB."
    - "Job follows pull_nhl_team_stats.js pattern: withDb, insertJobRun/markJobRunSuccess/markJobRunFailure, shouldRunJobKey, dryRun support, module.exports."
  artifacts:
    - path: "packages/data/db/migrations/040_create_mlb_pitcher_stats.sql"
      provides: "mlb_pitcher_stats table DDL"
    - path: "apps/worker/src/jobs/pull_mlb_pitcher_stats.js"
      provides: "Ingest job that upserts pitcher season + recent stats before model runs"
  key_links:
    - from: "apps/worker/src/jobs/pull_mlb_pitcher_stats.js"
      to: "packages/data/db/migrations/040_create_mlb_pitcher_stats.sql"
      via: "CREATE TABLE IF NOT EXISTS mlb_pitcher_stats inside ensurePitcherStatsTable()"
      pattern: "ensurePitcherStatsTable|mlb_pitcher_stats"
---

<objective>
Stand up the MLB pitcher stats DB table and ingest job.

Purpose: Pull today's probable pitcher stats from the free MLB Stats API and store them flat (with pre-computed recent_k_per_9) so the model layer can read them synchronously.
Output: Migration SQL + working pull job that can be run standalone or from scheduler.
</objective>

<context>
@apps/worker/src/jobs/pull_nhl_team_stats.js
@packages/data/db/migrations/039_player_prop_lines_line_unique.sql
</context>

<tasks>

<task type="auto">
  <name>Task 1: Write migration 040_create_mlb_pitcher_stats.sql</name>
  <files>packages/data/db/migrations/040_create_mlb_pitcher_stats.sql</files>
  <action>Create migration SQL:

```sql
CREATE TABLE IF NOT EXISTS mlb_pitcher_stats (
  id            TEXT PRIMARY KEY,
  mlb_id        INTEGER NOT NULL UNIQUE,
  full_name     TEXT,
  team          TEXT,
  season        INTEGER,
  era           REAL,
  whip          REAL,
  k_per_9       REAL,
  innings_pitched REAL,
  recent_k_per_9  REAL,
  recent_ip       REAL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mlb_pitcher_stats_mlb_id
  ON mlb_pitcher_stats (mlb_id);
```

No down migration needed.</action>
  <verify>node -e "const db=require('@cheddar-logic/data').getDatabase(); console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='mlb_pitcher_stats'\").get())"</verify>
  <done>Table exists in DB after migration runs.</done>
</task>

<task type="auto">
  <name>Task 2: Implement pull_mlb_pitcher_stats.js</name>
  <files>apps/worker/src/jobs/pull_mlb_pitcher_stats.js</files>
  <action>Create the ingest job. Follow pull_nhl_team_stats.js pattern exactly. Key implementation points:

1. MLB Stats API base: `https://statsapi.mlb.com/api/v1`
2. Get probable pitchers: `GET /schedule?sportId=1&date=YYYY-MM-DD&hydrate=probablePitcher(note),team`
   - Extract unique pitcher IDs from `dates[].games[].teams.home/away.probablePitcher.id`
   - Deduplicate — same pitcher can appear in both home/away if double-header
3. For each pitcher ID (fetch in parallel with Promise.all):
   - Season stats: `GET /people/{id}/stats?stats=season&season=2026&group=pitching`
     → Extract: era, whip, strikeOuts, inningsPitched (compute k_per_9 = strikeOuts / IP * 9)
   - Game log (last 5): `GET /people/{id}/stats?stats=gameLog&season=2026&group=pitching`
     → Take last 5 entries, compute:
       - `recent_k_per_9` = total strikeOuts / total inningsPitched * 9
       - `recent_ip` = total inningsPitched / count (avg IP per start)
4. `ensurePitcherStatsTable(db)` — CREATE TABLE IF NOT EXISTS inline (same as NHL pattern)
5. Upsert: `INSERT INTO mlb_pitcher_stats ... ON CONFLICT(mlb_id) DO UPDATE SET ...`
6. `id` = `uuid` generated at upsert time
7. Export: `{ JOB_NAME, pullMlbPitcherStats, parseCliArgs }` + `require.main === module` block
8. Derive today's date as `new Date().toISOString().slice(0, 10)` for schedule endpoint

Guard against missing/null stats (pitcher may not have pitched yet in 2026) — store nulls gracefully.</action>
  <verify>node apps/worker/src/jobs/pull_mlb_pitcher_stats.js --dry-run</verify>
  <done>Dry run exits 0. Live run (if API reachable) upserts rows and logs count.</done>
</task>

</tasks>

<verification>
- node apps/worker/src/jobs/pull_mlb_pitcher_stats.js --dry-run exits 0
- node -e "require('./apps/worker/src/jobs/pull_mlb_pitcher_stats')" loads without error
</verification>

<success_criteria>
- Migration SQL is idempotent (CREATE IF NOT EXISTS)
- Job follows withDb/insertJobRun/markJobRunSuccess/markJobRunFailure pattern exactly
- dryRun=true skips all DB writes and network calls
- Missing pitcher stats stored as null (not throw)
</success_criteria>

<output>
After completion, create `.planning/phases/mlb-model-port/mlb-01-SUMMARY.md`
</output>
