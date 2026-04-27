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

### DB Lock Warnings in Dev

Local mode still follows the single-writer contract: worker/scheduler jobs own writes, and web reads only. If a manual non-production command opens the same DB while another local process owns `$CHEDDAR_DB_PATH.lock`, you may see:

```text
[DB] Refusing to open ... because another process holds the lock (..., pid=...). Set CHEDDAR_DB_ALLOW_MULTI_PROCESS=true to bypass.
```

In non-production this warning is informational and rate-limited for the same DB path, lock path, and owner PID. Fresh Node processes may suppress repeat warnings for 10 minutes, so lack of a repeated warning does not mean the lock disappeared.

Action is only needed when the DB path, lock path, or owner PID changes unexpectedly, the warning keeps returning after the rate-limit window, or the command is running against production. For production or maintenance/backfill work, stop the worker/scheduler first, run the job, then restart it. Do not use `CHEDDAR_DB_ALLOW_MULTI_PROCESS=true` in production.

## Manual Job Execution (For Testing)

### Worker Model Jobs (NBA/NHL/MLB)

> **Active models (2026-03-24):** NBA ✅ | NHL ✅ | MLB ✅ | NCAAM ❌ off-season | Soccer ❌ disabled (budget) | NHL SOG props ❌ disabled (500-token budget)

Soccer market policy (ADR-0006): Asian Handicap is reintroduced as a Tier-1 **main-market** path (`asian_handicap_home`, `asian_handicap_away`) under `FOOTIE_MAIN_MARKETS`. It is separate from soccer props routing and should not be mixed with `SOCCER_PROP_EVENTS_ENABLED` prop ingestion.
AH cards must carry the canonical play envelope (`kind`, `recommended_bet_type`, `prediction`, `selection`) in addition to AH pricing fields (`line`, `price`, `side`, `split_flag`, `probabilities`, `expected_value`) so `/api/games` keeps them as playable spread rows.

Soccer runtime mode switch:

- `SOCCER_MODEL_MODE=SIDES_AND_PROPS` (default): emit side markets via `FOOTIE_SIDES_ENGINE` metadata path plus props.
- `SOCCER_MODEL_MODE=OHIO_PROPS_ONLY`: suppress odds-backed soccer side/main cards (`soccer_ml`, `soccer_game_total`, `soccer_double_chance`, `asian_handicap_home`, `asian_handicap_away`) and keep props/projection-only output only.

Soccer sides model note:

- Side cards (ML/AH) are now lambda-source aware. If only market-derived fallback lambdas are available, payloads are explicitly guarded with reason codes. Moneyline can be hard-blocked (`BLOCKED_MARKET_FALLBACK_ONLY`), while AH/spreads remain actionable with fallback diagnostics.
- The current worker package does not ship a runnable soccer model command. Treat soccer notes in this document as design/reference material until a new worker runner is introduced.

MLB model note:

- The scheduler pulls pitcher stats and weather automatically before each model window. For manual runs, pull them first with `node apps/worker/src/jobs/pull_mlb_pitcher_stats.js` and `node apps/worker/src/jobs/pull_mlb_weather.js`.
- F5 first-half settlement runs automatically on every scheduler tick (`settle_mlb_f5`). No manual action needed.
- Controlled by `ENABLE_MLB_MODEL` env flag (default **on** — set `ENABLE_MLB_MODEL=false` to disable).
- **Opening Day / season-start behavior:** MLB Stats API returns no 2026 stats until the first game is played. `pull_mlb_pitcher_stats` automatically falls back to 2025 season stats and sets `days_since_last_start = 5` (approximating a spring training start 4-6 days prior). This is correct — the EXTENDED_REST gate (`>= 10 days`) is designed for mid-season IL returns, not Opening Day. If you skip the pitcher stats pull, the K engine will see the actual last-start date from October 2025 (~175 days), trigger EXTENDED_REST on every pitcher, and block all K cards. Always run `pull_mlb_pitcher_stats` before `run_mlb_model` at season start.

MLB pitcher K prop note:

