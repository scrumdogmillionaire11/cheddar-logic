# Architecture: Cheddar × FPL Sage Separation

**Status:** Enforced Architecture  
**Last Updated:** March 5, 2026  
**Audience:** All maintainers, deployment engineers, integration points

---

## 🚀 Core Principle

**Two separate applications. One unified data store for Cheddar. Complete isolation for FPL Sage.**

### Rollout Safety Contract (Phase-Gated, Additive-Only)

- New rollout primitives are additive and default-off by environment flag.
- Baseline behavior remains unchanged until a flag is explicitly enabled.
- Rollout sequence:
  1. `ENABLE_DECISION_BASIS_TAGS` + `ENABLE_PROJECTION_PERF_LEDGER` (projection-basis metadata + projection telemetry)
  2. `ENABLE_MARKET_THRESHOLDS_V2` (sport+market threshold routing)
  3. `ENABLE_CLV_LEDGER` (odds-backed CLV telemetry)
- While all flags are false/unset, payload shape and decision outcomes must remain baseline-equivalent.
- Telemetry ledgers are operational metrics only and do not alter settlement or card display pipelines.

```text
┌─────────────────────────────────────────────────────────────────┐
│                     CHEDDAR BOARD (Node.js)                     │
│  - Web UI (web/)                                                │
│  - Results API (web/src/app/api/results)                        │
│  - Worker (apps/worker/src/schedulers/main.js)                  │
│  - Models (NBA, NHL, NCAAM, NFL, MLB, Soccer)                   │
│  ─────────────────────────────────────────────────────────────  │
│  📊 DATA: /packages/data/cheddar.db (SQLite)                    │
│     Tables: games, odds_snapshots, card_payloads, card_results, │
│             game_results, job_runs, tracking_stats              │
│  ────────────────────────────────────────────────────────────── │
│  ✅ FPL as second model: YES                                     │
│  ✅ Writes to cheddar.db: YES                                    │
│  ❌ Couples to FPL Sage internals: NO                            │
│  ❌ Reads from fpl_snapshots.sqlite: NO                          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│              FPL SAGE (Python - Standalone App)                 │
│  - CLI entry: cheddar-fpl-sage/fpl_sage.py                      │
│  - Web API: cheddar-fpl-sage/backend/ (FastAPI)                 │
│  - Analysis: Enhanced decision framework, transfers, chips       │
│  ─────────────────────────────────────────────────────────────  │
│  📊 DATA: /cheddar-fpl-sage/db/fpl_snapshots.sqlite (Python)   │
│     Tables: snapshots, bootstrap_raw, fixtures_raw,             │
│             events_raw, team_picks_raw                          │
│  ────────────────────────────────────────────────────────────── │
│  ✅ Standalone operation: YES                                    │
│  ✅ Independent database: YES                                    │
│  ❌ Writes to cheddar.db: NO                                     │
│  ❌ Required by Cheddar: NO                                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🎯 Data Store Rules (Non-Negotiable)

### Cheddar Database (`/packages/data/cheddar.db`)

**Owner:** Cheddar worker scheduler + web API

**Purpose:** Single source of truth for games, cards, results, settlement

**Used By:**

- ✅ Web Results page (`web/src/app/api/results`)
- ✅ Settlement jobs (`apps/worker/src/jobs/settle_*.js`)
- ✅ Scheduler (`apps/worker/src/schedulers/main.js`)
- ✅ All sports models (NBA, NHL, NCAAM, NFL, MLB, Soccer)
- ✅ FPL as a sport model (writes `card_payloads`, `card_results`)

**NOT Used By:**

- ❌ FPL Sage internals (analysis, decision framework)
- ❌ FPL Sage API endpoints
- ❌ FPL Sage CLI output

### FPL Sage Database (`/cheddar-fpl-sage/db/fpl_snapshots.sqlite`)

**Owner:** FPL Sage system

**Purpose:** Persist FPL game-state snapshots, player rosters, fixture context

**Used By:**

- ✅ Enhanced decision framework (transfer analysis, captain optimization)
- ✅ Injury processing (suspension detection, player status)
- ✅ FPL Sage API (`/api/v1/suggestions/dashboard`, `/api/v1/analytics`)
- ✅ Config workflows (bench injury overrides, manual transfers)

**NOT Used By:**

- ❌ Cheddar worker scheduler
- ❌ Cheddar web API
- ❌ Any cross-sport integration layer

---

## 📍 Database Paths: Dev vs Production

### Development Environment

```bash
# Cheddar main database
CHEDDAR_DB_PATH=/Users/{user}/projects/cheddar-logic/packages/data/cheddar.db
# Or via CHEDDAR_DATA_DIR:
CHEDDAR_DATA_DIR=/Users/{user}/projects/cheddar-logic/packages/data

