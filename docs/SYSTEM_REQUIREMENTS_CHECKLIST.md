# System Requirements Checklist
## What Needs to Be True for Dev & Prod to Work

**Last Updated:** 2026-03-02  
**Status:** 🔴 Dev partial (only NHL showing), Prod broken (0 games)

---

## 🎯 Success Criteria

### Dev Environment
- ✅ Database populated with multi-sport games (NBA, NHL, NCAAM, SOCCER)
- ✅ All future games have sport-appropriate cards
- ❌ **UI displays ALL sports** (currently only NHL visible)
- ❌ **Settlement records ONLY top-level play** per game
- ✅ No runtime errors on /cards or /results pages

### Production Environment
- ❌ **Database initialization succeeds during Vercel build**
- ❌ **Games show on /cards page** (currently 0 games)
- ❌ **Results show on /results page** (currently 0 results)
- ❌ Settlement records ONLY top-level play per game
- ✅ Build verification passes (verify-db.js)

---

## 📋 Component Checklist

### 1. Database Layer ✅ COMPLETE

**Requirements:**
- [x] Games table populated with multi-sport data
- [x] Future games (after midnight ET) include NBA, NCAAM, NHL, SOCCER
- [x] Card payloads use sport-specific card types
- [x] No mismatched card types (e.g., NBA game with NHL card)
- [x] Cards have proper payload structure with recommendation object

**Verification:**
```bash
cd packages/data
npm run db:inspect          # Shows 239 games total
npm run db:check-api-filter # Shows 29 future games: 5 NBA, 18 NCAAM, 6 NHL
npm run db:check-coverage   # Shows 100% card coverage
npm run db:check-mismatch   # Shows minimal mismatches (legacy data)
```

**Current State:** ✅ Database has correct multi-sport data

---

### 2. API Layer ✅ COMPLETE

**Requirements:**
- [x] `/api/games` returns games after midnight ET
- [x] Games include all sports (not just NHL)
- [x] Each game includes plays array from card_payloads
- [x] Date filtering uses correct UTC conversion
- [x] Odds data merged from latest_odds CTE

**Verification:**
```bash
# Dev test
curl http://localhost:3000/api/games | jq '.data | map(.sport) | unique'
# Expected: ["NBA", "NCAAM", "NHL"] or similar

# Check game count
curl http://localhost:3000/api/games | jq '.data | length'
# Expected: 29 (matching db:check-api-filter count)
```

**Current State:** ✅ API query logic is correct (verified via check-api-filter.js)

**Open Question:** Need to verify actual HTTP response in dev

---

### 3. Frontend Layer ⚠️ NEEDS INVESTIGATION

**Requirements:**
- [x] DEFAULT_FILTERS includes all sports: `['NHL', 'NBA', 'NCAAM', 'SOCCER']`
- [ ] No hardcoded sport filter overriding defaults
- [ ] transformGames correctly processes all sports
- [ ] enrichCards doesn't filter out specific sports
- [ ] UI renders cards for all sports returned by API

**Verification Steps:**
1. Add console.log in CardsPageClient.tsx after API response
2. Check if `games.length` matches API response
3. Verify `games.map(g => g.sport)` includes all sports
4. Check FilterPanel isn't resetting sports filter on mount

**Files to Check:**
- [web/src/components/cards-page-client.tsx](web/src/components/cards-page-client.tsx) - L95-105 (useEffect fetchGames)
- [web/src/lib/game-card/transform.ts](web/src/lib/game-card/transform.ts) - transformGames function
- [web/src/lib/game-card/tags.ts](web/src/lib/game-card/tags.ts) - enrichCards function
- [web/src/lib/game-card/filters.ts](web/src/lib/game-card/filters.ts) - applyFilters function
- [web/src/components/filter-panel.tsx](web/src/components/filter-panel.tsx) - Sport checkboxes

**Current State:** ⚠️ Filters LOOK correct but UI only shows NHL

**Hypothesis:** 
- API might be returning only NHL games due to bad data expires
- FilterPanel might have localStorage override
- transformGames might skip games with missing data fields

**Next Action:** Add debug logging to frontend API fetch

---

### 4. Settlement Logic 🚧 NEEDS IMPLEMENTATION

**User Requirement:**
> "We also need to make sure that we settle the correct play that we called. ONLY the top level play suggested gets recorded."

**Current Behavior:**
- Unknown - need to trace settlement flow

**Required Behavior:**
- One play per game recorded in card_results
- "Top level play" = highest confidence? Primary recommendation? First card?

**Critical Questions:**
1. **What is "top level play"?**
   - Highest confidence play?
   - First play in recommendation array?
   - Play with tier === 'SUPER' or 'BEST'?
   - Play with evPassed === true?
   
2. **Where does settlement happen?**
   - Find settlement script/service
   - Check card_results insertion logic
   - Verify game_results triggers settlement

