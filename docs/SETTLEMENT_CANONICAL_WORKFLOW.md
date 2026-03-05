# SETTLEMENT CANONICAL WORKFLOW
**Status:** Phase 2 Implemented ✅  
**Last Updated:** March 4, 2026  
**Scope:** One documented, followed process for settling games and tracking segmented record

---

## 🚨 CRITICAL CONSTRAINT

> **ANY new settlement implementation MUST remove ALL legacy settlement flows.**
>
> See [SETTLEMENT_LEGACY_AUDIT.md](SETTLEMENT_LEGACY_AUDIT.md) for complete inventory of code to remove.
>
> **No co-existence of multiple settlement paths is permitted.**

---

## EXECUTIVE SUMMARY

The settlement system has **two independent halves** that must run in strict sequence:

| Phase | Job | Status | Current Issue |
|-------|-----|--------|---|
| **Phase 1: Game Scores** | `settle_game_results.js` | Exists | ❌ Not scheduled in production |
| **Phase 2: Card Outcome** | `settle_pending_cards.js` | ✅ **IMPLEMENTED** | ✅ Settles only TOP-LEVEL card per game |
| **Phase 3: Record Track** | Aggregation into `tracking_stats` | Exists | ✅ Works once Phase 2 is correct |

**Phase 2 Fixed:** ✅ Now enforces **ONE play per game** based on highest confidence.

**Expected Outcome:** Single source of truth for W-L record, segmented by sport/driver/market/confidence-tier.

---

## WHAT IS "TOP-LEVEL PLAY"?

**Definition:** The single recommended play that should appear in the user's final record for a game.

**Examples of Multiple Plays per Game:**
```
Game: Lakers vs Celtics (NBA) on 2026-03-04
  Card 1: nba-base-projection       → HOME (high confidence 68%)    ← TOP-LEVEL
  Card 2: nba-rest-advantage        → AWAY (medium confidence 52%)  
  Card 3: nba-pace-totals           → HOME (low confidence 44%)     
  
Settlement should track ONLY Card 1 in user's segmented record.
```

**Selection Criteria (Options to Clarify):**
1. ✅ **Highest Confidence** (RECOMMENDED) — Play with highest `payload.confidence` %
2. **Highest EV** — Play where EV-decision is most favorable
3. **First Card Generated** — Play with earliest `card_payloads.created_at` timestamp
4. **Primary Driver** — Play with `card_type == 'nba-base-projection'` (or sport-specific base)
5. **Explicitly Marked** — Play where `payload.is_primary == true` (requires schema addition)

**For Now:** Assume **#1 (Highest Confidence)** unless user specifies otherwise.

---

## THE THREE-PHASE WORKFLOW

### PHASE 1: Fetch Final Game Scores
**Job:** `settle_game_results.js`  
**Trigger:** Runs nightly (T+3 hours after game start) or on-demand  
**Input:** Unsettled games from `games` table + ESPN API  
**Output:** Rows in `game_results` table with `status='final'`

#### Step 1A: Identify Eligible Games
```sql
-- Games with pending card_results, past cutoff, not yet final
SELECT DISTINCT g.game_id, g.sport, g.home_team, g.away_team, g.game_time_utc
FROM games g
INNER JOIN card_results cr ON g.game_id = cr.game_id
WHERE cr.status = 'pending'
  AND g.game_time_utc < NOW() - INTERVAL 3 hours  -- at least 3h past start
  AND NOT EXISTS (
    SELECT 1 FROM game_results WHERE game_id = g.game_id AND status = 'final'
  )
ORDER BY g.game_time_utc ASC;
```

#### Step 1B: Fetch ESPN Final Scores
- Call ESPN API for each game
- Match ESPN event to internal game using team signatures (home_team + away_team + sport)
- Extract final scores from completed ESPN event
- Handle edge cases: postponed, cancelled games