# FPL Sage database (Python auto-resolves)
# Location: /Users/{user}/projects/cheddar-logic/cheddar-fpl-sage/db/fpl_snapshots.sqlite
# Managed by: FPLDatabase class in cheddar-fpl-sage/src/cheddar_fpl_sage/storage/fpl_db.py
```

**Configuration:** `.env` (local overrides)

```bash
# .env (committed template: env.example)
CHEDDAR_DB_PATH=/path/to/packages/data/cheddar.db
ENABLE_SETTLEMENT=true
ENABLE_HOURLY_SETTLEMENT_SWEEP=true
```

### Production Environment (Raspberry Pi / Linux Server)

```bash
# Cheddar main database
CHEDDAR_DB_PATH=/opt/data/cheddar.db
# Alternative fallback (if /opt/data unavailable):
CHEDDAR_DATA_DIR=/opt/cheddar-logic/packages/data

# FPL Sage database (Python auto-resolves from working dir)
# Location: /opt/cheddar-fpl-sage/db/fpl_snapshots.sqlite
# Or explicitly: export FPL_DB_PATH=/opt/data/fpl_snapshots.sqlite
```

**Configuration:** `.env.production` (secrets/local overrides)

```bash
# .env.production (NOT committed)
CHEDDAR_DB_PATH=/opt/data/cheddar.db
ENABLE_SETTLEMENT=true
ENABLE_HOURLY_SETTLEMENT_SWEEP=true
SETTLEMENT_HOURLY_BOUNDARY_MINUTES=5
```

### Path Resolution Precedence (Cheddar)

The `resolveDatabasePath()` function in [`packages/data/src/db-path.js`](packages/data/src/db-path.js) applies this cascade:

1. `RECORD_DATABASE_PATH` (explicit, highest priority)
2. `CHEDDAR_DB_PATH` (canonical preferred)
3. `DATABASE_PATH` (legacy support)
4. `DATABASE_URL` (sqlite: URLs)
5. `CHEDDAR_DATA_DIR/cheddar.db` (directory + default filename)
6. Production fallbacks: `/opt/data/cheddar.db`, `/opt/cheddar-logic/packages/data/cheddar.db`
7. Hardcoded default: `/packages/data/cheddar.db` (relative to workspace)

**Key:** Always set `CHEDDAR_DB_PATH` in production `.env.production` to avoid ambiguity.

---

## 🔄 Results Workflow: Save → Store → Display

### Phase 1: Save Game Results

**Job:** `apps/worker/src/jobs/settle_game_results.js`  
**Trigger:** Hourly (first 5 min) + Nightly (02:00 ET)  
**What Happens:**

1. Fetches final scores from ESPN API
2. Matches to games in Cheddar database
3. **Inserts into `game_results` table** (cheddar.db)
4. Sets `status='final'`, `settled_at=NOW()`

**Database Write:**

```javascript
// packages/data/src/db.js
INSERT INTO game_results (
  id, game_id, sport, final_score_home, final_score_away,
  status, result_source, settled_at, metadata
) VALUES (?, ?, ?, ?, ?, 'final', 'primary_api', NOW(), ?)
ON CONFLICT(game_id) DO UPDATE SET
  final_score_home = excluded.final_score_home,
  final_score_away = excluded.final_score_away,
  settled_at = NOW();
```

### Phase 2: Settle Card Results

**Job:** `apps/worker/src/jobs/settle_pending_cards.js`  
**Trigger:** Hourly (first 5 min) + Nightly (02:00 ET) — **after `settle_game_results`**  
**What Happens:**

1. Joins `card_results` with `game_results` (final scores now available)
2. Applies settlement logic (moneyline, spread, total win/loss/push)
3. **Updates `card_results` table**, sets `status='settled'`, `settled_at=NOW()`
4. Computes and upserts aggregates into `tracking_stats`

**Database Write:**

```javascript
// packages/data/src/db.js
UPDATE card_results
SET status = 'settled', result = ?, pnl_units = ?, settled_at = NOW()
WHERE id = ? AND status = 'pending';

