# docs/QUICKSTART.md

## Automated Setup (Recommended)

### Runtime Modes (Important)

- **Local mode** (recommended for model testing): web + worker + scheduler all use one local DB via `CHEDDAR_DB_PATH`.
- **Snapshot mode** (read-only parity checks): web reads `~/.cheddar/prod-snapshot.db`; do not run worker/scheduler jobs against this DB.

Mode comparison:

| Mode | Primary use | Expected DB path | Processes that should run | Writes allowed |
| --- | --- | --- | --- | --- |
| Local | Development + model runs | `'/tmp/cheddar-logic/cheddar.db'` (default) | Web + Worker + Scheduler | Yes (worker only) |
| Snapshot | Parity checks against prod snapshot | `'~/.cheddar/prod-snapshot.db'` | Web only | No |

Single-writer contract: worker is the only process that writes to the DB. Web must stay read-only. See [docs/decisions/ADR-0002-single-writer-db-contract.md](docs/decisions/ADR-0002-single-writer-db-contract.md).

Mode switching:

1. Stop web and scheduler.
2. Update `CHEDDAR_DB_PATH` (and `CHEDDAR_DATA_DIR` if you use it).
3. Restart web and scheduler.
4. Verify with `bash scripts/db-context.sh`.

Use these helpers to verify your active mode:

```bash
bash scripts/dev-mode-local.sh --check
bash scripts/dev-mode-snapshot.sh --check
```

### One-Time Setup

```bash
# Install all packages
npm --prefix packages/data install
npm --prefix apps/worker install
npm --prefix web install

# Initialize database
npm --prefix packages/data run migrate
```

### Daily Operation (3 Terminal Tabs)

**Important:** Run all commands from the repo root (`/Users/ajcolubiale/projects/cheddar-logic`), not from subdirectories.