#### Step 1C: Insert Game Result
```sql
INSERT INTO game_results (
  id, game_id, sport, final_score_home, final_score_away, 
  status, result_source, settled_at, metadata
) VALUES (?, ?, ?, ?, ?, 'final', 'primary_api', NOW(), ?)
ON CONFLICT(game_id) DO UPDATE SET
  final_score_home = excluded.final_score_home,
  final_score_away = excluded.final_score_away,
  status = 'final',
  settled_at = NOW();
```

#### Production Readiness Check ✅
- [x] ESPN API integration exists
- [x] Collision detection (same ESPN event not reused)
- [x] Database backup before write
- [x] Error handling + job_runs tracking
- [x] Idempotency via jobKey

---

### PHASE 2: Settle Pending Cards to WIN/LOSS/PUSH
**Job:** `settle_pending_cards.js`  
**Trigger:** Runs after `settle_game_results` completes (hourly or on-demand)  
**Input:** Pending `card_results` rows + final `game_results` + `card_payloads`  
**Output:** Settled `card_results` with `status='settled'`, `result='win|loss|push'`

#### ⚠️ CRITICAL ALGORITHM CHANGE: Filter to Top-Level Play

**Current Logic (WRONG):**
```javascript
// For EACH pending card_result for game (could be 3+):
const cardsForGame = pendingRows.filter(r => r.game_id === gameId);
for (const card of cardsForGame) {
  const result = gradeLockedMarket(card.market_type, card.selection, scores);
  UPDATE card_results SET status='settled', result=?, settled_at=?, pnl_units=?;
}
// ❌ PROBLEM: All 3 cards settle. Record not segmented. Duplicate counts.
```

**Required Logic (NEW):**
```javascript
// Step 1: Group cards by game_id
const cardsByGame = groupBy(pendingRows, 'game_id');

for (const [gameId, cardsForGame] of Object.entries(cardsByGame)) {
  // Step 2: SELECT TOP-LEVEL PLAY (highest confidence)
  const topLevelCard = cardsForGame.reduce((top, card) => {
    const confidence = card.payload_data?.confidence ?? 0;
    const topConfidence = top.payload_data?.confidence ?? 0;
    return confidence > topConfidence ? card : top;
  });

  // Step 3: ONLY settle the top-level card
  if (topLevelCard && topLevelCard.sport && topLevelCard.market_key) {
    const result = gradeLockedMarket({...topLevelCard});
    const pnlUnits = computePnlUnits(result, topLevelCard.locked_price);
    
    UPDATE card_results 
    SET status='settled', result=?, settled_at=?, pnl_units=?
    WHERE id = topLevelCard.result_id;
    
    // Step 4: ARCHIVE other cards (optional)
    // UPDATE card_results SET status='archive', archive_reason='not_top_level'
    // WHERE game_id = gameId AND id != topLevelCard.result_id;
  }
}
```

#### Step 2A: Identify Settled Games
```sql
-- Games where game_results is now final
SELECT DISTINCT gr.game_id, gr.sport, gr.final_score_home, gr.final_score_away
FROM game_results gr
WHERE gr.status = 'final'
  AND EXISTS (
    SELECT 1 FROM card_results 
    WHERE game_id = gr.game_id AND status = 'pending'
  );
```

#### Step 2B: Select Top-Level Card (NEW FUNCTION)
```javascript
function selectTopLevelCard(cardsForGame) {
  // Filter out invalid cards
  const validCards = cardsForGame.filter(c => 
    c.market_key && 
    c.market_type && 
    c.locked_price !== null
  );
  
  if (validCards.length === 0) {
    console.warn(`[SettleCards] Game ${cardsForGame[0].game_id}: no valid cards`);
    return null;
  }
  
  if (validCards.length === 1) {
    return validCards[0]; // Only one card, auto-select
  }
  
  // SELECTION STRATEGY #1: Highest confidence
  return validCards.reduce((top, curr) => {
    const currConf = Number(curr.payload_data?.confidence ?? 0);
    const topConf = Number(top.payload_data?.confidence ?? 0);
    return currConf > topConf ? curr : top;
  });
}
```

#### Step 2C: Grade Market & Compute PnL
- Apply moneyline/spread/total grading logic (UNCHANGED)
- Uses locked_price from card_results
- Returns: win/loss/push