- Pitcher K (strikeout over/under) cards are emitted by `job:run-mlb-model` — no separate job required.
- Cards are projection-only for now. They emit with `basis: 'PROJECTION_ONLY'`, `prediction: 'PASS'`, `tags: ['no_odds_mode']`, and do not depend on live strikeout odds ingestion.
- There are no paid Odds API pitcher-K prop pulls in the current runtime path. If free DraftKings/FanDuel or aggregator line sourcing is added later, that must ship in a separate WI/ADR first.
- Cards appear under the **Props** tab with stat-group filter `Strikeouts`. Use preset **Strikeouts Focus** to view only pitcher K cards.
- Triage: if no pitcher K cards appear, ensure `ENABLE_MLB_MODEL` is not `false` and at least one game with pitcher stats has odds within the active window.


### Mega Commands

All require env loaded. Run from repo root with `set -a; source .env; set +a` first.

| Command | What it does |
| --- | --- |
| `job:refresh-everything` | **Full daily run** — BLK data + game lines + player props + POTD |
| `job:refresh-game-lines` | Game lines only: pull odds → team metrics → MLB pitcher stats + weather → run NBA / NHL / MLB models |
| `job:refresh-player-props` | Player props only: pull NHL shot data → sync availability → run NHL shots model |
| `job:refresh-nhl-blk-data` | NHL blocked-shot data only: sync IDs → pull game BLK → ingest NST rates |
| `job:refresh-all` | Game lines + player props (no BLK, no POTD) |

```bash
# ── EVERYTHING (daily full run) ──────────────────────────────────────────────
set -a; source .env; set +a; npm --prefix apps/worker run job:refresh-everything

# ── GAME LINES only ──────────────────────────────────────────────────────────
# NBA/NHL/MLB spread, ML, totals. Game props (NHL 1P, MLB F5) come out of these
# same model runs — there is no separate game-props command.
set -a; source .env; set +a; npm --prefix apps/worker run job:refresh-game-lines

# ── PLAYER PROPS only ────────────────────────────────────────────────────────
# Pulls raw NHL shot data, syncs availability, runs NHL shots model.
set -a; source .env; set +a; npm --prefix apps/worker run job:refresh-player-props

# ── POTD only ────────────────────────────────────────────────────────────────
# Re-run POTD engine after a game-lines refresh.
set -a; source .env; set +a; npm --prefix apps/worker run job:run-potd-engine
```

> **Game Props note:** NHL 1P totals and MLB F5 are projection-only surfaces emitted by `run-nhl-model` and `run-mlb-model` respectively — they are part of `job:refresh-game-lines`, not a separate surface.
> `NCAAM` and `Soccer` worker runner commands are not available in the current package. Do not document manual `job:run-ncaam-model` or `job:run-soccer-model` flows until those files are restored.

---

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

# Pull NHL blocked-shot player data (sync IDs → pull game BLK → ingest NST rates)
# Scheduler automates this daily; run manually when refreshing the BLK model surface
npm --prefix apps/worker run job:refresh-nhl-blk-data

# Sync NHL player availability (refreshes INJURED/DTD/ACTIVE status)
npm --prefix apps/worker run job:sync-nhl-player-availability

# Run NHL player shots prop model (runs on cached/stale lines even without prop pull)
npm --prefix apps/worker run job:run-nhl-player-shots-model

# Prewarm team metrics cache (recommended before early model windows)
set -a; source .env; set +a; npm --prefix apps/worker run job:refresh-team-metrics

# Pull MLB pitcher stats + weather (no npm script — run directly; scheduler does this automatically)
node apps/worker/src/jobs/pull_mlb_pitcher_stats.js
node apps/worker/src/jobs/pull_mlb_weather.js

# Run models (ACTIVE)
set -a; source .env; set +a; npm --prefix apps/worker run job:run-nba-model
set -a; source .env; set +a; npm --prefix apps/worker run job:run-nhl-model
set -a; source .env; set +a; npm --prefix apps/worker run job:run-mlb-model

# Run POTD engine (Pick of the Day selection; scheduler runs this at 09:00 ET primary window)
set -a; source .env; set +a; npm --prefix apps/worker run job:run-potd-engine

# Post Discord per-game decision snapshot on the Pi (production DB)
# Run from repo root on the Pi
set -a; source .env.production; set +a; ENABLE_DISCORD_CARD_WEBHOOKS=true CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db npm --prefix apps/worker run job:post-discord-cards

# Post Discord per-game decision snapshot (manual)
# Requires: ENABLE_DISCORD_CARD_WEBHOOKS=true and DISCORD_CARD_WEBHOOK_URL set
set -a; source .env; set +a; npm --prefix apps/worker run job:post-discord-cards

