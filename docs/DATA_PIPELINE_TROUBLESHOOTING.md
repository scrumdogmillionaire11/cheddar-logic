# Data Pipeline Troubleshooting Guide

## Quick Health Check

Run these commands to diagnose data issues:

```bash
# Inspect database contents
cd packages/data && npm run db:inspect

# Check game dates
cd packages/data && npm run db:check-dates

# Check card coverage
cd packages/data && npm run db:check-coverage

# Test API query logic
cd packages/data && npm run db:test-query

# Run integration tests
cd packages/data && npm run test:integration
```

### Missing `MISSING_DATA_NO_PLAYS` Diagnostic

When `/cards` shows games as degraded with `MISSING_DATA_NO_PLAYS`, run this read-only diagnostic from repo root:

```bash
scripts/diagnose-missing-data-no-plays.sh
```

Useful focused variants:

```bash
# Sport-specific (e.g., NCAAM alias/mapping issues)
scripts/diagnose-missing-data-no-plays.sh --sport NCAAM --since-hours 48

# Investigate exact game IDs from the board/API response
scripts/diagnose-missing-data-no-plays.sh --game-id <game_id_1> --game-id <game_id_2>
```

What it checks:

- Games with odds present but zero card rows (`MISSING_DATA_NO_PLAYS` risk)
- Games with cards but zero PLAY rows (usually actionable-pass/evidence-only path)
- `odds_ingest_failures` reasons (`TEAM_MAPPING_UNMAPPED`, `MARKET_SOURCE_INCOMPLETE`, etc.)
- Projection input completeness signals in latest odds enrichment payload
- Recent `pull_odds_hourly` and model job health/freshness

## Common Issues

### Issue: No games or cards showing on /cards page

**Symptoms:**
- `/cards` page loads but shows no games
- API returns empty arrays

**Diagnosis:**
```bash
cd packages/data
npm run db:check-coverage
```

**Fixes:**

1. **No games in database:**
   ```bash
   cd packages/data
   npm run seed:test-odds  # Seeds realistic test games
   ```

2. **Games exist but no future games:**
   - Check game dates: `npm run db:check-dates`
   - If all games are in the past, seed new games: `npm run seed:test-odds`

3. **Future games exist but no card payloads:**
   ```bash
   cd packages/data
   npm run seed:cards  # Creates cards for games without them
   ```

4. **Verify API endpoints are working:**
   ```bash
   # Make sure Next.js dev server is running first: cd web && npm run dev
   ./scripts/test-api-endpoints.sh
   ```

### Issue: No results showing on /results page

**Symptoms:**
- `/results` page shows "N/A" for all metrics
- No ledger entries

**Diagnosis:**
```bash
cd packages/data
npm run db:inspect
# Check "Card Results" count - should be > 0
```

**Fixes:**

1. **No settled results:**
   ```bash
   cd packages/data
   npm run seed:test-results  # Seeds settled results with outcomes
   ```

2. **Results exist but filtered out:**
   - Check the filters on the /results page UI
   - Try clicking "Clear" button to reset filters

3. **NHL rows appear in the wrong segment block:**
   - `/results` now groups NHL rows into same-page sections: **Game Sides & Totals**, **1P Totals**, and **Player Shots Props**.
   - Confirm API segment metadata directly: `curl -s "http://localhost:3000/api/results?sport=NHL&limit=50" | jq '.data.segmentFamilies'`
   - If one segment remains empty, verify settled rows exist for that market family in `card_results` and that `card_type`/`recommended_bet_type` values match expected NHL families.

### Issue: Stale data (old games from previous tests)

**Symptoms:**
- Games from many days/weeks ago showing up
- Unrealistic game times

**Fix:**
```bash
cd packages/data

# Option 1: Purge only seed data (keeps real API data)
npm run seed:purge

# Option 2: Full database reset (WARNING: deletes ALL data)
npm run db:reset
npm run migrate
npm run seed:test-odds
npm run seed:cards
```

## Data Pipeline Flow

```
1. Games → Seeded via seed:test-odds OR pulled from real odds API
   ↓
2. Odds Snapshots → Associated with games, captured_at timestamps
   ↓
3. Card Payloads → Model predictions for each game
   ↓
4. Card Results → Settlement tracking (pending → settled)
   ↓
5. Game Results → Final scores and grades
```

## Prevention: Integration Tests

Run tests before pushing changes:

```bash
cd packages/data
npm run test:integration
```

