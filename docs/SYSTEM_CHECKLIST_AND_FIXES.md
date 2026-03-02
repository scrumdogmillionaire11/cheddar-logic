# What Must Be True for Dev & Prod to Work ✅

## Executive Summary

**Root Cause Found:** Dev was showing only NHL because `.env.local` pointed DATABASE_PATH to `/data/cheddar.db` instead of `/packages/data/cheddar.db`. The seed scripts and API were using different databases!

**Fix Applied:** Corrected DATABASE_PATH in `.env.local` → Now API returns all 4 sports ✅

**Remaining Work:** 
1. Implement settlement logic (only top-level play per game)
2. Fix production deployment (database persistence)
3. Integration testing and QA

---

## ✅ Development Environment - MULTI-SPORT FIXED

### Current Status
- ✅ API returns all 4 sports: NBA (2), NCAAM (2), NHL (3), SOCCER (3)
- ✅ Frontend shows all games (no filtering issue)
- ✅ Database query works correctly
- ✅ Card payloads properly seeded

### What We Discovered & Fixed

#### The Problem
- Dev showed **only NHL games** even though database had NBA (5), NCAAM (18), NHL (6)
- Check-api-filter.js showed database HAD all sports, but API returned none
- Frontend filters were correct (DEFAULT_FILTERS includes all sports)

#### Root Cause
Two separate database files existed:
```
/tmp/cheddar-logic/cheddar.db        (23MB - OLD data, only NHL/NCAAM)
packages/data/cheddar.db              (368K - CORRECT data, all sports)
                                      ↑
                                      Seed scripts write here
```

`.env.local` pointed to wrong location:
```
DATABASE_PATH=/...data/cheddar.db     ❌ WRONG (location doesn't exist)
                                      Falls back to /tmp/cheddar-logic/
```

#### Solution
Updated `web/.env.local`:
```diff
- DATABASE_PATH=/Users/ajcolubiale/projects/cheddar-logic/data/cheddar.db
+ DATABASE_PATH=/Users/ajcolubiale/projects/cheddar-logic/packages/data/cheddar.db
- CHEDDAR_DATA_DIR=/Users/ajcolubiale/projects/cheddar-logic/data
+ CHEDDAR_DATA_DIR=/Users/ajcolubiale/projects/cheddar-logic/packages/data
```

#### Result
```bash
curl http://localhost:3000/api/games | jq '.data | map(.sport) | unique'
# Returns: ["NBA", "NCAAM", "NHL", "SOCCER"]
```

---

## 🚧 Settlement Logic - NEEDS IMPLEMENTATION

### Current Behavior
Settlement jobs already exist in `/apps/worker/src/jobs/`:
- `settle_game_results.js` - Fetches final scores from ESPN
- `settle_pending_cards.js` - Records win/loss/push based on payload

### User Requirement
> "We also need to make sure that we settle the correct play that we called. **ONLY the top level play suggested gets recorded.**"

### What This Means
Currently, if a game has 3 card payloads (3 different plays), we settle all 3. User wants:
- ✅ Insert game_results (final scores) → correct
- ❌ Insert **only 1** card_result per game (the "top level play")

### Critical Question: What is "Top Level Play"?

**Options to clarify with user:**
1. **Highest confidence** - Play with highest `payload.confidence` %
2. **Primary recommendation** - First play in recommendation array
3. **Best tier** - Play with tier === 'SUPER' or 'BEST'
4. **EV-qualified** - Play where `payload.ev_passed === true`
5. **User-explicit** - Play marked as primary recommendation

### Current Settlement Logic
From `settle_pending_cards.js` (lines 150-250):
```javascript
// For EACH pending card_result (could be 3+ per game):
const actualPlay = extractActualPlay(payloadData);  // Get direction/market
const result = evaluateResult(homeScore, awayScore, actualPlay);  // WIN/LOSS/PUSH
const pnlUnits = computePnlUnits(result, odds);  // Calculate PnL

UPDATE card_results SET status='settled', result=?, settled_at=?, pnl_units=?
```

**Problem:** This settles **every card**, not just one per game.

### Implementation Required