# Soccer and NCAAM worker runner commands were removed in WI-0894.
# Keep local verification limited to the active worker jobs listed above.
# Live NHL player prop-line pulls were removed in WI-0727; this lane is projection-only.

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

# Sync NHL player availability before prop model run (ensures injured players are filtered)
npm --prefix apps/worker run job:sync-nhl-player-availability

# Run NHL player shots prop model (projection-only synthetic-line path)
npm --prefix apps/worker run job:run-nhl-player-shots-model

# DISABLED — Soccer player props off (soccer model disabled, 2026-03-24)
# set -a; source .env; set +a; SOCCER_PROP_EVENTS_ENABLED=true npm --prefix apps/worker run job:pull-soccer-player-props

# Pull NHL blocked-shot player data (sync IDs → pull game BLK → ingest NST rates)
npm --prefix apps/worker run job:refresh-nhl-blk-data

# Pull MLB pitcher stats + weather before model (scheduler does this automatically pre-window)
node apps/worker/src/jobs/pull_mlb_pitcher_stats.js
node apps/worker/src/jobs/pull_mlb_weather.js

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
set -a; source .env; set +a; npm --prefix apps/worker run job:run-mlb-model
set -a; source .env; set +a; npm --prefix apps/worker run job:run-potd-engine

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

# Verify projection accuracy health (projection engine confidence scores + trust statuses)
set -a; source .env; set +a; npm --prefix apps/worker run job:projection-accuracy-health
```

### Ops Notes

- Jobs are idempotent when run with a jobKey. The CLI scripts use time-based job keys internally.
- Cards expire 1 hour before game start; stale odds will not emit cards.
- NHL 1P settling is the active focus and should continue recording/segmenting under results now.
- NHL player shots settling is active. Player shots cards route to the `nhl_player_shots_props` results segment.
- MLB F5 first-half settlement runs automatically on every scheduler tick. Manual trigger: `node apps/worker/src/jobs/settle_mlb_f5.js`.
- POTD engine runs automatically in the main scheduler at 09:00 ET (primary) with a fallback window. Manual trigger: `job:run-potd-engine`. Shadow grading runs via `job:potd-shadow-settlement`.
- NHL BLK data (`job:refresh-nhl-blk-data`) is automated daily in the player-props scheduler. Run manually after roster/ID changes or when re-seeding the BLK surface.
- MLB pitcher stats sourced from MLB Stats API (no external key required). Weather overlay uses hardcoded stadium coordinates.
- NCAAM and Soccer runner commands are intentionally absent from the current worker package; if those markets need to return, restore the backing job files before updating this runbook.
- Projection completeness gate: NBA/NHL/MLB jobs now block per-game driver/pricing output when required projection inputs are missing. Logs show `PROJECTION_INPUTS_INCOMPLETE (...)` with explicit missing fields.

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

## Production Pre-Push: Disabled Soccer Surface Check

Soccer execution is not currently shipped in the worker package. Before merging worker changes, confirm no deploy or runbook step tries to invoke removed Soccer or NCAAM commands.

### Verification

```bash
node -e "const pkg=require('./apps/worker/package.json'); const names=Object.keys(pkg.scripts).filter((n)=>/soccer|ncaam/.test(n)); console.log(names.join('\n') || 'no soccer-or-ncaam worker scripts present');"
rg -n "job:run-soccer-model|job:run-ncaam-model|run_soccer_model.js|run_ncaam_model.js" docs apps/worker/package.json
```

Expected:

- Worker scripts list does not include runnable Soccer or NCAAM model entries.
- Any remaining references are clearly marked as historical, design-only, or disabled.

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

### Go-Live Checklist: NBA Spread Staleness Fixes (2026-03-23)

Three changes ship in commit `8874feb`. Steps to deploy safely:

#### 1. Stop the scheduler (required — single-writer contract)

```bash
./scripts/manage-scheduler.sh stop
./scripts/manage-scheduler.sh status  # confirm stopped
```

#### 2. Pull and deploy

```bash
git pull origin main  # or trigger your CI deploy
```

#### 3. (Optional) Set env var explicitly in `.env.production`

```bash
# Defaults to 24h without this, but makes intent explicit:
REFRESH_STALE_ODDS_HORIZON_HOURS=24
```

#### 4. Restart scheduler

```bash
./scripts/manage-scheduler.sh start
./scripts/manage-scheduler.sh db     
# confirm DB path matches expected
```

#### 5. Expect one extra odds pull on first tick

The hourly idempotency key format changed from `odds|hourly|{date}|{hour}` to
`odds|hourly|{date}|{hour}|{slot}`. Existing job-run records don't match the new
keys, so the scheduler will fire one extra `pull_odds_hourly` on the first tick
after deploy (regardless of when the last pull ran). This is safe — just one
extra API call.

#### 6. Verify

```bash
# Confirm stale-odds backstop now covers T+24h games
set -a; source .env.production; set +a; CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db \
  npm --prefix apps/worker run job:check-odds-health