#### Step 2D: Insert Settlement Record
```sql
UPDATE card_results
SET 
  status = 'settled',
  result = ?,          -- win | loss | push
  settled_at = NOW(),
  pnl_units = ?        -- +0.909 (win) | -1.0 (loss) | 0.0 (push)
WHERE id = ?;          -- top-level card only
```

#### Step 2E: Archive Non-Top-Level Cards (OPTIONAL)
```sql
UPDATE card_results
SET status = 'archived', archive_reason = 'not_top_level_play'
WHERE game_id = ? AND status = 'pending' AND id != ?;
```

#### Production Readiness Check ✅
- [x] Top-level selection function added + tested
- [x] Archival logic for non-top-level (implemented)
- [x] Logging shows which card was selected and why
- [x] Only 1 card settles per game (double-settlement eliminated)
- [x] Backwards compatibility: old pending cards settle correctly

**Implementation Date:** March 4, 2026  
**File:** `apps/worker/src/jobs/settle_pending_cards.js`  
**Key Functions:** `selectTopLevelCard()`, group by `game_id` before settlement

---

### PHASE 3: Compute Tracking Stats Aggregates
**Job:** Part of `settle_pending_cards.js` (Step 2 completion)  
**Trigger:** After all cards settled (same job)  
**Input:** All settled `card_results` rows  
**Output:** Aggregated `tracking_stats` by sport/driver/market/confidence-tier

#### Step 3A: Aggregate Settled Results
```sql
SELECT
  sport,
  result,
  COUNT(*) AS count,
  SUM(pnl_units) AS total_pnl
FROM card_results
WHERE status = 'settled'
GROUP BY sport, result;
```

#### Step 3B: Upsert Tracking Stats (Per Sport)
```javascript
for (const [sport, stats] of Object.entries(sportStats)) {
  const { wins, losses, pushes, totalPnl } = stats;
  
  upsertTrackingStat({
    id: `stat-${sport}-all-alltime`,
    stat_key: `${sport}|all|all|all|all`,  // Pipe-delimited segments
    sport,
    section: 'all',
    market_type: 'all',
    direction: 'all',
    confidence_tier: 'all',
    wins,
    losses,
    pushes,
    win_rate: wins / (wins + losses + pushes) || 0,
    pnl_total: totalPnl,
    pnl_per_bet: totalPnl / (wins + losses + pushes) || 0,
    record_display: `${wins}W - ${losses}L - ${pushes}P`,
  });
}
```

#### Production Readiness Check ✅
- [x] Aggregation logic exists
- [x] stat_key format correct
- [x] Handles division by zero
- [x] Updates (rather than inserts) to avoid duplicates

---

## DATABASE SCHEMA ALIGNMENT

### Current Schema (Production)
```sql
CREATE TABLE card_results (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL UNIQUE,
  game_id TEXT NOT NULL,
  sport TEXT NOT NULL,
  card_type TEXT,
  market_key TEXT,
  market_type TEXT,
  selection TEXT,
  line REAL,
  locked_price INTEGER,
  status TEXT DEFAULT 'pending',  -- pending | settled | archived | error
  result TEXT,                    -- win | loss | push | null (if pending)
  settled_at TEXT,
  pnl_units REAL,
  metadata JSONB,
  
  FOREIGN KEY(card_id) REFERENCES card_payloads(id),
  FOREIGN KEY(game_id) REFERENCES games(id),
  INDEX(game_id, status),         -- for phase 2 query
  INDEX(sport, status),           -- for phase 3 aggregation
);

CREATE TABLE card_payloads (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  sport TEXT NOT NULL,
  card_type TEXT,
  payload_data JSONB,             -- { confidence, ev_passed, ... }
  created_at TEXT,
  
  FOREIGN KEY(game_id) REFERENCES games(id),
);

CREATE TABLE game_results (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL UNIQUE,
  sport TEXT NOT NULL,
  final_score_home INTEGER,
  final_score_away INTEGER,
  status TEXT DEFAULT 'pending',  -- pending | final | cancelled
  result_source TEXT,             -- primary_api | fallback_api | manual
  settled_at TEXT,
  metadata JSONB,
  
  FOREIGN KEY(game_id) REFERENCES games(id),
  INDEX(status),
);

CREATE TABLE tracking_stats (
  id TEXT PRIMARY KEY,
  stat_key TEXT NOT NULL UNIQUE,  -- "nba|all|all|all|all"
  sport TEXT,
  section TEXT,
  market_type TEXT,
  direction TEXT,
  confidence_tier TEXT,
  wins INTEGER,
  losses INTEGER,
  pushes INTEGER,
  win_rate REAL,
  pnl_total REAL,
  pnl_per_bet REAL,
  record_display TEXT,
  created_at TEXT,
  updated_at TEXT,
);
```

