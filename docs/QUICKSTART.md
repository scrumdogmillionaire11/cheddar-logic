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

Discord snapshot safety gate: scheduler only posts per-game decision snapshots (🟢 official / 🟡 lean / ⚪ pass-blocked) at 09:00 / 12:00 / 18:00 ET when both `ENABLE_DISCORD_CARD_WEBHOOKS=true` and `DISCORD_CARD_WEBHOOK_URL` are set. If either is missing, job is a clean no-op.

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

Soccer market policy (ADR-0006): Asian Handicap is reintroduced as a Tier-1 **main-market** path (`asian_handicap_home`, `asian_handicap_away`) under `FOOTIE_MAIN_MARKETS`. It is separate from soccer props routing and should not be mixed with `SOCCER_PROP_EVENTS_ENABLED` prop ingestion.
AH cards must carry the canonical play envelope (`kind`, `recommended_bet_type`, `prediction`, `selection`) in addition to AH pricing fields (`line`, `price`, `side`, `split_flag`, `probabilities`, `expected_value`) so `/api/games` keeps them as playable spread rows.

Soccer runtime mode switch:

- `SOCCER_MODEL_MODE=SIDES_AND_PROPS` (default): emit side markets via `FOOTIE_SIDES_ENGINE` metadata path plus props.
- `SOCCER_MODEL_MODE=OHIO_PROPS_ONLY`: suppress odds-backed soccer side/main cards (`soccer_ml`, `soccer_game_total`, `soccer_double_chance`, `asian_handicap_home`, `asian_handicap_away`) and keep props/projection-only output only.

Soccer sides model note:

- Side cards (ML/AH) are now lambda-source aware. If only market-derived fallback lambdas are available, payloads are explicitly guarded with reason codes. Moneyline can be hard-blocked (`BLOCKED_MARKET_FALLBACK_ONLY`), while AH/spreads remain actionable with fallback diagnostics.
- To feed stats-primary lambdas, prewarm soccer xG cache before running `job:run-soccer-model`.

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
# ⚠️  Requires NHL_SOG_PROP_EVENTS_ENABLED=true in .env (default off — add to enable real Odds API lines)

# Run NHL player shots prop model (applies availability filter + purge)
npm --prefix apps/worker run job:run-nhl-player-shots-model

# Pull Soccer Tier-1 player props (optional manual run; scheduler now queues this before soccer model windows)
set -a; source .env; set +a; SOCCER_PROP_EVENTS_ENABLED=true npm --prefix apps/worker run job:pull-soccer-player-props

# Pull soccer team xG cache (recommended for stats-primary ML/AH side modeling)
# Requires ENABLE_SOCCER_XG_MODEL=true
set -a; source .env; set +a; ENABLE_SOCCER_XG_MODEL=true npm --prefix apps/worker run job:pull-soccer-xg-stats

# Prewarm team metrics cache (recommended before early model windows)
set -a; source .env; set +a; npm --prefix apps/worker run job:refresh-team-metrics

# Post Discord per-game decision snapshot (manual)
# Requires: ENABLE_DISCORD_CARD_WEBHOOKS=true and DISCORD_CARD_WEBHOOK_URL set
set -a; source .env; set +a; npm --prefix apps/worker run job:post-discord-cards

# Post Discord per-game decision snapshot on the Pi (production DB)
# Run from repo root on the Pi
set -a; source .env.production; set +a; ENABLE_DISCORD_CARD_WEBHOOKS=true CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db npm --prefix apps/worker run job:post-discord-cards

# Run models
set -a; source .env; set +a; npm --prefix apps/worker run job:run-nba-model
set -a; source .env; set +a; npm --prefix apps/worker run job:run-nhl-model
set -a; source .env; set +a; npm --prefix apps/worker run job:run-ncaam-model
set -a; source .env; set +a; npm --prefix apps/worker run job:run-soccer-model  
# Soccer Asian Spread (asian_handicap_home / asian_handicap_away)
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

# Pull Soccer Tier-1 player props (optional manual run; scheduler queues this before soccer model windows)
set -a; source .env; set +a; SOCCER_PROP_EVENTS_ENABLED=true npm --prefix apps/worker run job:pull-soccer-player-props

# Prewarm team metrics cache (recommended before early model windows)
set -a; source .env; set +a; npm --prefix apps/worker run job:refresh-team-metrics

# Post Discord per-game decision snapshot (manual)
set -a; source .env; set +a; npm --prefix apps/worker run job:post-discord-cards
```

#### 3) Run Jobs

```bash
export CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db

set -a; source .env; set +a; npm --prefix apps/worker run job:refresh-team-metrics
set -a; source .env; set +a; npm --prefix apps/worker run job:run-nba-model
set -a; source .env; set +a; npm --prefix apps/worker run job:run-nhl-model
npm --prefix apps/worker run job:run-nhl-player-shots-model
set -a; source .env; set +a; npm --prefix apps/worker run job:run-ncaam-model
set -a; source .env; set +a; npm --prefix apps/worker run job:run-soccer-model

