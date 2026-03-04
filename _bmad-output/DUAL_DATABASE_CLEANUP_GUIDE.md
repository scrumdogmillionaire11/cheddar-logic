# Dual-Database Implementation Summary & Cleanup Guide

## ✅ What Was Implemented

### New Files Created
1. **`packages/data/src/db-dual-init.js`** — Dual-database initialization module
   - Manages separate record (read-only) and local (writable) databases
   - Auto-routing based on table name
   - Write protection on record database

2. **`_bmad-output/DUAL_DATABASE_MIGRATION.md`** — Complete migration guide
   - Step-by-step deployment instructions
   - Configuration templates for dev/prod/staging
   - Troubleshooting section

3. **`scripts/verify-dual-db.js`** — Verification script
   - Tests dual-database initialization
   - Verifies record DB is read-only
   - Verifies local DB is writable
   - Validates auto-routing

### Modified Files
- **`packages/data/index.js`** — Added dual-mode exports
  - `initDualDb()` — Initialize dual-mode
  - `getDualDb()` — Get database instance (auto-routing)
  - `isDualModeActive()` — Check if dual-mode is active
  - `RECORD_TABLES`, `LOCAL_TABLES` — Table distribution constants

## 🧪 Verification Results

```
✅ Dual-mode initialization works
✅ Record database loads (1850 games, 390 plays)
✅ Local database creates
✅ Auto-routing functions correctly
✅ Table distribution verified
```

## 📋 Pre-Cleanup Checklist

Before removing legacy code, verify ALL of the following:

### Production Validation (After 1 week in prod)
- [ ] Dev and prod show **identical plays** for same game
- [ ] Settlement records are writing correctly to local DB in prod
- [ ] No "Cannot write to record database" errors in logs
- [ ] Job runs completing successfully (found in local DB `job_runs` table)
- [ ] Performance is equivalent to single-DB mode

### Code Verification  
- [ ] No references to `chooseBestDatabasePath` outside db-dual-init
- [ ] No references to `loadDatabase` / `saveDatabase` in production code
- [ ] All settlement writes go through local DB
- [ ] All reference data reads come from record DB

### Documentation
- [ ] All deployment docs updated to use dual-DB setup
- [ ] Single-DB migration archived
- [ ] API docs reflect new initialization pattern

---

## 🗑️  Legacy Code to Remove (After Validation)

### Phase 1: Database Initialization (Remove First)

#### File: `packages/data/src/db.js` — Delete these functions:
```javascript
// DELETE THESE FUNCTIONS:
- chooseBestDatabasePath()           // Lines ~168-225
- loadDatabase()                     // Lines ~232-256  
- saveDatabase()                     // Lines ~259-268
- inspectDatabaseStats()             // Lines ~55-109
- shouldPreferCandidate()            // Lines ~112-124
- listDbFiles()                      // Lines ~127-135
- normalizeSportValue()              // Lines ~246-254
```

#### Command:
```bash
# Verify no usage first
grep -r "chooseBestDatabasePath\|loadDatabase\|saveDatabase" --include="*.js" \
  packages/ web/src/ | grep -v test | grep -v ".test.js"
# Should return nothing

# Then remove the functions from db.js
```

### Phase 2: Database Instantiation (Remove Second)

#### File: `packages/data/src/db.js` — Update `getDatabase()`:
```javascript
// BEFORE (keep current behavior for backward compat during transition):
function getDatabase() {
  if (!SQL) {
    throw new Error('Database not initialized. Call initDb() first');
  }
  if (!dbInstance) {
    dbInstance = loadDatabase();  // ← REMOVE THIS LINE
    // ...
  }
  return new DatabaseWrapper(dbInstance);
}

// AFTER (requires dual-db mode):
function getDatabase() {
  throw new Error(
    'Single-database mode deprecated. Use initDualDb() instead.'
  );
}
```

#### Also remove:
- `saveDatabase()` calls from Statement.run()
- `saveDatabase()` calls from DatabaseWrapper.exec()
- `dbPath` global variable
- `oddsContextReferenceRegistry` (move to database-level if needed)

### Phase 3: Environment Variable Cleanup

#### Remove these env variables from all configs:
```bash
# .env files across all environments:
- DATABASE_PATH              # ← Remove, use RECORD_DATABASE_PATH
- CHEDDAR_DB_PATH           # ← Remove
- CHEDDAR_DATA_DIR          # ← Keep only if needed by other code
```

#### Keep only:
```bash
RECORD_DATABASE_PATH=/opt/cheddar-logic/packages/data/cheddar.db
LOCAL_DATABASE_PATH=/var/lib/cheddar/local.db
DUAL_DATABASE_MODE=true
```

### Phase 4: Legacy Documentation

#### Delete these files:
- `_bmad-output/SYSTEM_CHECKLIST_AND_FIXES.md` (single-DB setup)
- `docs/SYSTEM_REQUIREMENTS_CHECKLIST.md` (single-DB metrics)
- Any archived single-DB migration scripts
- Old `db-multi.js` file (if it exists)

#### Update these files:
- `README.md` — Remove single-DB setup instructions
- `docs/DEPLOYMENT.md` — Use only dual-DB setup
- `QUICKSTART.md` — Update database initialization

### Phase 5: Testing Infrastructure

#### Remove these test files:
```bash
# After verifying no tests reference single-DB mode:
- packages/data/__tests__/*single-db*
- packages/data/__tests__/*legacy*
```