// Then aggregate:
INSERT INTO tracking_stats (
  user_id, sport, card_category, market, confidence_tier,
  total_bets, wins, losses, pushes, win_rate, avg_pnl_units, ...
) VALUES (...)
ON CONFLICT(...) DO UPDATE SET ...;
```

### Phase 3: Display Results via API

**Endpoint:** `GET /api/results?limit=50&sport=NBA&confidence=0.7`  
**Location:** [`web/src/app/api/results/route.ts`](web/src/app/api/results/route.ts)  
**What Happens:**

1. Opens **Cheddar database** (via `resolveDatabasePath()`)
2. Queries `card_results` table where `status='settled'`
3. JOINs to `card_payloads` (for model context) and `games` (for team names)
4. Deduplicates (keeps highest confidence card per game if multiple cards)
5. Returns summary (total/wins/losses/pushes/PnL) + ledger (50-card list)

**Database Query:**

```typescript
// web/src/app/api/results/route.ts (simplified)
WITH filtered AS (
  SELECT
    cr.id, cr.card_id, cr.game_id, cr.result,
    COALESCE(cp.payload_data ->> 'confidence', '0') AS confidence_pct,
    cr.settled_at, g.home_team, g.away_team
  FROM card_results cr
  LEFT JOIN card_payloads cp ON cr.card_id = cp.id
  LEFT JOIN games g ON cr.game_id = g.game_id
  WHERE cr.status = 'settled'
    AND g.sport = ? -- filter by sport
    AND CAST(COALESCE(cp.payload_data ->> 'confidence', '0') AS REAL) >= ?
)
SELECT * FROM filtered
ORDER BY cr.settled_at DESC
LIMIT 50;
```

---

## 🔌 FPL Integration Boundary (Cheddar ↔ Sage)

### What Cheddar Can Do with FPL

✅ **Allowed:**

- Generate FPL cards using odds-based fallback model (`apps/worker/src/models/index.js` lines 1028-1031)
- Store FPL predictions in `card_payloads` as `sport='FPL'`
- Display FPL cards in Results page (same as any sport)
- Settle FPL cards based on game outcomes (moneyline/spread)

❌ **NOT Allowed:**

- Query Sage's `fpl_snapshots.sqlite` from worker/scheduler
- Import Sage analysis functions into Cheddar models
- Depend on Sage API at runtime (Cheddar must work standalone)

### What FPL Sage Does Independently

✅ **Sage Owns:**

- Gameweek snapshots: player rosters, ownership, fixture difficulty
- Transfer recommendations: target identification, opportunity analysis
- Captain/chip decisions: optimization across fixtures
- Injury/suspension processing: secondary feeds, manual overrides
- Historical performance: weekly results for model training

❌ **Sage Does NOT:**

- Generate betting cards for Cheddar
- Write to `cheddar.db`
- Trigger settlement jobs
- Depend on Cheddar's results for its analysis

---

## 📋 Checklist: New Feature / Deployment

### Adding FPL Support to a New Cheddar Feature

□ Feature reads/writes only from `cheddar.db`  
□ Feature does NOT import from `cheddar-fpl-sage/` directory  
□ Feature does NOT call Sage API at runtime  
□ Feature treats FPL as just another sport (`sport='FPL'` in tables)  
□ Tests work with local `cheddar.db` snapshot (no Sage dependency)  

### Deploying to Production

□ `.env.production` has explicit `CHEDDAR_DB_PATH=/opt/data/cheddar.db`  
□ Database backups stored alongside main DB: `/opt/data/backups/cheddar.db.YYYY-MM-DD`  
□ Settlement jobs configured: `ENABLE_SETTLEMENT=true`, `ENABLE_HOURLY_SETTLEMENT_SWEEP=true`  
□ Scheduler runs with settlement boundary: `SETTLEMENT_HOURLY_BOUNDARY_MINUTES=5`  
□ Results API responds with settled cards from correct DB  
□ FPL Sage runs independently (separate systemd service if deployed)  
□ FPL Sage database path is independent: `/opt/cheddar-fpl-sage/db/fpl_snapshots.sqlite`  

---

## 📎 Related Documentation

- [SETTLEMENT_CANONICAL_WORKFLOW.md](SETTLEMENT_CANONICAL_WORKFLOW.md) — How results are settled
- [FPL-OWNERSHIP.md](../cheddar-fpl-sage/.planning/phases/02-fpl-dual-engine-resolution/FPL-OWNERSHIP.md) — FPL maintenance responsibility (Sage team only)
- [FPL-CONTRACT.md](../cheddar-fpl-sage/.planning/phases/02-fpl-dual-engine-resolution/FPL-CONTRACT.md) — API schema if Sage ever calls Cheddar

---

## ✅ Enforcement

**This separation is required by:**

- AGENTS.md (scope isolation)
- Every work item touching FPL must verify it reads from correct DB
- Code review must catch cross-app imports
- Tests must not require both apps running simultaneously

**Questions?**

Open a work item referencing this doc.
