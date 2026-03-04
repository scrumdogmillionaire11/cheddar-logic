# Implementation Roadmap: Multi-Sport, Settlement, & Production

**Status:** Ready to implement  
**Timeline:** 1-2 days of focused work  
**Branch:** `fix/multi-sport-settlement` (already created)

---

## Phase 1: Settlement Logic (4-6 hours)

### Step 1.1: Implement `selectTopLevelPlay()` Function
**File:** `apps/worker/src/jobs/settle_pending_cards.js`

- Add the sorting function from [TOP_LEVEL_PLAY_SELECTION_SPEC.md](TOP_LEVEL_PLAY_SELECTION_SPEC.md)
- Place at top of file after imports
- Test locally with `node apps/worker/src/jobs/settle_pending_cards.js --dry-run`

### Step 1.2: Modify Settlement Loop
**File:** `apps/worker/src/jobs/settle_pending_cards.js` (lines ~150-250)

Current logic: "settle all pending cards for all games"

New logic:
```javascript
// Old: for (const row of pendingRows) { ... }
// New: 
const gameIds = new Set(pendingRows.map(r => r.game_id));
for (const gameId of gameIds) {
  const cardsForGame = pendingRows.filter(r => r.game_id === gameId);
  const topLevelCard = selectTopLevelPlay(cardsForGame);
  
  if (!topLevelCard) {
    console.log(`[SettleCards] Game ${gameId}: no playable cards`);
    continue;
  }
  
  // ... existing settlement logic for topLevelCard ONLY
}
```

### Step 1.3: Add Tests
**File:** `apps/worker/__tests__/integration.test.js` (new file or add to existing)

Add 5 test cases from spec:
1. Deterministic ranking (SUPER > BEST > WATCH)
2. Confidence breaks tier tie
3. EV-passed breaks confidence tie
4. Stable tie-break
5. Filter out PASS/NEUTRAL predictions

Run: `npm test` (expect all passing, +5 new tests)

### Step 1.4: Verify in Dev
```bash
# Reset test data
cd packages/data && npm run db:clean
npm run seed:test-odds && npm run seed:cards

# Trigger settlement locally
cd ../apps/worker && node src/jobs/settle_pending_cards.js

# Check results: should be 1 result per game
cd ../../packages/data
sqlite3 cheddar.db "SELECT game_id, COUNT(*) FROM card_results GROUP BY game_id;" 
# Expected: All show count=1
```

---

## Phase 2: Production Database (Turso Setup) (3-4 hours)

### Step 2.1: Provision Turso Database
```bash
# Install Turso CLI
npm install -g @tursodatabase/cli

# Sign up and create org (if first time)
turso auth signup

# Create two databases
turso db create cheddar_prod
turso db create cheddar_dev

# Get connection strings
turso db show cheddar_prod --json
turso db show cheddar_dev --json

# Save credentials to .env files (NOT committed)
# .env.local (dev): DATABASE_URL=<turso_dev_connection_string>
# .env.production (create): DATABASE_URL=<turso_prod_connection_string>

> Note: Turso/DATABASE_URL is future work. The current runtime uses CHEDDAR_DB_PATH.
```

### Step 2.2: Update Database Client
**File:** `packages/data/src/db.js`

Add support for `DATABASE_URL` (Turso) in addition to `CHEDDAR_DB_PATH` (local SQLite):

```javascript
function loadDatabase() {
  // Priority 1: DATABASE_URL (Turso)
  if (process.env.DATABASE_URL) {
    return initTursoClient(process.env.DATABASE_URL);
  }
  
  // Priority 2: CHEDDAR_DB_PATH (local SQLite)
  const dbFile = process.env.CHEDDAR_DB_PATH || ...
  return loadSqliteDatabase(dbFile);
}
```

### Step 2.3: Update Seed Scripts
**Files:**
- `packages/data/src/seed-test-odds.js`
- `packages/data/src/seed-cards.js`

Both must work with Turso:
```javascript
// At start of each script:
if (process.env.APP_ENV === 'prod' && !process.env.DATABASE_URL) {
  console.error('ERROR: APP_ENV=prod requires DATABASE_URL (Turso). Set via Vercel env vars.');
  process.exit(1);
}

// Rest of script works unchanged (via db.js abstraction)
```

