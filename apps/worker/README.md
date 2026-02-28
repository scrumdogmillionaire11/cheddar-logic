# apps/worker

Worker jobs for cheddar-logic: scheduled tasks, ETL jobs, model runs.

## Jobs

### pull_odds_hourly

Fetches current odds from The Odds API and persists snapshots to the canonical database.

**Usage:**
```bash
# Install dependencies (one time)
npm install

# Run the job once
npm run job:pull-odds

# Run with local env
DATABASE_PATH=/tmp/cheddar.db npm run job:pull-odds
```

**What it does:**
1. Create a job_run record to track execution
2. Fetch active sports (NHL, NBA, MLB) from The Odds API
3. For each sport:
   - Fetch current game odds
   - Insert odds_snapshots into DB with captured_at timestamp
4. Mark job_run as success or record failure

**Exit codes:**
- `0` = all odds fetched and persisted successfully
- `1` = job failed (see logs for details)

**Environment variables:**
- `DATABASE_PATH`: Path to SQLite database (default: `/tmp/cheddar-logic/cheddar.db`)
- `CHEDDAR_DATA_DIR`: Data directory for DB (default: `/tmp/cheddar-logic`)
- Any shared-data env vars (API keys, etc.)

**Idempotency:**
Each job run is uniquely identified and recorded in `job_runs` table:
```sql
id: job-pull-odds-2026-02-27T07:00:00-abc123
job_name: pull_odds_hourly
status: success
started_at: 2026-02-27T07:00:00.000Z
ended_at: 2026-02-27T07:00:15.000Z
```

## Architecture

```
apps/worker/
├── src/
│   └── jobs/
│       └── pull_odds_hourly.js       ← Main job entrypoint
├── package.json
└── README.md
```

**Data flow:**
```
The Odds API
    ↓
shared-data/lib/odds-fetcher.js  ← Fetch & format
    ↓
@cheddar-logic/adapters          ← Normalize & persist
    ↓
@cheddar-logic/data              ← DB schema + queries
    ↓
SQLite (cheddar.db)              ← odds_snapshots table
```

## Integration with Scheduler

To run this job on a schedule (e.g., every hour):

**cron:**
```bash
0 * * * * cd /path/to/cheddar-logic/apps/worker && npm run job:pull-odds
```

**systemd timer:**
```ini
[Unit]
Description=Fetch odds every hour
After=network.target

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Unit=cheddar-pull-odds.service

[Install]
WantedBy=timers.target
```

## Testing

See [shared-data test suite](../../shared-data/). The adapter assumes odds-fetcher works correctly; we test the DB persistence separately.

Example smoke test:

```bash
# Run job
npm run job:pull-odds

# Query results
sqlite3 /tmp/cheddar-logic/cheddar.db \
  "SELECT sport, COUNT(*) as snapshots FROM odds_snapshots GROUP BY sport;"
```

Expected output (assuming 3 sports × N games):
```
NHL|53
NBA|30
MLB|30
```
