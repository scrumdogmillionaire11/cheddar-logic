# Ingest Proof Runbook

Use these commands to verify the odds ingest pipeline is working correctly.

---

## Proof Commands

**Command 1: Run one odds ingest cycle**

```bash
cd /path/to/cheddar-logic/apps/worker
npm run job:pull-odds
```

**Command 2: Verify DB counts after ingest**

```bash
cd /path/to/cheddar-logic/packages/data
node -e "
const { initDb, getDatabase } = require('@cheddar-logic/data');
initDb().then(() => {
  const db = getDatabase();
  const games = db.prepare('SELECT COUNT(*) as n FROM games').get().n;
  const snaps = db.prepare('SELECT COUNT(*) as n FROM odds_snapshots').get().n;
  const jobs  = db.prepare('SELECT COUNT(*) as n FROM job_runs WHERE job_name = ?').get('pull_odds_hourly').n;
  console.log({ games, odds_snapshots: snaps, pull_odds_hourly_runs: jobs });
});
"
```

---

## Expected Output Shape

After a successful ingest, `npm run job:pull-odds` logs:

```
[PullOdds] Starting job run: job-pull-odds-<timestamp>-<id>
[PullOdds] Recording job start...
[PullOdds] Fetching odds for: NHL, NBA, MLB, NFL
[PullOdds] Processing NHL...
[Odds] Fetching NHL (36h horizon)...
[Odds] Got <N> raw games for NHL
[PullOdds]   Fetched <N> games
...
[PullOdds] Job complete: <N> games upserted, <N> snapshots inserted
```

DB count query returns:

```json
{ "games": 25, "odds_snapshots": 28, "pull_odds_hourly_runs": 3 }
```

Numbers will grow with each run (snapshots always insert, games upsert idempotently).

---

## Sample Output (Proof Snapshot — 2026-02-27)

Source: MIGRATION.md Step D proof snapshot.

```
pullOddsHourly jobKey odds|hourly|test2:
  gamesUpserted: 22
  snapshotsInserted: 22
  success: true

DB counts after run:
  games: 25
  odds_snapshots: 28
```

---

## Troubleshooting

### Failure 1: Provider returned 0 games

**Symptom:** `[PullOdds] No games returned for <sport>` — gamesUpserted stays 0.

**Likely causes:**
- shared-data odds-fetcher cache is stale or empty for that sport
- `hoursAhead=36` window has no upcoming games (off-season, late night)
- shared-data module not found at expected path

**Fix:** Check `packages/odds/src/index.js` path to shared-data:

```js
sharedDataOddsFetcher = require('/path/to/shared-data/lib/odds-fetcher.js');
```

Confirm the file exists and getUpcomingGames returns a non-empty array for the sport.

---

### Failure 2: Normalization skipped too many games (contract violation)

**Symptom:** `[PullOdds] CONTRACT VIOLATION: <sport> normalized <N>/<M> games (threshold 60%). Marking job failed.` — job exits with `success: false`.

**Likely causes:**
- Provider payload shape changed (missing `home_team`, `away_team`, or `commence_time` fields)
- A new sport's data format differs from expected schema in normalize.js

**Fix:** Inspect raw payload from getUpcomingGames. Compare against normalize.js required fields:
`gameId`, `home_team`, `away_team`, `commence_time`. Update normalize.js field mappings if provider changed.

---

### Failure 3: DB path mismatch

**Symptom:** `Error: SQLITE_CANTOPEN: unable to open database file` or games count stays 0 despite successful log output.

**Likely causes:**
- packages/data is looking for DB at a path that doesn't exist yet
- Running from wrong working directory (initDb uses relative path resolution)
- DB file was deleted or moved

**Fix:** Run `npm run job:pull-odds` from `apps/worker/` directory (not project root).
Check packages/data/src/db.js for DB_PATH resolution. Ensure the data directory is writable.

```bash
ls -la /path/to/cheddar-logic/packages/data/db/
```

---

_Last verified: 2026-02-27. See MIGRATION.md Step D for full proof transcript._