3. **Is there deduplication?**
   - Does system create multiple card_results per game?
   - Need to add UNIQUE constraint or pre-filter?

**Files to Investigate:**
- Search for "card_results" INSERT statements
- Search for "settle" or "settlement" functions
- Check worker/src for background jobs
- Look for game_results triggers

**Next Action:** Search codebase for settlement logic

---

### 5. Build & Deployment 🔴 PRODUCTION BROKEN

**Requirements:**
- [x] `scripts/init-db-vercel.sh` executes during Vercel build
- [x] CHEDDAR_DB_PATH environment variable set correctly
- [x] seed-test-odds.js runs successfully
- [x] seed-cards.js runs successfully
- [x] verify-db.js passes (exits 0)
- [ ] Database file included in deployment artifact
- [ ] Production /api/games returns data

**Verification:**
```bash
# Check Vercel build logs
vercel logs <deployment-url> --build

# Expected behavior:
# ✅ Running init-db-vercel.sh...
# ✅ Database initialized at: /tmp/cheddar.db
# ✅ Seeding test odds...
# ✅ Seeding cards...
# ✅ Verification: 239 games, 29 future games, 81 cards

# Check production endpoint
curl https://<your-domain>/api/games | jq '.data | length'
```

**Current State:** 🔴 Production shows 0 games, 0 results

**Possible Issues:**
1. Database file not persisted between build and runtime
2. CHEDDAR_DB_PATH points to wrong location in production
3. Seed scripts failing silently in build
4. Vercel build timeout
5. SQLite not included in deployment

**Files to Check:**
- [vercel.json](vercel.json) - Check build command
- [package.json](package.json) - Check scripts
- [scripts/init-db-vercel.sh](scripts/init-db-vercel.sh) - Check paths
- Vercel Environment Variables - CHEDDAR_DB_PATH

**Next Action:** Review Vercel build logs and deployment config

---

## 🔧 Recommended Fix Plan

### Phase 1: Diagnose Frontend (Dev)
**Goal:** Understand why UI shows only NHL when DB has all sports

**Tasks:**
1. Add debug logging to CardsPageClient API fetch
   ```typescript
   const response = await fetch('/api/games');
   const json = await response.json();
   console.log('API returned games:', json.data.length);
   console.log('Sports:', json.data.map(g => g.sport));
   setGames(json.data);
   ```

2. Test API endpoint directly
   ```bash
   curl http://localhost:3000/api/games | jq '.data | map({sport, homeTeam, awayTeam}) | .[:5]'
   ```

3. Check browser console for:
   - API response data
   - Filter application results
   - Render count per sport

**Expected Outcome:** Identify if issue is API response or frontend filtering

---

### Phase 2: Fix Settlement Logic
**Goal:** Ensure only top-level play recorded per game

**Tasks:**
1. Search for settlement implementation
   ```bash
   cd /Users/ajcolubiale/projects/cheddar-logic
   grep -r "INSERT INTO card_results" .
   grep -r "settle" --include="*.js" --include="*.ts" packages/ apps/
   ```

2. Define "top level play" criteria with user
   - Ask clarifying question about logic

3. Implement deduplication:
   - Option A: Filter plays array before insertion (1 play per game)
   - Option B: Add UNIQUE constraint on (game_id, card_type, prediction)
   - Option C: Pre-settlement aggregation logic

4. Add test coverage for settlement
   ```javascript
   test('only records one play per game', () => {
     // Setup: Game with 3 plays
     // Execute: Settlement
     // Assert: card_results has 1 row for game_id
   });
   ```

**Expected Outcome:** Single authoritative play recorded per game

---

### Phase 3: Fix Production Deployment
**Goal:** Get production showing games and results

**Tasks:**
1. Review Vercel configuration
   - Check [vercel.json](vercel.json) build command
   - Verify CHEDDAR_DB_PATH env var
   - Check if database file is in correct location

2. Test build process locally
   ```bash
   cd /Users/ajcolubiale/projects/cheddar-logic
   CHEDDAR_DB_PATH=/tmp/test-cheddar.db ./scripts/init-db-vercel.sh
   ls -lh /tmp/test-cheddar.db
   ```

3. Check Vercel build logs
   ```bash
   vercel logs <deployment-url> --build | grep -A10 -B10 "init-db"
   ```

4. Fix database persistence
   - Possible solutions:
     a) Move DB to `/var/data` (Vercel persistent storage)
     b) Use Vercel Blob Storage
     c) Use external database (Turso, PlanetScale)
     d) Bundle pre-built DB in deployment

**Expected Outcome:** Production /api/games returns >0 games

---

### Phase 4: Integration Testing
**Goal:** Verify full E2E flow works

**Tasks:**
1. Run existing test suite
   ```bash
   cd packages/data
   npm test
   ```

2. Add E2E tests for:
   - Multi-sport API response
   - Frontend renders all sports
   - Settlement creates single record
   - Production deployment succeeds