# Post Discord per-game decision snapshot (manual)
set -a; source .env; set +a; npm --prefix apps/worker run job:post-discord-cards
```

#### 4) Verify Output

```bash
# Spot-check most recent cards in SQLite (requires sqlite3 CLI)
set -a; source .env; set +a; sqlite3 "$CHEDDAR_DB_PATH" \
  "SELECT sport, card_type, prediction, confidence, created_at FROM card_payloads ORDER BY created_at DESC LIMIT 10;"

# Spot-check AH output contract fields (canonical play envelope + AH pricing fields)
set -a; source .env; set +a; sqlite3 "$CHEDDAR_DB_PATH" \
  "SELECT card_type, json_extract(payload_data,'$.kind') AS kind, json_extract(payload_data,'$.recommended_bet_type') AS recommended_bet_type, json_extract(payload_data,'$.prediction') AS prediction, json_extract(payload_data,'$.selection.side') AS selection_side, json_extract(payload_data,'$.line') AS line, json_extract(payload_data,'$.price') AS price, json_extract(payload_data,'$.side') AS side, json_extract(payload_data,'$.split_flag') AS split_flag, json_extract(payload_data,'$.expected_value') AS expected_value FROM card_payloads WHERE card_type IN ('asian_handicap_home','asian_handicap_away') ORDER BY created_at DESC LIMIT 10;"

# Verify odds pipeline freshness against the same DB path
set -a; source .env; set +a; npm --prefix apps/worker run job:check-odds-health
```

### Ops Notes

- Jobs are idempotent when run with a jobKey. The CLI scripts use time-based job keys internally.
- Cards expire 1 hour before game start; stale odds will not emit cards.
- NHL 1P settling is the active focus and should continue recording/segmenting under results now.
- NHL player shots settling is active. Player shots cards route to the `nhl_player_shots_props` results segment.
- NCAAM cards are driver-based; if no cards appear, there may be no actionable signals.
- Projection completeness gate: NBA/NHL/NCAAM jobs now block per-game driver/pricing output when required projection inputs are missing. Logs show `PROJECTION_INPUTS_INCOMPLETE (...)` with explicit missing fields.

### Weekly Telemetry Go/No-Go (Soak Period)

During the 14–30 day telemetry soak window, run these three commands every 7 days starting at Day 7. All commands are copy/paste runnable from repo root.

```bash
# 1. Standard calibration report — review all signal values
npm --prefix apps/worker run job:report-telemetry-calibration

# 2. Enforce mode — exits non-zero only if sample gate is met AND threshold breached
npm --prefix apps/worker run job:report-telemetry-calibration -- --enforce

# 3. Capture JSON evidence for ops notes (timestamped)
npm --prefix apps/worker run job:report-telemetry-calibration -- --json > /tmp/soak-$(date +%Y%m%d).json
```

**Pass:** `--enforce` exits 0, OR all signals return `INSUFFICIENT_DATA` (sample gates not yet met).

**Fail:** `--enforce` exits non-zero AND at least one ledger has met its sample gate. Consult the Breach-to-Owner Table in [docs/DATA_PIPELINE_TROUBLESHOOTING.md](./DATA_PIPELINE_TROUBLESHOOTING.md#breach-to-owner-table) for the single owner and default rollback action for each breach type.

**Evidence capture:** After each weekly check, paste the checkpoint block (exit code, `win_rate`, `clv_mean`, `p25_clv`, `sample_size` for both ledgers, any breach messages verbatim) into ops notes using the evidence format in [docs/DATA_PIPELINE_TROUBLESHOOTING.md](./DATA_PIPELINE_TROUBLESHOOTING.md#weekly-evidence-capture-format).

> **Sample-size gate:** `INSUFFICIENT_DATA` means the ledger has fewer rows than the minimum sample gate (100 for projection, 150 for CLV). This is always a pass — do not treat it as a breach.

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

---

## Production Pre-Push: Soccer Regression Check

**REQUIRED before merging to main.** Soccer model changes have a history of silent degradation. Run this before any production deployment:

### Quick Check (5 min)

```bash
# 1. Verify dev has playable Soccer cards
DB_PATH=$(bash scripts/db-context.sh | awk -F': ' '/resolver path/ {print $2}') \
sqlite3 "$DB_PATH" \
  "SELECT 'soccer_playable_non_projection' as metric, COUNT(*) as count FROM card_payloads WHERE sport='soccer' AND json_extract(payload_data, '$.kind')='PLAY' AND COALESCE(CAST(json_extract(payload_data, '$.projection_only') AS INTEGER),0)=0 \
   UNION ALL \
   SELECT 'soccer_all_cards', COUNT(*) FROM card_payloads WHERE sport='soccer' \
   UNION ALL \
   SELECT 'soccer_model_outputs', COUNT(*) FROM model_outputs WHERE lower(sport)='soccer';"

# 2. Compare distribution to production baseline (should be within ±15% of current prod)
# Prod baseline (as of 2026-03-20):
#   - 23 playable SOCCER plays
#   - 4 market types (ML, GT, DC, PROP)
#   - CLV ledger: active entries
#   - NO PROJECTION_ONLY cards (Tier-1 props not running)

