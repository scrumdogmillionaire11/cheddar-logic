# PHASE 01 — Steps 1 & 2 Complete ✅

**Date:** 2026-02-27  
**Agent:** BMad Master  
**Status:** Ready for integration testing

---

## What Was Completed

### Step 1: Smoke Tests Added ✅

**File:** `apps/worker/src/jobs/__tests__/pull_odds_hourly.test.js`

Test suite validates:
- ✅ Job executes successfully (exit code 0)
- ✅ `job_runs` table records execution as 'success'
- ✅ `odds_snapshots` table has valid schema + non-null required fields
- ✅ All timestamps are ISO 8601 UTC format
- ✅ At least one snapshot per fetched sport
- ✅ All snapshots reference valid job_runs (no orphaned records)
- ✅ Error_message is null on success

**Run tests:**
```bash
cd apps/worker
npm install
npm test
```

### Step 2: Added `model_outputs` + `card_payloads` Tables ✅

**New migrations created:**

#### `004_create_model_outputs.sql`
Stores inference outputs from sport models.

```sql
model_outputs (
  id TEXT PRIMARY KEY
  game_id TEXT NOT NULL
  sport TEXT NOT NULL
  model_name TEXT NOT NULL              -- e.g., 'nhl-moneyline-v1'
  model_version TEXT NOT NULL
  prediction_type TEXT NOT NULL         -- e.g., 'moneyline', 'spread', 'total'
  predicted_at TEXT NOT NULL            -- ISO 8601 UTC
  confidence REAL                       -- 0-1 score
  output_data TEXT NOT NULL             -- Full output (JSON)
  odds_snapshot_id TEXT                 -- Links to which odds snapshot was used
  job_run_id TEXT                       -- Links to which model job created this
  created_at TEXT NOT NULL
)
```

#### `005_create_card_payloads.sql`
Stores web-ready card data (CLV analysis, picks, line movement, etc).

```sql
card_payloads (
  id TEXT PRIMARY KEY
  game_id TEXT NOT NULL
  sport TEXT NOT NULL
  card_type TEXT NOT NULL               -- e.g., 'clv-analysis', 'pick', 'line-movement'
  card_title TEXT NOT NULL              -- Display title
  created_at TEXT NOT NULL              -- ISO 8601 UTC
  expires_at TEXT                       -- Optional: when card becomes stale
  payload_data TEXT NOT NULL            -- Frontend-ready JSON
  model_output_ids TEXT                 -- Comma-separated: which models generated this
  metadata TEXT                         -- Optional metadata (JSON)
  updated_at TEXT NOT NULL
)
```

### New DB API Functions ✅

**Model Outputs:**
- `insertModelOutput(output)` — Insert inference result
- `getLatestModelOutput(gameId, modelName)` — Most recent prediction for game+model
- `getModelOutputs(gameId)` — All outputs for a game
- `getModelOutputsBySport(sport, sinceUtc)` — Bulk query by sport + time

**Card Payloads:**
- `insertCardPayload(card)` — Insert web-ready card
- `getCardPayload(cardId)` — Fetch single card
- `getCardPayloads(gameId)` — All non-expired cards for a game
- `getCardPayloadsByType(cardType, limitDays)` — Query by card type
- `getCardPayloadsBySport(sport, limitCards)` — Recent cards for a sport
- `expireCardPayload(cardId)` — Mark card as expired
- `deleteExpiredCards(daysOld)` — Cleanup old cards

### Updated Tests & Configs ✅

- Added `jest.config.js` to `packages/data`
- Added `jest.config.js` to `apps/worker`
- Added test scripts to both `package.json` files (`test`, `test:watch`, `test:coverage`)
- Updated `packages/data/README.md` with schema + API docs for new tables

---

## How to Use

### Run Tests

```bash
# Test the worker job
cd apps/worker
npm test

# Test the data layer (if tests exist)
cd packages/data
npm test
```

### Insert Model Output Example

```javascript
const { insertModelOutput, getLatestModelOutput } = require('@cheddar-logic/data');

insertModelOutput({
  id: 'mo-abc123',
  gameId: 'nhl-2026-02-27-det-vs-col',
  sport: 'NHL',
  modelName: 'nhl-moneyline-v1',
  modelVersion: '1.0.0',
  predictionType: 'moneyline',
  predictedAt: new Date().toISOString(),
  confidence: 0.72,
  outputData: { prediction: 'home', value: -120, clv: 5 },
  oddsSnapshotId: 'snap-abc123'
});

const latest = getLatestModelOutput('nhl-2026-02-27-det-vs-col', 'nhl-moneyline-v1');
console.log(latest.confidence); // 0.72
```

### Insert Card Payload Example

```javascript
const { insertCardPayload, getCardPayloads } = require('@cheddar-logic/data');

insertCardPayload({
  id: 'card-abc123',
  gameId: 'nhl-2026-02-27-det-vs-col',
  sport: 'NHL',
  cardType: 'clv-analysis',
  cardTitle: 'Current Line vs Market',
  createdAt: new Date().toISOString(),
  payloadData: {
    closing_line: -120,
    current_line: -115,
    clv: '+5',
    recommendation: 'Value on home'
  },
  modelOutputIds: 'mo-abc123,mo-xyz789'
});

const cards = getCardPayloads('nhl-2026-02-27-det-vs-col');
console.log(cards.length); // e.g., 3 cards
```

---

## Database Schema Summary

All 5 tables now exist:

1. **job_runs** — Execution tracking (step 1)
2. **games** — Game metadata (step 1)
3. **odds_snapshots** — Odds data (step 1)
4. **model_outputs** — Inference results (step 2) ← NEW
5. **card_payloads** — Web-ready cards (step 2) ← NEW

**Total indices:** 18 (for fast queries across all tables)

---

## Next Phase (When Ready)

1. **Create an NHL model runner** that:
   - Reads latest odds_snapshot for each game
   - Runs inference
   - Inserts model_output
   - Generates CLV + pick cards
   - Inserts card_payloads

2. **Create a web API route** that:
   - Queries card_payloads for a sport
   - Returns card_payloads to frontend

3. **Test end-to-end:**
   - Fetch odds → Run model → Generate cards → Serve cards

---

## File Inventory

**Migrations (5 files):**
- 001_create_job_runs.sql
- 002_create_games.sql
- 003_create_odds_snapshots.sql
- 004_create_model_outputs.sql ← NEW
- 005_create_card_payloads.sql ← NEW

**Tests:**
- apps/worker/src/jobs/__tests__/pull_odds_hourly.test.js ← NEW

**Configs:**
- packages/data/jest.config.js ← NEW
- apps/worker/jest.config.js ← NEW

**Documentation:**
- packages/data/README.md ← UPDATED

---

**Ready to proceed?** The Master awaits guidance.
