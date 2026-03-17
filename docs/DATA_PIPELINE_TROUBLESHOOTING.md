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

### End-to-End Dry Run Checklist

1. Enable exactly one rollout flag in staging.
2. Run one model job and one settlement job.
3. Execute both telemetry SQL checks above.
4. Execute rollback commands.
5. Confirm post-rollback flags are all false and jobs still run.