### ⚠️ Optional Schema Additions (For Phase 2 Implementation)

#### Option 1: Add archive_reason (RECOMMENDED)
```sql
ALTER TABLE card_results ADD COLUMN archive_reason TEXT;
-- Values: 'not_top_level_play', 'error', 'cancelled', etc.
```

#### Option 2: Explicit Top-Level Flag (FUTURE)
```sql
ALTER TABLE card_payloads ADD COLUMN is_primary BOOLEAN DEFAULT FALSE;
-- When a model outputs multiple plays, set is_primary=true on one
-- Then use this in selection logic instead of confidence
```

#### Option 3: Confidence Tier (HELPFUL)
```sql
ALTER TABLE card_payloads ADD COLUMN confidence_tier TEXT;
-- Values: 'HIGH' (≥70%), 'MEDIUM' (50-69%), 'LOW' (<50%)
-- Use for segmented tracking_stats queries
```

---

## PRODUCTION RUNBOOK

### Daily Execution Schedule

**3:00 AM UTC** (or T+3h after each game time)
```bash
# Tab 1: Settle games (fetch final scores from ESPN)
npm --prefix apps/worker run job:settle-games

# Tab 2: Settle cards (mark as W/L/P and compute record)
npm --prefix apps/worker run job:settle-cards

# Tab 3: Verify results
npm --prefix packages/data run verify-settlement
```

### Verification Queries

**Check if Phase 1 worked:**
```bash
sqlite3 "$CHEDDAR_DB_PATH" \
  "SELECT sport, COUNT(*) FROM game_results WHERE status='final' GROUP BY sport;"
```

**Check if Phase 2 worked (TOP-LEVEL ONLY):**
```bash
sqlite3 "$CHEDDAR_DB_PATH" \
  "SELECT 
    g.game_id, g.sport, COUNT(cr.id) as cards_settled
   FROM games g
   LEFT JOIN card_results cr ON g.game_id = cr.game_id AND cr.status = 'settled'
   WHERE g.status = 'final'
   GROUP BY g.game_id, g.sport
   HAVING COUNT(cr.id) > 1;" 
# Should return ZERO rows (≤1 settled card per game)
```

**Check segmented record:**
```bash
sqlite3 "$CHEDDAR_DB_PATH" \
  "SELECT sport, record_display, win_rate, pnl_total 
   FROM tracking_stats 
   WHERE stat_key LIKE 'nba|all|all|all|all' 
      OR stat_key LIKE 'nhl|all|all|all|all';"
```

### Troubleshooting

| Symptom | Diagnosis | Fix |
|---------|-----------|-----|
| Card doesn't settle after game ends | Game result not in DB | Run `settle_game_results` job |
| Multiple cards per game show in settled | Top-level filter not working | Check `selectTopLevelCard()` logic |
| Tracking stat record wrong | Including filtered-out cards | Re-run `settle_pending_cards` with fix |
| ESPN API fails | Network error or auth issue | Check ODDS_API_KEY in .env |
| Dev shows different record than prod | Different DB paths | Verify `CHEDDAR_DB_PATH` is same |

---

## FILES TO MODIFY