# Spot-check that the latest NBA snapshot has the current spread
sqlite3 /opt/data/cheddar-prod.db \
  "SELECT home_team, away_team, spread_home, spread_away, captured_at
   FROM odds_snapshots
   WHERE LOWER(sport)='nba'
   ORDER BY captured_at DESC LIMIT 5;"
```

Expected result: Spurs game shows `spread_home = -3.5` (not -5.5) within one
scheduler tick (~30s after restart).

---

### Quick Commands (Production)

```bash
# Stop scheduler
./scripts/manage-scheduler.sh stop

# Verify scheduler is stopped before manual writes
./scripts/manage-scheduler.sh status

# Prewarm team metrics cache on production DB (recommended before early model windows)
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db npm --prefix apps/worker run job:refresh-team-metrics

# Pull MLB pitcher stats + weather with production DB (scheduler does this automatically)
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db node apps/worker/src/jobs/pull_mlb_pitcher_stats.js
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db node apps/worker/src/jobs/pull_mlb_weather.js

# Run models with production DB
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db npm --prefix apps/worker run job:run-nba-model
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db npm --prefix apps/worker run job:run-nhl-model
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db npm --prefix apps/worker run job:run-mlb-model
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db npm --prefix apps/worker run job:run-potd-engine

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
npm --prefix apps/worker run job:run-mlb-model
npm --prefix apps/worker run job:run-potd-engine

# Restart scheduler
./scripts/manage-scheduler.sh start
```

**Note:** The single-writer contract prevents simultaneous DB access. Always stop the scheduler before production manual runs to avoid "Refusing to open /opt/data/cheddar-prod.db because another process holds the lock" errors. Non-production warnings for the same DB path, lock path, and owner PID are rate-limited and may be informational; production lock contention remains actionable.

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

DB-backed mutating web tests use a stricter contract:

```bash
# Full mutating web DB test bundle
npm --prefix web run test:db-mutating

# Individual mutating DB tests
npm --prefix web run test:dedupe
npm --prefix web run test:games-filter
npm --prefix web run test:cards-sport-filter
npm --prefix web run test:cards-lifecycle-regression
```

- These commands always provision their own migrated temp SQLite DB under the system temp directory.
- They fail closed before any write if an explicit DB env var points at `/opt/data`, `/opt/cheddar-logic`, or a `cheddar-prod.db` path.
- CI also pins `CHEDDAR_DB_PATH=/tmp/cheddar-logic/ci-safe.db` as a defense-in-depth default, but the mutating tests still replace that with a per-run temp DB.

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


---
# Prod Quickstart
```bash
sudo systemctl stop cheddar-worker && \
set -a && . /opt/cheddar-logic/.env.production && set +a && \
npm --prefix /opt/cheddar-logic/apps/worker run job:pull-odds && \
npm --prefix /opt/cheddar-logic/apps/worker run job:run-nba-model && \
npm --prefix /opt/cheddar-logic/apps/worker run job:run-nhl-model && \
npm --prefix /opt/cheddar-logic/apps/worker run job:run-mlb-model && \
npm --prefix /opt/cheddar-logic/apps/worker run job:run-potd-engine && \
sudo systemctl start cheddar-worker
```

Pi restart commands are systemd-only now:

```bash
# Normal restart order: writer first, then readers
sudo systemctl restart cheddar-worker
sudo systemctl restart cheddar-web
sudo systemctl restart cheddar-fpl-sage

# Verify
sudo systemctl status cheddar-worker cheddar-web cheddar-fpl-sage --no-pager
```

If the worker crashes and leaves a stale production DB lock behind:

```bash
sudo systemctl stop cheddar-worker.service
ps -fp <old-pid> || true
sudo rm -f /opt/data/cheddar-prod.db.lock
sudo systemctl reset-failed cheddar-worker.service
sudo systemctl start cheddar-worker.service
sudo systemctl status cheddar-worker.service --no-pager
```