These tests verify:
- Database schema is valid
- Games have valid data
- Future games exist
- All future games have card payloads
- Card payloads reference existing games
- JSON payloads are valid

## Manual API Testing

While Next.js dev server is running (`cd web && npm run dev`):

```bash
# Test games endpoint
curl http://localhost:3000/api/games | jq '.data | length'

# Test results endpoint  
curl http://localhost:3000/api/results | jq '.data.summary'

# Test cards endpoint
curl http://localhost:3000/api/cards | jq '.data | length'
```

## Quick Fix Script

If pages are empty, run this one-liner:

```bash
cd packages/data && \
  npm run db:check-coverage && \
  npm run seed:cards && \
  npm run db:check-coverage
```

This will:
1. Check current card coverage
2. Seed cards for games without them
3. Verify cards were added

## Database Location

- **Development:** `packages/data/cheddar.db`
- **Vercel:** `packages/data/cheddar.db` (build artifact, included in deployment)
- **Migrations:** `packages/data/migrations/*.sql`

## Environment Variables

None required for SQLite (file-based DB). 

For future external DB support (not currently used):

- `DATABASE_URL` - Connection string (planned)
- `CHEDDAR_DATA_DIR` - Override data directory

## Need More Help?

1. Check logs: Look in terminal where `npm run dev` is running
2. Run health checks above
3. Check this troubleshooting guide
4. Review integration test failures for specific issues

## Inefficient Model Replacement Runbook (WI-0475)

Use this runbook when model quality degrades and you need an operational response without code changes.

### Preconditions

- Run from repo root.
- Ensure the worker is the only DB writer (single-writer contract).
- Confirm the active DB path before any action:

```bash
bash scripts/db-context.sh
```

### Objective Triggers

Treat trigger thresholds as hard gates for intervention.

| Signal | Minimum sample | Trigger threshold | Window |
| --- | --- | --- | --- |
| Projection win-rate (`projection_perf_ledger`) | 100 settled rows | `< 48%` win rate | Last 14 days |
| Projection confidence drift | 100 settled rows | `win_rate(confidence=HIGH) < win_rate(confidence=MEDIUM)` by ≥ 3pp | Last 14 days |
| CLV degradation (`clv_ledger`) | 150 settled rows | Mean `clv_pct <= -0.020` | Last 14 days |
| CLV tail risk | 150 settled rows | P25 `clv_pct <= -0.050` | Last 14 days |

### Trigger Queries (Copy/Paste)

```bash
# Projection performance trigger check
set -a; source .env; set +a; sqlite3 "$CHEDDAR_DB_PATH" "
SELECT
   sport,
   COUNT(*) AS sample_size,
   ROUND(AVG(CASE WHEN won = 1 THEN 1.0 ELSE 0.0 END), 4) AS win_rate
FROM projection_perf_ledger
WHERE settled_at IS NOT NULL
   AND datetime(settled_at) >= datetime('now', '-14 days')
GROUP BY sport
ORDER BY sample_size DESC;
"

# CLV trigger check
set -a; source .env; set +a; sqlite3 "$CHEDDAR_DB_PATH" "
SELECT
   sport,
   market_type,
   COUNT(*) AS sample_size,
   ROUND(AVG(clv_pct), 4) AS mean_clv
FROM clv_ledger
WHERE closed_at IS NOT NULL
   AND datetime(closed_at) >= datetime('now', '-14 days')
GROUP BY sport, market_type
ORDER BY sample_size DESC;
"
```

### Action Matrix

| Trigger hit | Allowed action | Owner | Verification |
| --- | --- | --- | --- |
| Projection win-rate floor breach | Demote decision strictness using threshold routing (`ENABLE_MARKET_THRESHOLDS_V2=true`) | Model ops on-call | Re-run model job and confirm lower PLAY volume + stable PASS rationale |
| Projection confidence drift | Disable decision-basis tags for affected run while investigating (`ENABLE_DECISION_BASIS_TAGS=false`) | Model ops on-call | Confirm payloads stop emitting `decision_basis_meta` |
| CLV mean degradation | Disable CLV ledger writes (`ENABLE_CLV_LEDGER=false`) and keep settlement normal | Settlement ops | Confirm `clv_ledger` row count stops increasing; `card_results` still settles |
| CLV tail-risk breach | Roll back to baseline rollout flags (all four disabled) | Incident commander | Confirm web/worker outputs match baseline expectations |