### Step 2.4: Update Vercel Configuration
**File:** `vercel.json`

```json
{
  "env": {
    "APP_ENV": "prod",
    "DATABASE_URL": "@turso_prod_conn_string"
  }
}
```

**File:** `.env.production` (NEW, not committed to git)

```
APP_ENV=prod
DATABASE_URL=<turso_prod_connection_string>
```

### Step 2.5: Test Vercel Preview Deploy
```bash
git push origin fix/multi-sport-settlement
# Go to Vercel → trigger preview deploy
# Check: /api/games returns data
# Check: vercel logs show successful DB init
```

### Step 2.6: Deploy to Production
```bash
git checkout main
git merge fix/multi-sport-settlement
git push origin main

# Vercel auto-deploys
# Check: https://<your-domain>/api/games returns data
```

---

## Phase 3: Database Path Guardrails (2-3 hours)

### Step 3.1: Fail-Fast on Missing Database Path
**File:** `packages/data/src/db.js`

```javascript
function loadDatabase() {
  const dbPath = process.env.CHEDDAR_DB_PATH;
  
  if (dbPath && !fs.existsSync(dbPath)) {
    console.error(`ERROR: CHEDDAR_DB_PATH specified but file not found: ${dbPath}`);
    console.error(`Set CHEDDAR_DB_PATH to an existing file, or use DATABASE_URL for Turso.`);
    process.exit(1);
  }
  
  // Rest of logic...
}
```

### Step 3.2: Centralize Database Client Export
**File:** `packages/data/src/index.js` (or create `db-client.js`)

All API routes and scripts must import from **one place**:

```javascript
// ✅ DO THIS
const { getDatabase, initDb } = require('@cheddar-logic/data');

// ❌ DON'T DO THIS
const db = new Database(process.env.CHEDDAR_DB_PATH);
```

### Step 3.3: Environment Validation on Startup
**File:** `packages/data/src/db-validator.js` (NEW)

```javascript
function validateDbConfig() {
  const env = process.env.APP_ENV || 'dev';
  const hasUrl = !!process.env.DATABASE_URL;
  const hasPath = !!process.env.CHEDDAR_DB_PATH;
  
  if (env === 'prod') {
    if (!hasUrl) {
      console.error('ERROR: APP_ENV=prod requires DATABASE_URL');
      process.exit(1);
    }
    if (hasPath) {
      console.error('ERROR: APP_ENV=prod should not have CHEDDAR_DB_PATH');
      process.exit(1);
    }
  }
  
  if (env === 'dev') {
    if (!hasPath && !hasUrl) {
      console.warn('WARN: No database configured. Using in-memory SQLite.');
    }
  }
}
```

Call on app startup (both API and scripts).

---

## Phase 4: Git Cleanup (1 hour)

### Step 4.1: Remove Database Files from Repo
```bash
git rm --cached packages/data/cheddar.db
git rm --cached /tmp/cheddar-logic/cheddar.db 2>/dev/null || true

# Create archive backup locally (not committed)
mkdir -p archive
cp packages/data/cheddar.db archive/cheddar.db.2026-03-02.bak
```

### Step 4.2: Update .gitignore
**File:** `.gitignore`

```bash
# Database files (use DATABASE_URL for Turso instead)
*.db
*.db-wal
*.db-shm
cheddar.db*
/data/
/tmp/
```

### Step 4.3: Remove from Git History (if needed)
```bash
# Only if cheddar.db is huge in history:
# git filter-branch --tree-filter 'rm -f packages/data/cheddar.db' HEAD
# (be careful: this rewrites history)
```

---

## Phase 5: Prod→Dev Refresh (Optional, Document for Later)

**When you need to refresh dev DB from production:**

```bash
# 1. Create snapshot in Turso
turso db shell cheddar_prod < backup_schema.sql

# 2. Clone to dev
turso db shell cheddar_prod ".dump" | turso db shell cheddar_dev

# 3. Run sanitizer (remove secrets, anonymize users, etc.)
node scripts/sanitize-db.js --source cheddar_dev --remove-tokens --anonymize-email

# 4. Verify
curl http://localhost:3000/api/games  # Should still have data
npm test  # Should pass
```