**Tab 1 — Web App** ([localhost:3000](http://localhost:3000))

**Important:** use the same `CHEDDAR_DB_PATH` for web + worker. If these differ, UI can show stale/broken cards even when jobs succeed.

Production configuration:

- **Recommended:** Set explicit `CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db` (prevents ambiguity)
- **Fallback:** `CHEDDAR_DATA_DIR=/opt/data` enables auto-discovery (scans for databases with `card_payloads`, prefers `-prod` in filename)

Validate production DB:

```bash
sqlite3 "$CHEDDAR_DB_PATH" "SELECT COUNT(*) FROM card_payloads;"
```

```bash
CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db npm --prefix web run dev
```

**Tab 2 — Scheduler** (automatic hourly pulls + model runs)

```bash
./scripts/start-scheduler.sh
```

**DB consistency note:** keep one canonical DB path in `.env` so scheduler + manual commands hit the same file:

```bash
# Use ONLY CHEDDAR_DB_PATH - legacy vars (DATABASE_PATH, RECORD_DATABASE_PATH, DATABASE_URL) must not be set in production
CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db
```

**Tab 3 — Watch Logs** (optional)

```bash
./scripts/manage-scheduler.sh logs
```

**Status & Management:**

```bash
./scripts/manage-scheduler.sh status    # Check if running
./scripts/manage-scheduler.sh restart   # Restart scheduler
./scripts/manage-scheduler.sh stop      # Stop scheduler
./scripts/manage-scheduler.sh db        # Show expected vs active DB path
```

Your cheddar board updates automatically. See [AUTOMATED_SETUP.md](AUTOMATED_SETUP.md) for full documentation.

---

## Manual Job Execution (For Testing)

### Worker Model Jobs (NBA/NHL/NCAAM)

### Quickstart

```bash
npm --prefix packages/data install
npm --prefix apps/worker install

npm --prefix packages/data run migrate

# Start web against the SAME DB path used by worker jobs
CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db npm --prefix web run dev

# Pin local mode DB path for all worker commands in this shell
export CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db

# Pull live odds (requires ODDS_API_KEY from https://theoddsapi.com)
set -a; source .env; set +a; npm --prefix apps/worker run job:pull-odds

# Pull Player Shots data 
npm --prefix apps/worker run job:pull-nhl-player-shots

# Sync NHL player availability (refreshes INJURED/DTD/ACTIVE status)
npm --prefix apps/worker run job:sync-nhl-player-availability

# Pull NHL player shots props
set -a; source .env; set +a; npm --prefix apps/worker run job:pull-nhl-player-shots-props

# Run NHL player shots prop model (applies availability filter + purge)
npm --prefix apps/worker run job:run-nhl-player-shots-model

# Pull Soccer Tier-1 player props (manual for now; not scheduled)
set -a; source .env; set +a; SOCCER_PROP_EVENTS_ENABLED=true npm --prefix apps/worker run job:pull-soccer-player-props

# Run models
set -a; source .env; set +a; npm --prefix apps/worker run job:run-nba-model
set -a; source .env; set +a; npm --prefix apps/worker run job:run-nhl-model
set -a; source .env; set +a; npm --prefix apps/worker run job:run-ncaam-model
set -a; source .env; set +a; npm --prefix apps/worker run job:run-soccer-model
```

### Standard Runbook

#### 1) Install and Migrate

```bash
npm --prefix packages/data install
npm --prefix apps/worker install
npm --prefix packages/data run migrate
```

#### 2) Ingest Odds / Player Data

```bash
# Pull live odds from The Odds API
# Get your free key from: https://theoddsapi.com
set -a; source .env; set +a; npm --prefix apps/worker run job:pull-odds

# Pull NHL player shots props (separate pull — required before running NHL model for player prop cards)
set -a; source .env; set +a; npm --prefix apps/worker run job:pull-nhl-player-shots-props

# Sync NHL player availability before prop model run (ensures injured players are filtered)
npm --prefix apps/worker run job:sync-nhl-player-availability

# Run NHL player shots prop model after lines + availability refresh
npm --prefix apps/worker run job:run-nhl-player-shots-model

# Pull Soccer Tier-1 player props (manual for now; scheduler omits this pull)
set -a; source .env; set +a; SOCCER_PROP_EVENTS_ENABLED=true npm --prefix apps/worker run job:pull-soccer-player-props
```

#### 3) Run Jobs

```bash
export CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db

set -a; source .env; set +a; npm --prefix apps/worker run job:run-nba-model
set -a; source .env; set +a; npm --prefix apps/worker run job:run-nhl-model
npm --prefix apps/worker run job:run-nhl-player-shots-model
set -a; source .env; set +a; npm --prefix apps/worker run job:run-ncaam-model
set -a; source .env; set +a; npm --prefix apps/worker run job:run-soccer-model
```

#### 4) Verify Output

```bash
# Spot-check most recent cards in SQLite (requires sqlite3 CLI)
set -a; source .env; set +a; sqlite3 "$CHEDDAR_DB_PATH" \
  "SELECT sport, card_type, prediction, confidence, created_at FROM card_payloads ORDER BY created_at DESC LIMIT 10;"

# Verify odds pipeline freshness against the same DB path
set -a; source .env; set +a; npm --prefix apps/worker run job:check-odds-health
```

### Ops Notes

- Jobs are idempotent when run with a jobKey. The CLI scripts use time-based job keys internally.
- Cards expire 1 hour before game start; stale odds will not emit cards.
- NCAAM cards are driver-based; if no cards appear, there may be no actionable signals.
- Projection completeness gate: NBA/NHL/NCAAM jobs now block per-game driver/pricing output when required projection inputs are missing. Logs show `PROJECTION_INPUTS_INCOMPLETE (...)` with explicit missing fields.

### Troubleshooting

- Confirm active mode/path before running jobs:
  - `bash scripts/db-context.sh`
- Confirm scheduler is using the same DB path:
  - `./scripts/manage-scheduler.sh db`
- Snapshot mode mismatch symptom (worker logs cards, UI empty):
  - Web is reading `~/.cheddar/prod-snapshot.db` while worker writes local DB.
  - Fix by restarting web with your local `CHEDDAR_DB_PATH`.

- No cards generated:
  - Ensure odds exist in the DB for the sport and time window.
  - Run seed data and try again.
- ESPN enrichment missing:
  - Jobs degrade gracefully; games with missing required projection fields are gated with `PROJECTION_INPUTS_INCOMPLETE`.
  - Check worker logs for missing fields and refresh odds/enrichment before rerunning.
- Enrichment persistence warning:
  - If you see `Failed to persist enrichment payload`, the run continues in-memory for that game, but you should rerun ingestion to restore DB persistence consistency.
- Validation failure:
  - Inspect payload_data for missing fields required by card schema.
- Database corruption ("database disk image is malformed"):
  - Stop the scheduler: `./scripts/manage-scheduler.sh stop`
  - Back up the DB: `cp "$CHEDDAR_DB_PATH" "$CHEDDAR_DB_PATH.corrupt"`
  - Run an integrity check: `sqlite3 "$CHEDDAR_DB_PATH" "PRAGMA integrity_check;"`
  - Restore from a known-good backup or re-run migrations to a fresh DB.

### Related Commands

```bash
# Run all tests in data package
npm --prefix packages/data test

# Start scheduler (if configured)
npm --prefix apps/worker run scheduler
```

---

## Production/Pi Manual Execution

**Important:** The scheduler must be stopped before running manual jobs to avoid database lock conflicts due to the single-writer contract.

### Quick Commands (Production)

```bash
# Stop scheduler
./scripts/manage-scheduler.sh stop

# Verify scheduler is stopped before manual writes
./scripts/manage-scheduler.sh status

# Run models with production DB
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db npm --prefix apps/worker run job:run-nba-model
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db npm --prefix apps/worker run job:run-nhl-model
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db npm --prefix apps/worker run job:run-ncaam-model
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db npm --prefix apps/worker run job:run-soccer-model

# Restart scheduler
./scripts/manage-scheduler.sh start

# Verify scheduler resumed on the same DB path
./scripts/manage-scheduler.sh db
```

### With .env.production

```bash
# Stop scheduler
./scripts/manage-scheduler.sh stop

# Load production env and run models
cd /opt/cheddar-logic
set -a; source .env.production; set +a
npm --prefix apps/worker run job:run-nba-model
npm --prefix apps/worker run job:run-nhl-model
npm --prefix apps/worker run job:run-ncaam-model
npm --prefix apps/worker run job:run-soccer-model

# Restart scheduler
./scripts/manage-scheduler.sh start
```

**Note:** The single-writer contract prevents simultaneous DB access. Always stop the scheduler before manual runs to avoid "Refusing to open /opt/data/cheddar-prod.db because another process holds the lock" errors.

---

## Frontend Testing (Web)

Run focused checks from the repo root:

```bash
# Lint the Next.js app
npm --prefix web run lint

# Contract and UI smoke tests
npm --prefix web run test:api:games:market
npm --prefix web run test:ui:cards
npm --prefix web run test:ui:results

# Full canonical decision guard
npm --prefix web run test:decision:canonical
```

If you need a one-shot script:

```bash
#!/usr/bin/env bash
set -euo pipefail

npm --prefix web run lint
npm --prefix web run test:api:games:market
npm --prefix web run test:ui:cards
npm --prefix web run test:ui:results
npm --prefix web run test:decision:canonical
```
