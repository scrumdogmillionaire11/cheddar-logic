# 🎯 Handoff to Dev Agent: Multi-Sport Settlement & Production System

**Date:** 2026-03-02  
**Status:** ✅ Architecture decided, specs written, ready to implement  
**Branch:** `fix/multi-sport-settlement` (3 commits, ready to merge)  
**Timeline:** 1-2 weeks of focused work  

---

## 🎬 Decisions Made (3 Clear Answers)

### 1️⃣ Settlement Logic: Deterministic Play Ranking
**Definition:** Select **one** play per game using this priority:

```
1. Tier (SUPER > BEST > WATCH > null)
2. Confidence % (descending)
3. EV-passed (true > false)
4. Edge (descending)
5. Created_at (ascending, stable tie-break)
```

**Why:** Tier reads like "quality class first." Confidence breaks tier ties. EV is secondary validation. Deterministic so you can audit/reproduce decisions.

**Output:** Settlement writes **exactly 1 card_result per game_id**.

**Spec:** Read [TOP_LEVEL_PLAY_SELECTION_SPEC.md](docs/TOP_LEVEL_PLAY_SELECTION_SPEC.md)
- Exact JavaScript function (copy-paste ready)
- 5 test scenarios
- Integration with settle_pending_cards.js

---

### 2️⃣ Production Database: Turso Serverless SQLite
**Why:** 
- Persistence without `/tmp` hassles
- Remote DB you can snapshot/clone
- Free tier available
- Works from Vercel + Pi equally
- Prevents "two database" problem forever

**Setup:**
- `cheddar_prod` (production)
- `cheddar_dev` (development)
- Each has its own connection string
- No production data leaks into dev