### Phase 2 Runbook (`ENABLE_MARKET_THRESHOLDS_V2`)

#### Activation (controlled window)

```bash
set -a; source .env; set +a
export ENABLE_MARKET_THRESHOLDS_V2=true

ENABLE_MARKET_THRESHOLDS_V2=true npm --prefix apps/worker run job:run-nba-model:test
ENABLE_MARKET_THRESHOLDS_V2=true npm --prefix apps/worker run job:run-ncaam-model:test
```

#### Verification (Phase 2 only)

```bash
npm --prefix web run test:api:games:market

# Optional parity sanity check: verify threshold routing is active without breaking payload contract
set -a; source .env; set +a; sqlite3 "$CHEDDAR_DB_PATH" "
SELECT
   COUNT(*) AS total_cards,
   SUM(CASE WHEN json_extract(payload_data, '$.decision_basis_meta.market_thresholds_v2') IS NOT NULL THEN 1 ELSE 0 END) AS threshold_v2_marked
FROM card_payloads
WHERE datetime(created_at) >= datetime('now', '-6 hours');
"
```

#### Incident triggers + immediate rollback criteria (Phase 2)

- Trigger rollback immediately when any are observed:
   - `test:api:games:market` fails after Phase 2 activation.
   - Worker model test command fails under `ENABLE_MARKET_THRESHOLDS_V2=true`.
   - Unexpected payload contract drift or unsupported decision status output appears in recent cards.
- Rollback command sequence:

```bash
./scripts/manage-scheduler.sh stop
export ENABLE_MARKET_THRESHOLDS_V2=false
./scripts/manage-scheduler.sh start
./scripts/manage-scheduler.sh db
```

### Phase 3 Runbook (`ENABLE_CLV_LEDGER`)

#### Activation (settlement-safe controlled run)

```bash
set -a; source .env; set +a
export ENABLE_CLV_LEDGER=true

ENABLE_CLV_LEDGER=true npm --prefix apps/worker run job:settle-cards
```

#### Post-settlement verification

```bash
npm --prefix apps/worker test -- src/jobs/__tests__/settle_pending_cards.phase2.test.js
npm --prefix apps/worker test -- src/jobs/__tests__/settle_pending_cards.market-contract.test.js
npm --prefix web run test:api:games:market

# CLV rows must be additive and exclude projection-only basis
set -a; source .env; set +a; sqlite3 "$CHEDDAR_DB_PATH" "
SELECT
   COUNT(*) AS total_rows,
   SUM(CASE WHEN decision_basis = 'PROJECTION_ONLY' THEN 1 ELSE 0 END) AS projection_only_rows
FROM clv_ledger;
"
```

#### Rollback (Phase 3 telemetry off, settlement preserved)

```bash
./scripts/manage-scheduler.sh stop
export ENABLE_CLV_LEDGER=false
./scripts/manage-scheduler.sh start
./scripts/manage-scheduler.sh db
```

### Enable → Verify → Rollback Commands

#### 1) Enable one phase flag in staging

```bash
export ENABLE_MARKET_THRESHOLDS_V2=true
export ENABLE_DECISION_BASIS_TAGS=true
export ENABLE_PROJECTION_PERF_LEDGER=true
export ENABLE_CLV_LEDGER=true
```

#### 2) Verify telemetry and card settlement contracts

```bash
# Run one model and settlement pass
npm --prefix apps/worker run job:run-nba-model:test
ENABLE_CLV_LEDGER=true npm --prefix apps/worker run job:settle-cards

# Verify projection ledger rows
set -a; source .env; set +a; sqlite3 "$CHEDDAR_DB_PATH" "
SELECT decision_basis, COUNT(*)
FROM projection_perf_ledger
GROUP BY decision_basis;
"

# Verify CLV ledger guardrails (no projection-only rows)
set -a; source .env; set +a; sqlite3 "$CHEDDAR_DB_PATH" "
SELECT
   COUNT(*) AS total_rows,
   SUM(CASE WHEN decision_basis = 'PROJECTION_ONLY' THEN 1 ELSE 0 END) AS projection_only_rows
FROM clv_ledger;
"
```

#### 3) Production-safe rollback (kill-switch sequence)