# 3. Check for blockers
DB_PATH=$(bash scripts/db-context.sh | awk -F': ' '/resolver path/ {print $2}') \
sqlite3 "$DB_PATH" << SQL
SELECT 'evidence_only_pass' as blocker, COUNT(*) as cnt
FROM card_payloads WHERE sport='soccer' AND json_extract(payload_data, '$.pass_reason_code') LIKE 'PASS_%'
UNION ALL
SELECT 'missing_data', COUNT(*) FROM card_payloads WHERE sport='soccer' AND json_extract(payload_data, '$.ingest_failure_reason_code') IS NOT NULL
UNION ALL
SELECT 'projection_incomplete', COUNT(*) FROM card_payloads WHERE sport='soccer' AND CAST(json_extract(payload_data, '$.projection_inputs_complete') AS INTEGER) = 0;
SQL
```

### Full Verification (if play count < 15)

```bash
# Run Soccer model with diagnostics
ENABLE_CLV_LEDGER=true \
set -a; source .env; set +a; npm --prefix apps/worker run job:run-soccer-model 2>&1 | tee /tmp/soccer-model.log

# Check logs for errors
grep -E "ERROR|FAIL|exception|PROJECTION_INPUTS_INCOMPLETE" /tmp/soccer-model.log || echo "✓ No errors"

# Check CLV ledger was written
DB_PATH=$(bash scripts/db-context.sh | awk -F': ' '/resolver path/ {print $2}') \
sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) as clv_entries_created FROM clv_ledger WHERE lower(sport)='soccer' AND created_at > datetime('now', '-2 hours');"

# Sample card quality
DB_PATH=$(bash scripts/db-context.sh | awk -F': ' '/resolver path/ {print $2}') \
sqlite3 "$DB_PATH" << SQL
SELECT 
  market_type,
  confidence,
  edge,
  card_type
FROM (
  SELECT 
    json_extract(payload_data, '$.market_type') as market_type,
    CAST(json_extract(payload_data, '$.confidence') AS REAL) as confidence,
    CAST(json_extract(payload_data, '$.edge') AS REAL) as edge,
    card_type,
    ROW_NUMBER() OVER (PARTITION BY json_extract(payload_data, '$.market_type') ORDER BY created_at DESC) as rn
  FROM card_payloads
  WHERE sport='soccer' AND json_extract(payload_data, '$.kind')='PLAY' AND COALESCE(CAST(json_extract(payload_data, '$.projection_only') AS INTEGER),0)=0
)
WHERE rn <= 3
ORDER BY market_type, created_at DESC;
SQL
```

### Root Cause Checklist (if plays missing)

| Check | Command | Expected | Action if fails |
| --- | --- | --- | --- |
| Odds fresh | `DB_PATH=... sqlite3 "$DB_PATH" "SELECT MAX(captured_at) FROM odds_snapshots WHERE sport='soccer';"` | Last 2 hours | Run `job:pull-odds` + `job:pull-soccer-player-props` |
| Model runs | `grep "=== runSoccerModel" /tmp/soccer-model.log \| tail -1` | Present + timestamp recent | Check scheduler logs |
| Projection gate | `grep "PROJECTION_INPUTS_INCOMPLETE" /tmp/soccer-model.log \| wc -l` | ~0 or <5% | Check ESPN enrichment; run `job:refresh-team-metrics` |
| Team mapping | `grep "Unknown team\|TEAM_MAPPING" /tmp/soccer-model.log` | None | Check `pull_soccer_xg_stats.js` team normalization |
| CLV ledger | `DB_PATH=... sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM clv_ledger WHERE lower(sport)='soccer';"` | >5 entries | Check `recordSoccerProjectionTelemetry()` is called |

### Pre-Production Acceptance

- ✅ Soccer playable card count: ≥15 (within ±20% of prod baseline of 23)
- ✅ No unresolved `PROJECTION_INPUTS_INCOMPLETE` logs
- ✅ All market types present: `soccer_ml`, `soccer_game_total`, `soccer_double_chance`
- ✅ CLV ledger active: ≥5 entries written in last 2 hours
- ✅ Zero `.log` errors containing "FAIL" or "exception"
- ✅ Edge distribution: mean >0.5%, no outliers >50%

**If any check fails: DO NOT MERGE.** Investigate with `/pax:debug soccer-regression` for root cause.

- ESPN enrichment missing:
  - Check worker logs for missing fields and refresh odds/enrichment before rerunning.
  - For NCAAM specifically, check for unresolved live-odds team variants such as `Seattle Redhawks` / `Seattle U Redhawks` or `St. Thomas (MN) Tommies` / `St. Thomas-Minnesota Tommies`; these leave games with odds but no emitted plays.
  - Quick log check: `grep -E "Unknown team: \"Seattle Redhawks\"|Unknown team: \"St\. Thomas \(MN\) Tommies\"" apps/worker/logs/scheduler.log`
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

# Prewarm team metrics cache on production DB (recommended before early model windows)
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db npm --prefix apps/worker run job:refresh-team-metrics

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
npm --prefix apps/worker run job:refresh-team-metrics
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
