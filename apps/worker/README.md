# apps/worker

Worker jobs for cheddar-logic: scheduled tasks, ETL jobs, model runs.

## NBA/NHL/NCAAM null-data diagnostic loop

Use this run order when tracking missing ESPN/projection inputs in the main Cheddar DB.

```bash
# 1) Load environment
set -a; source .env; set +a

# 2) Pre-warm team metrics cache (all sports)
npm run job:refresh-team-metrics

# 3) Pull latest odds snapshots
npm run job:pull-odds

# 4) Run each model (same shell/env)
npm run job:run-nba-model
npm run job:run-nhl-model
npm run job:run-ncaam-model
```

Structured null-data tags to filter:

```bash
# Projection-input blocks from model runners
grep -E "\[NBAModel\]\[PROJECTION_INPUTS_INCOMPLETE\]|\[NHLModel\]\[PROJECTION_INPUTS_INCOMPLETE\]|\[NCAAMModel\]\[PROJECTION_INPUTS_INCOMPLETE\]" logs/worker-*.log

# Team metrics / enrichment nulls from data layer
grep -E "\[TeamMetrics\]\[TEAM_METRICS_NULL\]|\[TeamMetrics\]\[TEAM_METRICS_ERROR\]|\[OddsEnrichment\]\[NULL_TEAM_METRICS\]|\[OddsEnrichment\]\[SOURCE_CONTRACT_FAILURE_TEAM_MAPPING\]" logs/worker-*.log
```

Known NCAAM live-odds aliases that previously caused prod `MISSING_DATA_NO_PLAYS` despite valid odds:

- `Seattle Redhawks` ↔ `Seattle U Redhawks`
- `St. Thomas (MN) Tommies` ↔ `St. Thomas-Minnesota Tommies`

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
set -a; source /opt/cheddar-logic/.env.production; set +a; npm run job:pull-odds
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

**Production Configuration:**

Canonical production DB path: `/opt/data/cheddar-prod.db` (validated by presence of `card_payloads` table with data)

- Set explicit `CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db` in `/opt/cheddar-logic/.env.production`
- Set `CHEDDAR_DB_AUTODISCOVER=false` to disable fallback auto-discovery
- Remove legacy variables: `DATABASE_PATH`, `RECORD_DATABASE_PATH`, `DATABASE_URL`

Validate production DB:

```bash
sqlite3 /opt/data/cheddar-prod.db "SELECT name FROM sqlite_master WHERE type='table' AND name='card_payloads';"
```

**Legacy compatibility** (deprecated in production):

- `RECORD_DATABASE_PATH`, `DATABASE_PATH`, `DATABASE_URL`: Supported for backward compatibility in local dev, but **must be removed from production config**. Setting multiple path variables causes a `DB_PATH_CONFLICT` error.




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
@cheddar-logic/odds               ← Fetch & normalize (wraps shared-data)
    ↓
@cheddar-logic/data               ← DB schema + queries
    ↓
SQLite (cheddar.db)               ← odds_snapshots table
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

See [@cheddar-logic/odds](../../packages/odds/) for odds-fetch/normalize coverage. The job tests DB persistence separately.

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