```bash
# Stop scheduler before env changes to avoid mixed writer state
./scripts/manage-scheduler.sh stop

# Disable rollout flags
export ENABLE_DECISION_BASIS_TAGS=false
export ENABLE_MARKET_THRESHOLDS_V2=false
export ENABLE_PROJECTION_PERF_LEDGER=false
export ENABLE_CLV_LEDGER=false

# Optional: if using .env.production on host
# sed -i '' 's/ENABLE_DECISION_BASIS_TAGS=true/ENABLE_DECISION_BASIS_TAGS=false/' .env.production
# sed -i '' 's/ENABLE_MARKET_THRESHOLDS_V2=true/ENABLE_MARKET_THRESHOLDS_V2=false/' .env.production
# sed -i '' 's/ENABLE_PROJECTION_PERF_LEDGER=true/ENABLE_PROJECTION_PERF_LEDGER=false/' .env.production
# sed -i '' 's/ENABLE_CLV_LEDGER=true/ENABLE_CLV_LEDGER=false/' .env.production

# Restart scheduler and verify DB context
./scripts/manage-scheduler.sh start
./scripts/manage-scheduler.sh db
```

---

## Phase 4: 14–30 Day Telemetry Soak Runbook (WI-0486)

This runbook governs the sustained soak period **after** both Phase 2 (`ENABLE_MARKET_THRESHOLDS_V2=true`) and Phase 3 (`ENABLE_CLV_LEDGER=true`) are live in production. The soak window is 14–30 days. Weekly go/no-go checkpoints are mandatory.

> **Sample-size gate rule:** A threshold signal is only an actionable breach when its ledger row count meets its minimum sample gate. Before the gate is reached, the calibration report emits `INSUFFICIENT_DATA` — this is a pass, not a failure. Never interpret a signal as a breach when sample count is below the gate.

### Soak Checklist

#### Day 0 — Activation Baseline

Complete _before_ declaring the soak window open:

```bash
# Confirm both rollout flags are live
echo $ENABLE_MARKET_THRESHOLDS_V2   # must be: true
echo $ENABLE_CLV_LEDGER              # must be: true

# Baseline calibration report (expect INSUFFICIENT_DATA on both ledgers)
npm --prefix apps/worker run job:report-telemetry-calibration

# Parity check: confirm projection ledger is accumulating rows
set -a; source .env; set +a; sqlite3 "$CHEDDAR_DB_PATH" "
SELECT sport, COUNT(*) AS rows FROM projection_perf_ledger GROUP BY sport;"

# Parity check: confirm CLV ledger is accumulating rows
set -a; source .env; set +a; sqlite3 "$CHEDDAR_DB_PATH" "
SELECT sport, market_type, COUNT(*) AS rows FROM clv_ledger GROUP BY sport, market_type;"
```

Pass criteria:

- Both flags confirmed `true`.
- `job:report-telemetry-calibration` exits 0 (signals returned as `INSUFFICIENT_DATA` are acceptable).
- At least one row exists in each ledger (confirms telemetry pipeline is writing).

---

#### Day 7 — First Checkpoint

```bash
# Standard calibration report
npm --prefix apps/worker run job:report-telemetry-calibration

# Enforce mode — exit non-zero only if sample gate is met AND threshold breached
npm --prefix apps/worker run job:report-telemetry-calibration -- --enforce

# Capture JSON evidence for ops notes
npm --prefix apps/worker run job:report-telemetry-calibration -- --json > /tmp/soak-day07-$(date +%Y%m%d).json
```

Pass criteria: `--enforce` exits 0, OR all signals return `INSUFFICIENT_DATA`.
Fail criteria: `--enforce` exits non-zero AND at least one ledger has met its sample gate.