3. Manual QA checklist:
   - [ ] Dev: Shows NBA, NCAAM, NHL games
   - [ ] Dev: /results shows settled plays
   - [ ] Dev: Only 1 play per game in results
   - [ ] Prod: Shows games after deployment
   - [ ] Prod: Results page populated
   - [ ] Prod: No console errors

**Expected Outcome:** All tests pass, both environments functional

---

## 🚀 Branch Strategy

User requested: "need to sort out Dev on a new branch"

### Recommended Branch: `fix/multi-sport-settlement`

**Scope:**
- Frontend debug logging (temporary)
- Settlement logic fix (only top-level play)
- Production deployment fix
- Updated integration tests
- Documentation updates

**Git Workflow:**
```bash
# Create fix branch
git checkout -b fix/multi-sport-settlement

# Make incremental commits
git commit -m "feat: add debug logging for multi-sport API response"
git commit -m "fix: settlement to record only top-level play per game"
git commit -m "fix: production database initialization"
git commit -m "test: add settlement deduplication tests"
git commit -m "docs: update system requirements checklist"

# Test in dev
npm run dev # Verify all sports show

# Deploy to preview
vercel deploy # Test preview deployment

# Merge to main
git checkout main
git merge fix/multi-sport-settlement
git push origin main

# Deploy to production
vercel deploy --prod
```

---

## 📊 Success Metrics

### Development
- [ ] `/cards` shows games from 3+ sports (NBA, NCAAM, NHL)
- [ ] Game count matches `npm run db:check-api-filter` output (29 games)
- [ ] No console errors
- [ ] Filters work correctly for all sports

### Production
- [ ] Build completes successfully (no verification errors)
- [ ] `/api/games` returns >0 games
- [ ] `/cards` page shows games
- [ ] `/results` page shows settled plays
- [ ] Vercel logs show successful database initialization

### Settlement
- [ ] One entry per game in card_results
- [ ] Entries match "top level play" criteria
- [ ] No duplicate settlements
- [ ] Results page shows correct play type

---

## 🆘 Troubleshooting

### If dev still shows only NHL:
1. Check browser console for API response
2. Verify /api/games returns multiple sports: `curl http://localhost:3000/api/games | jq '.data | map(.sport) | unique'`
3. Check FilterPanel localStorage: Clear browser storage
4. Add console.log in transform.ts and filters.ts

### If prod shows 0 games:
1. Check Vercel build logs for init-db errors
2. Verify CHEDDAR_DB_PATH in Vercel dashboard
3. Test API endpoint: `curl https://your-domain/api/games`
4. Check if SQLite is supported in Vercel runtime
5. Consider migrating to Vercel Postgres or Turso

### If settlement creates duplicates:
1. Check card_results table structure
2. Add UNIQUE constraint on (game_id, settled_at)
3. Pre-filter plays array to single "top level" play
4. Review worker settlement logic

---

## ✅ Sign-Off Checklist

Before merging fix branch to main:

- [ ] All sports visible in dev /cards page
- [ ] Settlement logic verified (1 play per game)
- [ ] Integration tests passing (11/11)
- [ ] Production preview deployment successful
- [ ] Manual QA completed (dev + prod preview)
- [ ] Documentation updated
- [ ] Code review completed
- [ ] User acceptance confirmed

---

## 📚 Related Documentation

- [docs/DATA_PIPELINE_TROUBLESHOOTING.md](docs/DATA_PIPELINE_TROUBLESHOOTING.md) - Diagnostic procedures
- [packages/data/README.md](packages/data/README.md) - Database scripts
- [docs/SETTLEMENT_LOGIC.md](docs/SETTLEMENT_LOGIC.md) - Settlement rules (if exists)
- [web/src/lib/game-card/FILTER-FEATURE.md](web/src/lib/game-card/FILTER-FEATURE.md) - Filter design

---

## 💬 Open Questions for User

1. **Settlement Logic:** What exactly is "top level play"?
   - Highest confidence percentage?
   - First recommendation in payload?
   - Most favorable odds (highest EV)?
   - Play with tier === 'SUPER' or 'BEST'?

2. **Production Strategy:** Should we stick with SQLite or migrate?
   - SQLite works but needs careful Vercel configuration
   - Alternative: Turso (serverless SQLite), Vercel Postgres, PlanetScale
   - Tradeoff: Complexity vs reliability

3. **Multi-Sport Priority:** Which sports are mission-critical?
   - NHL, NBA, NCAAM all equally important?
   - SOCCER (MLS, EPL, UCL) in scope?

---

**Next Immediate Actions:**
1. ✅ Add debug logging to frontend API fetch → Diagnose dev issue
2. 🔍 Search codebase for settlement logic → Understand current behavior
3. 📞 Clarify "top level play" definition with user
4. 🐛 Fix identified issues on new branch
5. 🚀 Deploy to preview and validate before prod