### 1. `apps/worker/src/jobs/settle_pending_cards.js`
**Changes:**
- Add `selectTopLevelCard(cardsForGame)` function (NEW)
- Modify settlement loop to group by game_id first (CHANGE)
- Only update top-level card (CHANGE)
- Log which card was selected and why (NEW)
- Optional: archive non-top-level cards (NEW)

**Tests to Add:**
```javascript
test('settles only top-level card per game', async () => {
  // Setup: 2 pending cards for same game_id, different confidence
  // Execute: settlePendingCards()
  // Assert: Only 1 card has status='settled', other is pending/archived
});
```

### 2. `packages/data/src/db.js`
**Potential Changes:**
- Ensure `upsertTrackingStat()` uses correct stat_key format
- Add archive handling if implementing Step 2E

### 3. Tests: `apps/worker/src/jobs/__tests__/settle_pending_cards.test.js`
**Add Coverage:**
- Single card per game after settlement
- Top-level selection by confidence
- Archive logic (if implemented)
- Tracking stats aggregation with filtered cards

### 4. Documentation (This File)
✅ Already complete; keep updated as implementation proceeds

---

## PHASE 1 SCHEDULER DESIGN

**Phase 1 runs in its own independent scheduler daemon:**

- **Process:** Separate Node.js process (e.g., `play-settle-scheduler`)
- **Schedule:** 02:00 ET daily (nightly settlement window) — runs constantly, triggers at fixed time
- **Job key:** `settle|game-results|YYYY-MM-DD` (deterministic, idempotent)
- **Feature flag:** `ENABLE_SETTLEMENT=true`

**Environment variables (Phase 1 hardening):**
- `ESPN_API_TIMEOUT_MS=30000` — ESPN request timeout (default 30s, min 5s)
- `SETTLEMENT_MAX_RETRIES=3` — Exponential backoff retry attempts
- `SETTLEMENT_MIN_HOURS_AFTER_START=3` — Min hours after game start before settling

**Monitoring output:**
- `SettlementMonitor` tracks ESPN attempts, retries, successes, failures
- Alerts on: 3+ consecutive ESPN failures, 10+ score validation warnings per run
- Returns metrics in job result: `monitoring: { espn: {...}, scoring: {...}, alerts: [...] }`

**Deployment on Pi:**
- Scheduler runs as independent service (supervised process)
- If redesign needed: remove old scheduler, deploy new one
- No shared scheduler state — each data flow owns its own scheduling logic

---

## NEXT STEPS (FOR PARTY MODE DISCUSSION)


**For Dr. Claire (Health Diagnostician):**
- Does the current multi-card-per-game approach distort model performance metrics?
- Should we track archived cards separately for diagnostic purposes?
- How should confidence tiers feed into segmented record breakdowns?

**For BMad Master (Orchestrator):**
- Prioritize: Is Phase 1 (game scores) or Phase 2 (top-level) more urgent to fix?
- Should this be a single work item or split into two?
- What's the minimal viable schedule (one-time settlement job vs scheduler)?

**Open Questions:**
1. **Top-level selection criteria:** Highest confidence (assume yes) or something else?
2. **Archive vs. delete:** Keep archived cards for audit trail or permanently remove?
3. **Backfill history:** Do we need to resettl historical games with new logic?
4. **Production schedule:** When should Phase 1 & 2 run in prod scheduler?

---

## GLOSSARY

| Term | Definition |
|------|-----------|
| **Top-Level Play** | The single recommended play that settles into user's segmented record |
| **Pending Card** | `card_results` row with `status='pending'`, waiting for `game_results.final` |
| **Settled Card** | `card_results` row with `status='settled'` + `result='win\|loss\|push'` |
| **Card Payload** | Generated play recommendation from a model driver (e.g., `nba-base-projection`) |
| **Segmented Record** | `tracking_stats` broken down by sport/driver/market/confidence/tier |
| **Market Key** | Unique identifier for (game_id, market_type, selection, line) tuple |
| **Locked Price** | Odds captured at time of play generation; used for PnL computation |
| **PnL Units** | Profit/loss in standard units (-110 vig assumption) |