If fail: consult the [Breach-to-Owner Table](#breach-to-owner-table) below. Do **not** roll back on Day 7 alone — log the breach and continue to Day 14 unless a CLV tail-risk breach is observed (immediate action required).

---

#### Day 14 — Enforcement Threshold

Same three commands as Day 7. By Day 14, both ledgers should have met their sample gates under normal volume.

If sample gates are **still** not met at Day 14:

- Log the gap with a row-count SQL check.
- Extend the checkpoint to Day 21 before treating signals as enforceable.
- Note in ops log: `sample gate not yet met at Day 14 — extending to Day 21`.

If sample gates **are** met:

- Any breach is now actionable.
- Consult the [Breach-to-Owner Table](#breach-to-owner-table) and take the mapped action immediately.
- Do not wait for Day 21 if a CLV tail-risk or win-rate floor breach is confirmed.

---

#### Day 21 — Extended Checkpoint (if needed)

Only required when Day 14 sample gates were not met. Same three commands as Day 7/14.

If sample gates now met: treat identically to Day 14 enforcement.
If sample gates still not met at Day 21: escalate to Incident Commander — data pipeline may have a gap.

---

#### Day 30 — Final Soak Decision

```bash
# Final enforce check
npm --prefix apps/worker run job:report-telemetry-calibration -- --enforce
npm --prefix apps/worker run job:report-telemetry-calibration -- --json > /tmp/soak-day30-$(date +%Y%m%d).json

# Contract regression guard
npm --prefix web run test:api:games:market
npm --prefix web run test:decision:canonical
```

**GO** (declare soak complete): `--enforce` exits 0 on both Day 14/21 and Day 30, no unresolved breach, both contract tests pass.

**NO-GO** (rollback): `--enforce` exits non-zero on Day 30 with sample gate met, OR any prior breach was not resolved. Execute the applicable rollback:

- Phase 2 rollback: see [Phase 2 Runbook → Rollback command sequence](#incident-triggers--immediate-rollback-criteria-phase-2)
- Phase 3 rollback: see [Phase 3 Runbook → Rollback](#rollback-phase-3-telemetry-off-settlement-preserved)
- Full kill-switch: see [Enable → Verify → Rollback Commands → Production-safe rollback](#3-production-safe-rollback-kill-switch-sequence)

> **Flag note:** Standard soak rollback uses only `ENABLE_MARKET_THRESHOLDS_V2` and `ENABLE_CLV_LEDGER` (both in `env.example`). The kill-switch flags `ENABLE_PROJECTION_PERF_LEDGER` and `ENABLE_DECISION_BASIS_TAGS` are only required for the full kill-switch sequence — they are not needed for targeted Phase 2 or Phase 3 rollback.

---

### Breach-to-Owner Table

A signal is an **actionable breach** only when its ledger row count meets the minimum sample gate for that ledger.

| Breach signal | Threshold | Minimum sample gate | Owner | Default rollback action |
| --- | --- | --- | --- | --- |
| Projection win-rate floor | `win_rate < 0.48` | ≥ 100 rows in `projection_perf_ledger` (last 14 days) | **Model Ops on-call** | `ENABLE_MARKET_THRESHOLDS_V2=false` (Phase 2 rollback) |
| Projection confidence drift | `confidence_drift ≥ 0.03` | ≥ 100 rows in `projection_perf_ledger` (last 14 days) | **Model Ops on-call** | `ENABLE_DECISION_BASIS_TAGS=false` (disable tags, keep thresholds) |
| CLV mean degradation | `mean_clv ≤ -0.02` | ≥ 150 rows in `clv_ledger` (last 14 days) | **Settlement Ops** | `ENABLE_CLV_LEDGER=false` (Phase 3 rollback) |
| CLV tail risk | `p25_clv ≤ -0.05` | ≥ 150 rows in `clv_ledger` (last 14 days) | **Incident Commander** | Full kill-switch (all four flags disabled) |

Threshold values match constants in `apps/worker/src/jobs/report_telemetry_calibration.js` and are documented with SQL parity checks in [docs/API_BASELINES.md](./API_BASELINES.md).

### Weekly Evidence Capture Format

Paste the following block into ops notes after each weekly checkpoint:

```text
Soak checkpoint: Day [N] — [YYYY-MM-DD]
Command: npm --prefix apps/worker run job:report-telemetry-calibration -- --enforce
Exit code: [0 or non-zero]

-- Projection ledger --
  sample_size:       [N rows]
  win_rate:          [0.XXXX]   breach threshold: < 0.48
  confidence_drift:  [0.XXXX]   breach threshold: >= 0.03
  status:            [OK | INSUFFICIENT_DATA | BREACH: <signal>]

-- CLV ledger --
  sample_size:       [N rows]
  mean_clv:          [+/-0.XXXX]  breach threshold: <= -0.02
  p25_clv:           [+/-0.XXXX]  breach threshold: <= -0.05
  status:            [OK | INSUFFICIENT_DATA | BREACH: <signal>]

JSON evidence: /tmp/soak-day[N]-YYYYMMDD.json
Action taken: [none | escalated to <owner> | rollback initiated]
```

---

### End-to-End Dry Run Checklist

1. Enable exactly one rollout flag in staging.
2. Run one model job and one settlement job.
3. Execute both telemetry SQL checks above.
4. Execute rollback commands.
5. Confirm post-rollback flags are all false and jobs still run.
