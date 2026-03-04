# Dual-Database Migration Guide

## Overview

The dual-database architecture separates **reference data** (shared, read-only) from **state data** (environment-specific, writable).

### Database Separation

**RECORD DATABASE** (`cheddar.db` in `/opt/cheddar-logic/packages/data/`)
- Read-only reference data
- Shared across dev and prod
- Contains:
  - `games` — game schedules
  - `odds_snapshots` — odds history
  - `card_payloads` — plays (models' recommendations)
  - `tracking_stats` — canonical analytics

**LOCAL DATABASE** (environment-specific)
- Writable state data
- Unique per environment (dev/prod/staging)
- Contains:
  - `card_results` — settlement records
  - `game_results` — final scores and settlement
  - `job_runs` — environment logs

---

## Why This Matters

**Before (Single DB):** Dev and prod had separate databases with different plays → dev showed UNDER, prod showed LEAN
**After (Dual DB):** Both read the same plays from record DB → identical plays in both environments

---

## Migration Steps

### Phase 1: Setup (Dev Testing)

#### 1.1 Verify Record Database Exists
```bash
ls -lh /opt/cheddar-logic/packages/data/cheddar.db
# If not present, copy from dev:
cp /Users/ajcolubiale/projects/cheddar-logic/packages/data/cheddar.db \
   /opt/cheddar-logic/packages/data/cheddar.db
mkdir -p /opt/cheddar-logic/packages/data
```

#### 1.2 Set Environment Variables (Dev)
```bash
# web/.env.local
DATABASE_PATH=/opt/cheddar-logic/packages/data/cheddar.db
RECORD_DATABASE_PATH=/opt/cheddar-logic/packages/data/cheddar.db
LOCAL_DATABASE_PATH=/tmp/cheddar-logic/dev-local.db
DUAL_DATABASE_MODE=true
```

#### 1.3 Test Dual-Mode Initialization
```bash
cd /Users/ajcolubiale/projects/cheddar-logic/web
node -e "
const { initDualDb, getDualDb } = require('@cheddar-logic/data');
(async () => {
  await initDualDb({
    recordDbPath: '/opt/cheddar-logic/packages/data/cheddar.db',
    localDbPath: '/tmp/test-local.db'
  });
  const db = getDualDb('auto');
  const games = db.prepare('SELECT COUNT(*) as count FROM games').all();
  console.log('✅ Dual-DB working. Games:', games[0].count);
})();
"
```

#### 1.4 Start Dev Server and Verify
```bash
cd web && npm run dev &
curl http://localhost:3000/api/games | jq '.data[0]' | head -20
# Verify plays are identical across restarts
sleep 5
curl http://localhost:3000/api/games | jq '.data[0]' | head -20
```

---

### Phase 2: Deployment (Prod)

#### 2.1 Backup Prod Database
```bash
ssh root@192.168.200.198
DATE=$(date +%Y%m%d_%H%M%S)
cp /opt/cheddar-logic/packages/data/cheddar.db \
   /opt/cheddar-logic/packages/data/cheddar.db.backup_${DATE}
```

#### 2.2 Ensure Record Database in Prod
```bash
# Already exists at /opt/cheddar-logic/packages/data/cheddar.db
ls -lh /opt/cheddar-logic/packages/data/cheddar.db
```

#### 2.3 Set Prod Environment Variables
```bash
# /opt/cheddar-logic/.env (or systemd service)
DATABASE_PATH=/opt/cheddar-logic/packages/data/cheddar.db
RECORD_DATABASE_PATH=/opt/cheddar-logic/packages/data/cheddar.db
LOCAL_DATABASE_PATH=/var/lib/cheddar/local.db
DUAL_DATABASE_MODE=true
```

#### 2.4 Verify Prod Works
```bash
# After deploying, check that plays are now canonical:
curl https://cheddar-logic.com/api/games | jq '.data[] | select(.awayTeam | contains("Pelicans")) | .plays[0]'
# Should match dev exactly
```

---

## Testing Checklist

### Manual Tests

- [ ] Dev and prod show **identical plays** for same game
- [ ] Dev can settle cards independently (local DB writes work)
- [ ] Prod can settle cards independently
- [ ] Both environments read from record DB (verify with `SELECT odds_captured_at FROM odds_snapshots`)
- [ ] Record DB is read-only (attempt INSERT fails with error)

### Automated Tests

```bash
# Run dual-database tests
cd packages/data
npm run test:dual-db

# Check database integrity
npm run db:verify -- --dual-mode
```

### Integration Test
```bash
# Specific game scenario
npm run test:db:play-determinism -- --game-id=<game_id> --runs=5
# Should show identical plays across 5 runs
```

---

## Troubleshooting

### Issue: "Cannot write to record database"
**Cause:** Query tried to INSERT/UPDATE/DELETE on record DB  
**Fix:** Check that `card_results` and `game_results` go to local DB. Review `RECORD_TABLES` in db-dual-init.js

### Issue: Plays not identical between dev and prod
**Cause:** Different seed data in databases  
**Check:**
```bash
sqlite3 /opt/cheddar-logic/packages/data/cheddar.db \
  "SELECT COUNT(*) FROM card_payloads WHERE card_type='nba-totals-call';"
sqlite3 /tmp/cheddar-logic/dev-local.db \
  "SELECT COUNT(*) FROM card_payloads WHERE card_type='nba-totals-call';"
# Should match
```

### Issue: Local database growing too fast
**Cause:** Settlement records not pruned  
**Fix:** Run cleanup job: `npm run db:delete-expired-cards -- --days-old=30`

---

## Cleanup After Verification

Once dual-mode is stable and tested in prod for 1 week:

### Remove Legacy Single-DB Code
- Delete `db-multi.js` (replaced by `db-dual-init.js`)
- Remove single-database initialization paths from web app
- Remove fallback to single DB mode

### Update Documentation
- Remove references to DATABASE_PATH pointing to writable DB
- Update all deployment docs to use dual-DB setup
- Archive single-DB migration scripts

### Simplify Codebase
```bash
# Verify no references to old single-DB mode
grep -r "chooseBestDatabasePath\|loadDatabase\|saveDatabase" --include="*.js" \
  apps/ web/src/ | grep -v db-dual-init
# Should return nothing
```

---

## Configuration Template

### Development (.env.local)
```
# Point to shared record database
RECORD_DATABASE_PATH=/opt/cheddar-logic/packages/data/cheddar.db

# Local state database (writable)
LOCAL_DATABASE_PATH=/tmp/cheddar-dev-local.db

# Enable dual-database mode
DUAL_DATABASE_MODE=true
```

### Production (.env)
```
# Shared record database (read-only reference)
RECORD_DATABASE_PATH=/opt/cheddar-logic/packages/data/cheddar.db

# Environment-specific state database
LOCAL_DATABASE_PATH=/var/lib/cheddar/local.db

# Enable dual-database mode
DUAL_DATABASE_MODE=true

# Read-only access to record DB (optional, for audit)
RECORD_DB_READONLY=true
```

### Staging (.env.staging)
```
# Same as production but with staging paths
RECORD_DATABASE_PATH=/opt/cheddar-staging/packages/data/cheddar.db
LOCAL_DATABASE_PATH=/var/lib/cheddar-staging/local.db
DUAL_DATABASE_MODE=true
```

---

## API Usage

### Previous (Single DB)
```javascript
const { initDb, getDatabase } = require('@cheddar-logic/data');
await initDb();
const db = getDatabase();
const games = db.prepare('SELECT * FROM games').all();
```

### New (Dual DB) - Recommended
```javascript
const { initDualDb, getDualDb } = require('@cheddar-logic/data');
await initDualDb({
  recordDbPath: process.env.RECORD_DATABASE_PATH,
  localDbPath: process.env.LOCAL_DATABASE_PATH
});

const db = getDualDb('auto'); // Auto-routes reads/writes
const games = db.prepare('SELECT * FROM games').all();     // Reads from record DB
const result = db.prepare('INSERT INTO card_results ...').run(...); // Writes to local DB
```

### Explicit Mode (Advanced)
```javascript
const recordDb = getDualDb('record'); // Explicitly read from record
const localDb = getDualDb('local');   // Explicitly write to local

const plays = recordDb.prepare('SELECT * FROM card_payloads').all();
localDb.prepare('INSERT INTO card_results ...').run(...);
```

---

## Validation Query

Verify both environments see the same data:

```sql
-- On record DB (should be identical everywhere)
SELECT game_id, COUNT(*) as play_count 
FROM card_payloads 
WHERE sport = 'NBA' AND card_type = 'nba-totals-call'
GROUP BY game_id
ORDER BY game_id;
```

Run this query on:
1. Dev's record DB
2. Prod's record DB  
3. Both should return identical results

---

## Monitoring

### Alert on Divergence
If you notice different plays in dev vs prod:
1. Check `RECORD_DATABASE_PATH` points to same file in both
2. Verify file modification times are same (`stat` command)
3. Query `SELECT MAX(created_at) FROM card_payloads` in both — should match
4. If one is newer, someone seeded it separately — copy to other environment

### Health Check
```bash
# Add to monitoring
curl http://localhost:3000/api/health/databases
# Should return:
# { record: { tables: 5, rows: 125000 }, local: { tables: 2, rows: 0 } }
```