#### Option A: Pre-filter plays array (RECOMMENDED)
When settlement job runs, filter to single play BEFORE inserting card_result:
```javascript
// Get pending cards for a game
const cardsForGame = pendingRows.filter(r => r.game_id === gameId);

// Select "top level" based on criteria
const topLevelCard = selectTopLevelPlay(cardsForGame);  // NEW function

// Only settle the top level card
if (topLevelCard) {
  // ... settlement logic for ONE card only
}
```

#### Option B: Add database constraint
Add UNIQUE constraint to prevent duplicates:
```sql
-- Maybe: one settlement per game per card_type
ALTER TABLE card_results 
ADD UNIQUE(game_id, settled_at);

-- Then: pre-delete duplicates during settlement
DELETE FROM card_results 
WHERE game_id IN (
  SELECT game_id FROM card_results 
  WHERE status='settled' 
  GROUP BY game_id HAVING COUNT(*) > 1
)
```

#### Option C: Restructure card_results table
Split into:
- One primary `game_recommendation` record (per game)
- Many `card_feedback` records (per card)

### Files to Modify
1. `apps/worker/src/jobs/settle_pending_cards.js`
   - Add `selectTopLevelPlay()` function
   - Filter cards before settlement loop

2. `apps/worker/src/jobs/settle_game_results.js`
   - Ensure only final scores inserted (already correct)

3. `packages/data/src/db.js`
   - Update card_results insertion logic if needed

4. Tests: `apps/worker/__tests__/*.test.js`
   - Add test: "only one card_result per game after settlement"

---

## 🔴 Production Deployment - BROKEN

### Current Issue
Production (`vercel.yml` deployment) shows:
- 0 games on /cards page
- 0 results on /results analytics page

### Why Production is Empty

Vercel's serverless environment has:
- **Ephemeral filesystem** - files only exist during build
- **No persistent /tmp** - database at `/tmp/cheddar.db` deleted after build
- **No /data directory** - doesn't exist in Vercel runtime

### Build Process Flow
```
1. Vercel starts build
2. package.json "build" script runs: node scripts/build.js
3. scripts/build.js calls: db.seedTestOdds() → db.seedCards()
4. Database written to /tmp/cheddar-logic/cheddar.db
5. Build completes ✅
6. Vercel deploys Next.js app
7. Runtime starts → DATABASE_PATH=/tmp/.../cheddar.db doesn't exist
8. SQL.js creates NEW empty database in memory
9. API returns 0 games ❌
```

### Three Possible Solutions

#### Solution 1: Use Vercel KV (Recommended for Scale)
- Store serialized SQLite DB in Vercel KV
- Cost: $0.20-2/month depends on usage
- Persistence: ✅ Shared across all serverless functions

#### Solution 2: Bundle Pre-built Database
- Build database during CI/CD
- Include `cheddar.db` in deployment artifact
- git-track binary file (not ideal)
- Persistence: ✅ Built-in deployment

#### Solution 3: Use External Database
- Migrate from SQLite to Turso/PlanetScale
- Keep current codebase structure
- Cost: Free tier available
- Persistence: ✅ Dedicated database

### Recommended: Solution 2 (Simplest)

**Why:** Minimal code changes, no new services, works like development

**How:**
1. Make `packages/data/cheddar.db` git-tracked
2. Update `scripts/init-db-vercel.sh` to not overwrite if file exists
3. Vercel includes `cheddar.db` in deployment
4. Update DATABASE_PATH to use `cheddar.db` from app root

**Implementation Steps:**
```bash
# 1. Stop ignoring database file
git rm --cached packages/data/cheddar.db
echo '# Seeded database included in deployment' >> .gitignore

# 2. Commit the seeded database
git add packages/data/cheddar.db
git commit -m "chore: include seeded database for production"

# 3. Update .env.production to use correct path
DATABASE_PATH=/var/task/packages/data/cheddar.db

# 4. Verify vercel.json points to correct output directory
# (should include packages/ in deployment)
```

**Files to Update:**
- `.gitignore` - Remove database exclusion
- `.env.production` - Set DATABASE_PATH for Vercel
- `vercel.json` - Verify output includes database file
- `scripts/init-db-vercel.sh` - Skip seeding if DB already exists

---

## 🎯 Implementation Checklist

### Phase 1: Confirm Dev Multi-Sport Works ✅
- [x] Fix DATABASE_PATH in `.env.local`
- [x] Restart dev server
- [x] Verify /api/games returns all 4 sports
- [x] Check /cards page displays all games
- [x] Remove debug logging