**Spec:** Read [IMPLEMENTATION_ROADMAP.md § Phase 2](docs/IMPLEMENTATION_ROADMAP.md#phase-2-production-database-turso-setup-3-4-hours)
- Turso provisioning steps
- DATABASE_URL support in db.js
- Vercel environment variables
- Test + deploy checklists

---

### 3️⃣ Architecture Guardrails (Prevent "Two DB" Forever)
**Problem:** `.env.local` DATABASE_PATH pointed to wrong location → API used different DB than seed scripts.

**Solution:**

#### A. Fail-Fast on Missing Database Path
If `DATABASE_PATH` is set but file doesn't exist → startup error. No silent fallback.

#### B. Centralized Database Client
One shared module: `getDatabase()` and `initDb()` from `@cheddar-logic/data`.
- API imports from it
- Scripts import from it
- seed-cards.js imports from it
- No "two client" problem possible

#### C. Explicit Environment Naming
```
APP_ENV=dev|prod|staging
DATABASE_URL=turso://...  (prod/staging only)
DATABASE_PATH=/local/...  (dev only)
```

If `APP_ENV=prod` and `DATABASE_PATH` set → startup error.

**Spec:** Read [IMPLEMENTATION_ROADMAP.md § Phase 3](docs/IMPLEMENTATION_ROADMAP.md#phase-3-database-path-guardrails-2-3-hours)
- Fail-fast logic
- Centralized client
- Environment validator

---

## 📋 Implementation Checklist (Ready to Execute)

### Phase 1: Settlement Logic (4-6 hours)
- [ ] Add `selectTopLevelPlay()` to settle_pending_cards.js (use spec function)
- [ ] Update settlement loop to filter to 1 card per game (not all)
- [ ] Add 5 tests: tier ranking, confidence tie-break, ev-passed, edge, pass-filter
- [ ] Verify: `card_results` table has 1 row per game_id
- [ ] Commit: `feat: implement top-level play selection`

**Reference:** [TOP_LEVEL_PLAY_SELECTION_SPEC.md](docs/TOP_LEVEL_PLAY_SELECTION_SPEC.md)

---

### Phase 2: Turso Production (3-4 hours)
- [ ] Provision `cheddar_prod` and `cheddar_dev` Turso DBs
- [ ] Save connection strings to `.env.production` (NOT committed)
- [ ] Update `packages/data/src/db.js` for `DATABASE_URL` support
- [ ] Add `APP_ENV` validation to seed scripts
- [ ] Update `vercel.json` with `DATABASE_URL` env var
- [ ] Test preview deploy (should see games on /api/games)
- [ ] Deploy to production
- [ ] Commit: `feat: add Turso database support`

**Reference:** [IMPLEMENTATION_ROADMAP.md § Phase 2](docs/IMPLEMENTATION_ROADMAP.md#phase-2-production-database-turso-setup-3-4-hours)

---

### Phase 3: Database Guardrails (2-3 hours)
- [ ] Add fail-fast check: missing DATABASE_PATH → error
- [ ] Centralize DB client (one import source)
- [ ] Add environment validator (APP_ENV + paths)
- [ ] Call validator on API startup + script startup
- [ ] Commit: `feat: add database validation guardrails`

**Reference:** [IMPLEMENTATION_ROADMAP.md § Phase 3](docs/IMPLEMENTATION_ROADMAP.md#phase-3-database-path-guardrails-2-3-hours)

---

### Phase 4: Git Cleanup (1 hour)
- [ ] Remove `*.db` files from repo
- [ ] Update `.gitignore` to exclude `*.db`
- [ ] Archive local backups (e.g., `archive/cheddar.db.2026-03-02.bak`)
- [ ] Commit: `chore: remove database files from repository`

**Reference:** [IMPLEMENTATION_ROADMAP.md § Phase 4](docs/IMPLEMENTATION_ROADMAP.md#phase-4-git-cleanup-1-hour)

---

### Phase 5: Documentation (1-2 hours)
- [ ] Create `TURSO_SETUP.md` (how to provision, backup, restore)
- [ ] Create `ENVIRONMENT_VARIABLES.md` (all vars, when to use each)
- [ ] Update `DEPLOYMENT.md` with prod→dev refresh steps
- [ ] Commit: `docs: add production system documentation`

**Reference:** [IMPLEMENTATION_ROADMAP.md § Phase 5](docs/IMPLEMENTATION_ROADMAP.md#phase-5-prodbdev-refresh-optional-document-for-later)

---

## ✅ Testing & QA Checklist

### Unit Tests
- [ ] 5 settlement ranking tests (see TOP_LEVEL_PLAY_SELECTION_SPEC.md)
- [ ] Environment validator tests
- [ ] Fail-fast DB path check test
- [ ] Run `npm test` → all passing

### Integration Tests
- [ ] Settlement: Multiple cards per game → 1 card_result
- [ ] Turso: Can write + read from cheddar_prod
- [ ] Turso: Can write + read from cheddar_dev
- [ ] API initializes from Turso (not /tmp)
- [ ] Vercel preview deploy succeeds
- [ ] Vercel prod deploy succeeds

### Manual QA
- [ ] Dev: /api/games returns games
- [ ] Dev: /cards page shows all 4 sports
- [ ] Dev: /results shows settled plays (1 per game)
- [ ] Vercel preview: /cards shows games
- [ ] Vercel preview: /results shows settled plays
- [ ] Production: /cards shows games
- [ ] Production: /results shows settled plays
- [ ] No console errors anywhere

---

## 📚 Specification Files (On fix/multi-sport-settlement Branch)

1. **[TOP_LEVEL_PLAY_SELECTION_SPEC.md](docs/TOP_LEVEL_PLAY_SELECTION_SPEC.md)**
   - Play object shape
   - `selectTopLevelPlay()` JavaScript function (copy-paste ready)
   - 5 test cases with expected outputs
   - Integration with settle_pending_cards.js

2. **[IMPLEMENTATION_ROADMAP.md](docs/IMPLEMENTATION_ROADMAP.md)**
   - 5-phase implementation plan
   - Concrete steps for each phase
   - 35+ checklist items
   - Rollback procedures
   - Post-launch monitoring

3. **[SYSTEM_CHECKLIST_AND_FIXES.md](docs/SYSTEM_CHECKLIST_AND_FIXES.md)**
   - What was broken (dev multi-sport)
   - How we fixed it (DATABASE_PATH correction)
   - Why it happened (silent fallback to old DB)

4. **[SYSTEM_REQUIREMENTS_CHECKLIST.md](docs/SYSTEM_REQUIREMENTS_CHECKLIST.md)**
   - Component-level requirements
   - What needs to be true at each layer
   - Verification procedures

---

## 🔄 Git Workflow

```bash
# Current state
git branch -v
# fix/multi-sport-settlement ... docs: add tournament-ready implementation specs

# When ready to merge (after implementation complete)
git checkout main
git merge fix/multi-sport-settlement
git push origin main
# Vercel auto-deploys
```

---

## 🚀 Success Criteria

### Development
- ✅ Multi-sport showing (fixed via DATABASE_PATH correction)
- 🚧 Settlement writes 1 play per game (implement Phase 1)
- 🚧 Database path guardrails prevent future issues (implement Phase 3)

### Production
- 🚧 Uses Turso (no dependency on /tmp)
- 🚧 Games visible on /api/games
- 🚧 Results show on /results page

### Code Quality
- ✅ All tests passing
- ✅ Deterministic sorting (don't rely on DB ordering)
- ✅ Fail-fast on misconfiguration
- ✅ One import path for database client

---

## 💬 Questions?

Before starting:

1. **Settlement:** Confirm tier ladder is `SUPER > BEST > WATCH > null` ✅
2. **Turso:** Confirm ok to use serverless SQLite in free tier ✅
3. **Staging:** Should we set up `cheddar_staging` DB too? (recommended but not required)

---

## 📞 How to Deploy

Once all tests pass:

```bash
# Merge to main
git checkout main
git merge fix/multi-sport-settlement
git push origin main

# Vercel auto-deploys to production
# Check: https://<your-domain>/api/games

# Monitor:
vercel logs <url> --follow
```

---

## 🔒 Secrets & Credentials

**Never commit:**
- `DATABASE_URL` (Turso connection string)
- `.env.production` (copy Turso credentials here, don't commit)
- `cheddar.db` files (in .gitignore)

**Store securely:**
- Turso credentials in Vercel project settings → Environment Variables
- Local `.env.production` in archive (not committed)
- Backup turso connection strings in password manager

---

## 📖 Architecture Summary

```
User Request
    ↓
Vercel / Dev Server
    ↓
    ├─→ API (next/app/api/games)
    │    └─→ getDatabase() [centralized client]
    │         └─→ DATABASE_URL (Turso) or DATABASE_PATH (local)
    │
    └─→ Script (seed-cards, settle_pending_cards)
         └─→ getDatabase() [same client]
              └─→ DATABASE_URL (Turso) or DATABASE_PATH (local)

Guardrail: Missing DB path → fail-fast error
Guardrail: Multiple clients → single import source
Guardrail: APP_ENV mismatch → validation error
```

---

## ✨ Summary

**What you decided:**
1. Top-level play = Tier > Confidence > EV (deterministic ranking)
2. Production = Turso serverless SQLite (persistence + portability)
3. Architecture = Centralized DB client + fail-fast validation

**What we've delivered:**
1. ✅ Exact spec for settlement sorting (copy-paste ready)
2. ✅ 5-phase implementation roadmap (40+ concrete steps)
3. ✅ 3+ docs with integration points
4. ✅ Everything on `fix/multi-sport-settlement` ready to go

**Next step:** Dev agent implements phases 1-5, runs tests, merges to main, ships to production.

---

**Ready to implement? 🚀** Hand this document to your dev agent with [IMPLEMENTATION_ROADMAP.md](docs/IMPLEMENTATION_ROADMAP.md) and they can execute the entire plan systematically.