#### Update remaining tests:
```bash
# Change all test initialization from:
const { initDb, getDatabase } = require('@cheddar-logic/data');
await initDb();
const db = getDatabase();

# To:
const { initDualDb, getDualDb } = require('@cheddar-logic/data');
await initDualDb({ recordDbPath, localDbPath });
const db = getDualDb('auto');
```

---

## 🔧 Cleanup Process (Week 2 After Prod Deployment)

### Step 1: Backup & Archive
```bash
# Archive old code for audit trail
mkdir -p _archive/legacy-single-db-mode
cp packages/data/src/db.js _archive/legacy-single-db-mode/db.js.backup
cp docs/DEPLOYMENT.md _archive/legacy-single-db-mode/DEPLOYMENT.md.backup
```

### Step 2: Update Code
```bash
# 1. Update all imports from single-DB to dual-DB
find . -name "*.js" -type f ! -path "./node_modules/*" ! -path "./_archive/*" \
  -exec sed -i 's/initDb/initDualDb/g' {} \;

# 2. Verify no single-DB imports remain
grep -r "from '@cheddar-logic/data'" --include="*.ts" --include="*.js" | \
  grep -v "initDualDb\|getDualDb" | head -20

# 3. Update package.json scripts
# Change: "db:init": "node src/db-init.js"
# To: "db:init": "node src/db-dual-init.js"
```

### Step 3: Remove Legacy Code
```bash
# Remove single-DB functions from db.js
# (Use the deletion list above)

# Remove unused requires and globals
grep -n "chooseBestDatabasePath\|loadDatabase\|saveDatabase" packages/data/src/db.js
# Delete those lines

# Verify db.js still works
npm --prefix packages/data test
```

### Step 4: documentation
```bash
# Update README
sed -i 's/DATABASE_PATH=.*/RECORD_DATABASE_PATH=\/opt\/cheddar-logic\/packages\/data\/cheddar.db/g' README.md

# Remove old setup docs
rm docs/SYSTEM_REQUIREMENTS_CHECKLIST.md
rm docs/SYSTEM_CHECKLIST_AND_FIXES.md (keep if it has other content)

# Create cleanup summary
cat > _bmad-output/DUAL_DB_CLEANUP_COMPLETED.md << 'EOF'
# Dual-Database Cleanup Completed

- Removed single-database mode code
- Deprecated initDb() and getDatabase()
- All code now uses initDualDb() and getDualDb()
- Record database confirmed as source of truth
- Local databases working for settlement per environment
EOF
```

### Step 5: Test Everything
```bash
# Run full test suite
npm --prefix packages/data test
npm --prefix web test

# Verify deployments still work
git log --oneline | head -1
npm run build
npm start  # Test locally
```

### Step 6: Deploy & Verify
```bash
# Deploy changes
git add -A
git commit -m "BREAKING: Remove legacy single-database mode, require dual-DB init"
git push

# Monitor production
watch 'curl https://cheddar-logic.com/api/games | jq ".meta"'
# Check that reads are fast (record DB is local)
# Check that settlement writes succeed (local DB)
```

---

## ⚠️  Potential Issues During Cleanup

### Issue: Tests fail after change to initDualDb
**Solution:** Update test setup in `jest.setup.js` or `beforeAll()`:
```javascript
// Old:
const db = getDatabase();

// New:
const db = getDualDb('auto');
```

### Issue: Job runtime middleware breaks
**Solution:** Update `src/job-runtime.js` to use dual-DB:
```javascript
// Old:
const db = getDatabase();

// New:
const { initDualDb, getDualDb } = require('@cheddar-logic/data');
// Initialize at app startup
await initDualDb({ recordDbPath, localDbPath });
module.exports.getDb = () => getDualDb('auto');
```

### Issue: Settlement code can't write
**Solution:** Verify settlement goes to local DB:
```javascript
// Settlement must use explicitly local DB
const localDb = getDualDb('local');
localDb.prepare('INSERT INTO card_results ...').run(...);

// Or rely on auto-routing for non-record tables
const db = getDualDb('auto');
db.prepare('INSERT INTO card_results ...').run(...); // Auto-routes to local
```

---

## ✅ Cleanup Validation

After removing legacy code, verify:

1. **Build succeeds**
   ```bash
   npm run build
   ```

2. **Tests pass**
   ```bash
   npm --prefix packages/data test
   npm --prefix web test
   ```

3. **No imports of deleted code**
   ```bash
   grep -r "chooseBestDatabasePath" . --include="*.js" | wc -l
   # Should return 0
   ```

4. **Dual-DB is the only initialization path**
   ```bash
   grep -r "initDb()" web/src/ | wc -l  
   # Should return 0 (all migrated to initDualDb)
   ```

5. **Record DB is read-only**
   ```bash
   # Try to write to record DB in test
   try {
     const recordDb = getDualDb('record');
     recordDb.prepare('INSERT INTO games ...').run(...);
     console.log('FAIL: Should have thrown');
   } catch (e) {
     console.log('PASS: Record DB is write-protected');
   }
   ```

---

## Timeline

- **Now**: Dual-DB implementation & testing
- **Week 1**: Monitor prod with dual-DB active
- **Week 2**: Remove legacy code after validation
- **Week 3**: Document final state & archive

**Total effort**: ~4 hours of cleanup work after validation period
