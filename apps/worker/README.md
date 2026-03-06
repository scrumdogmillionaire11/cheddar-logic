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

# Or run from repo root
npm --prefix apps/worker run job:pull-odds

# Run with explicit DB path (use CHEDDAR_DB_PATH as canonical source)
CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db npm run job:pull-odds

# Run against production DB on the Pi
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db npm run job:pull-odds
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

- `CHEDDAR_DB_PATH`: **Recommended** - Single source of truth for SQLite database path
- `CHEDDAR_DATA_DIR`: Fallback directory for `cheddar.db` if CHEDDAR_DB_PATH is not set
- Any shared-data env vars (API keys, etc.)

**Legacy compatibility** (avoid setting these):

- `RECORD_DATABASE_PATH`, `DATABASE_PATH`, `DATABASE_URL`: Supported for backward compatibility, but setting multiple path variables will cause a conflict error. Use CHEDDAR_DB_PATH only.




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

```text
apps/worker/
├── src/
│   └── jobs/
│       └── pull_odds_hourly.js       ← Main job entrypoint
├── package.json
└── README.md
```

**Data flow:**

```text
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

```text
NHL|53
NBA|30
MLB|30
```

---


### pull_nhl_player_shots

Fetches NHL player landing data (last 5 games) and upserts shot logs for model input.

**Usage:**

```bash
# Install dependencies (one time)
npm install

# Run the job once
npm run job:pull-nhl-player-shots

# Or run from repo root
npm --prefix apps/worker run job:pull-nhl-player-shots

# Dry run (no DB writes)
node src/jobs/pull_nhl_player_shots.js --dry-run
```

**Environment variables:**

- `NHL_SOG_PLAYER_IDS`: Comma-separated list of NHL player IDs to pull
- `NHL_SOG_SLEEP_MS`: Delay between players (ms). Default: `500`
- `NHL_SOG_FETCH_RETRIES`: Max fetch retries per player. Default: `4`
- `CHEDDAR_DB_PATH`: **Recommended** - Single source of truth for database path


**Exit codes:**

- `0` = all player logs fetched and persisted successfully
- `1` = job failed


---

### run_nhl_player_shots_model

Generates NHL player SOG prop cards from recent shot logs.

**Usage:**

```bash
# Run the model after pull_nhl_player_shots
npm run job:run-nhl-player-shots-model

# Or run from repo root
npm --prefix apps/worker run job:run-nhl-player-shots-model
```

**Notes:**

- Requires recent data in `player_shot_logs` (last 7 days)
- Emits `nhl-player-shots` and `nhl-player-shots-1p` cards into `card_payloads`