---

## Checklist for Dev Agent

### Settlement Logic
- [ ] Add `selectTopLevelPlay()` function to settle_pending_cards.js
- [ ] Update settlement loop to filter to 1 card per game
- [ ] Add 5 test cases (tier, confidence, ev, tie-break, pass-filter)
- [ ] Run `npm test` — all passing
- [ ] Verify dev: 1 result per game in card_results
- [ ] Commit: `feat: implement top-level play selection for settlement`

### Turso Setup
- [ ] Provision `cheddar_prod` and `cheddar_dev` databases
- [ ] Get connection strings
- [ ] Save to appropriate `.env` files (not committed)
- [ ] Update `packages/data/src/db.js` for DATABASE_URL support
- [ ] Update seed scripts to validate APP_ENV
- [ ] Update `vercel.json` with DATABASE_URL env var
- [ ] Test preview deploy
- [ ] Commit: `feat: add Turso database support`

### Guardrails
- [ ] Add fail-fast on missing CHEDDAR_DB_PATH
- [ ] Centralize database client (one import path)
- [ ] Add `db-validator.js` with environment checks
- [ ] Call validator on API startup + script startup
- [ ] Commit: `feat: add database path validation guardrails`

### Git Cleanup
- [ ] Remove `*.db` files from repo
- [ ] Update `.gitignore`
- [ ] Archive old databases locally (backup)
- [ ] Commit: `chore: remove database files from repository`

### Documentation
- [ ] Create TURSO_SETUP.md with credentials + recovery steps
- [ ] Create ENVIRONMENT_VARIABLES.md (how to set DATABASE_URL vs CHEDDAR_DB_PATH)
- [ ] Update DEPLOYMENT.md with prod→dev refresh steps
- [ ] Commit: `docs: add production database documentation`

### Final Verification
- [ ] Vercel preview deploys successfully
- [ ] /api/games returns data in preview
- [ ] Settlement writes 1 result per game
- [ ] All tests passing (11+ tests)
- [ ] `/cards` page renders all sports
- [ ] `/results` page shows settled plays
- [ ] Manual QA sign-off
- [ ] Commit: `chore: merge fix/multi-sport-settlement to main`

---

## Environment Variable Legend

| Variable | Dev | Staging | Prod | Notes |
|----------|-----|---------|------|-------|
| `APP_ENV` | `dev` | `staging` | `prod` | Controls which DB to use |
| `DATABASE_URL` | ❌ (local) | ✅ | ✅ | Turso connection string |
| `CHEDDAR_DB_PATH` | ✅ | ❌ | ❌ | Local SQLite file path |
| `NODE_ENV` | `development` | `production` | `production` | Standard Node var |

---

## Rollback Plan (if something breaks)

**If Turso goes down temporarily:**
1. Fall back to bundled `cheddar.db` (pre-Turso backup)
2. API works read-only until Turso recovers
3. No new settlements written

**If settlement logic breaks:**
1. Revert commit: `git revert <commit-hash>`
2. Fall back to settling all cards per game (old behavior)
3. Investigate root cause

**If production deploy fails:**
1. Check Vercel logs: `vercel logs <url> --build`
2. Verify DATABASE_URL is set in Vercel env
3. Re-deploy: `vercel deploy --prod`

---

## Post-Launch Monitoring

**Daily checks:**
- [ ] /api/games returning data (non-zero count)
- [ ] Settlement job running (check worker logs)
- [ ] No database connection errors in logs
- [ ] Turso dashboard: CPU/memory nominal

**Weekly:**
- [ ] Test prod→dev refresh (if applicable)
- [ ] Verify backups available
- [ ] Check for any error spikes

---

## References

- [TOP_LEVEL_PLAY_SELECTION_SPEC.md](TOP_LEVEL_PLAY_SELECTION_SPEC.md) — Sorting function spec
- [SYSTEM_CHECKLIST_AND_FIXES.md](SYSTEM_CHECKLIST_AND_FIXES.md) — Architecture overview
- Turso docs: https://docs.turso.tech/
- Vercel env vars: https://vercel.com/docs/projects/environment-variables
