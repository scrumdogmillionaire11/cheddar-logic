# QUICKSTART.md

## Automated Setup (Recommended)

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

```bash
npm --prefix web run dev
```

**Tab 2 — Scheduler** (automatic hourly pulls + model runs)

```bash
./scripts/start-scheduler.sh
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

# Pull live odds (requires ODDS_API_KEY from https://theoddsapi.com)
ODDS_API_KEY=YOUR_ACTUAL_KEY_HERE npm --prefix apps/worker run job:pull-odds

# Run models
npm --prefix apps/worker run job:run-nba-model
npm --prefix apps/worker run job:run-nhl-model
npm --prefix apps/worker run job:run-ncaam-model
```

### Standard Runbook

#### 1) Install and Migrate

```bash
npm --prefix packages/data install
npm --prefix apps/worker install
npm --prefix packages/data run migrate
```

#### 2) Ingest Odds

```bash
# Pull live odds from The Odds API
# Get your free key from: https://theoddsapi.com
ODDS_API_KEY=YOUR_ACTUAL_KEY_HERE npm --prefix apps/worker run job:pull-odds
```

#### 3) Run Jobs

```bash
npm --prefix apps/worker run job:run-nba-model
npm --prefix apps/worker run job:run-nhl-model
npm --prefix apps/worker run job:run-ncaam-model
```

#### 4) Verify Output

```bash
# Spot-check most recent cards in SQLite (requires sqlite3 CLI)
sqlite3 packages/data/data/cheddar.db \
  "SELECT sport, card_type, prediction, confidence, created_at FROM card_payloads ORDER BY created_at DESC LIMIT 10;"
```

### Ops Notes

- Jobs are idempotent when run with a jobKey. The CLI scripts use time-based job keys internally.
- Cards expire 1 hour before game start; stale odds will not emit cards.
- NCAAM cards are driver-based; if no cards appear, there may be no actionable signals.

### Troubleshooting

- No cards generated:
  - Ensure odds exist in the DB for the sport and time window.
  - Run seed data and try again.
- ESPN enrichment missing:
  - Jobs degrade gracefully; drivers will skip if required metrics are missing.
- Validation failure:
  - Inspect payload_data for missing fields required by card schema.

### Related Commands

```bash
# Run all tests in data package
npm --prefix packages/data test

# Start scheduler (if configured)
npm --prefix apps/worker run scheduler
```