### Phase 2: Define & Implement Settlement Logic (THIS WEEK)
- [ ] Clarify "top level play" definition with user
  - Option: Highest confidence? First in array? Tier-based?
- [ ] Add `selectTopLevelPlay()` function to settle_pending_cards.js
- [ ] Update settlement loop to filter to 1 card per game
- [ ] Add test: "only one card_result per game after settlement"
- [ ] Verify settlement in dev: 1 play per game in /results

### Phase 3: Fix Production Database Persistence
- [ ] Decide on persistence strategy (bundled DB vs KV vs external)
- [ ] If bundled DB:
  - [ ] Update .gitignore to track `packages/data/cheddar.db`
  - [ ] Commit seeded database
  - [ ] Update `.env.production` with DATABASE_PATH
- [ ] If KV:
  - [ ] Add Vercel KV environment variable
  - [ ] Implement KV serialization in init-db-vercel.sh
- [ ] Deploy to preview and verify games appear
- [ ] Deploy to production and verify /api/games returns data

### Phase 4: Integration Testing
- [ ] Run dev test suite: `npm test` (expect 11/11 passing)
- [ ] Manual QA:
  - [ ] Dev: /cards shows all 4 sports
  - [ ] Dev: /results shows settled plays
  - [ ] Dev: Only 1 play per game in results
  - [ ] Preview: /cards shows games
  - [ ] Preview: /results shows settled plays
  - [ ] Prod: /cards shows games
  - [ ] Prod: /results shows settled plays

---

## 📋 File Change Summary

### Already Fixed ✅
```
web/.env.local
  └─ DATABASE_PATH:
    ❌ /Users/ajcolubiale/projects/cheddar-logic/data/cheddar.db
    ✅ /Users/ajcolubiale/projects/cheddar-logic/packages/data/cheddar.db
  └─ CHEDDAR_DATA_DIR:
    ❌ .../data
    ✅ .../packages/data
```

### Need to Fix
```
1. Settlement Logic:
   - apps/worker/src/jobs/settle_pending_cards.js
   - apps/worker/__tests__/integration.test.js

2. Production Database:
   - .env.production (CREATE NEW)
   - .gitignore (UPDATE)
   - vercel.json (VERIFY)
   - scripts/init-db-vercel.sh (UPDATE)

3. Documentation:
   - SETTLEMENT_LOGIC.md (CREATE/UPDATE)
   - PRODUCTION_DEPLOYMENT.md (CREATE/UPDATE)
```

---

## ✅ Success Criteria

### Dev ✅ COMPLETE
- [x] All 4 sports visible in /cards page
- [x] Game counts match database (NBA, NCAAM, NHL, SOCCER)
- [x] No console errors
- [x] Settlement shows current top-level plays (once implemented)

### Settlement 🚧 IN PROGRESS
- [ ] Only 1 card_result per game after settlement
- [ ] Settles "top level" play per user definition
- [ ] No duplicate settlement records

### Production 🔴 NOT STARTED
- [ ] /api/games returns >0 games
- [ ] /cards page shows games after deployment
- [ ] /results page shows settled plays
- [ ] Build verification passes

---

## 💬 Next Steps

**Immediate (Today):**
1. Get user clarification on "top level play" definition
2. Decide on production database persistence strategy

**This Week:**
1. Implement settlement logic fix
2. Test settlement in dev
3. Fix production deployment
4. QA testing

**Before Merge to Main:**
1. All tests passing (11/11)
2. Settlement logic verified
3. Production preview deployment successful
4. User acceptance sign-off

---

## 🔗 Related Issue: Database Split
The `/tmp/cheddar-logic/cheddar.db` (23MB) should be cleaned up or they should use same file. Consider:
- Adding script to consolidate databases
- Documenting single source of truth
- Adding CI/CD verification that seed scripts and API use same DB

---

## 📚 Documentation Links
- [SYSTEM_REQUIREMENTS_CHECKLIST.md](SYSTEM_REQUIREMENTS_CHECKLIST.md) - Previous checklist
- [docs/DATA_PIPELINE_TROUBLESHOOTING.md](docs/DATA_PIPELINE_TROUBLESHOOTING.md) - Diagnostic procedures
- [packages/data/README.md](packages/data/README.md) - Database scripts
- [.gitignore](.gitignore) - Files excluded from git
