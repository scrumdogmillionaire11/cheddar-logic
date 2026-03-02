# Safe Database Migration: Dev → Prod

This directory contains two complementary scripts for safely migrating the development database to production **without guessing paths, without hardcoded assumptions, and with full safety backups.**

---

## Scripts

### 1. **`discover-prod-setup.sh`** — Discovery Only (Read-Safe)

**Purpose:** Show you exactly what the migration will work with before making any changes.

```bash
./scripts/discover-prod-setup.sh user@prod-server
```

**What it does:**
- Finds the actual cheddar-logic repo root on prod
- Locates the actual DB file (no hardcoded `/opt/cheddar-logic` assumptions)
- Shows current DB state (tables, row counts)
- Checks what service managers exist (systemd/pm2/docker)
- Reports everything in a human-readable format

**When to run:** Before the actual migration, to confirm the script will find the right paths.

**Safety:** 100% read-only. No changes to prod.

---

### 2. **`migrate-dev-to-prod-safe.sh`** — Full Migration (Safe + Atomic)

**Purpose:** Execute a bulletproof migration from dev DB to prod DB.

```bash
./scripts/migrate-dev-to-prod-safe.sh user@prod-server
```

**What it does:**

1. **Discovers** the actual repo + DB path (same as discover script)
2. **Stops all writers** (systemd/pm2/docker) so no one corrupts the DB during copy
3. **Backs up** the existing prod DB with a timestamp (can restore if anything fails)
4. **Copies atomically:**
   - Dev DB → temp file on prod (`/tmp/cheddar.db.incoming`)
   - Then moves to final location (avoids half-copies if copy fails mid-stream)
5. **Verifies integrity** with `PRAGMA integrity_check` (stops if corrupt)
6. **Restarts services** (whatever was stopped in step 2)
7. **Runs settlement pipeline rebuild** (backfill → settle-games → settle-cards)

**When to run:** Once you've confirmed via discovery that the paths are correct.

**Safety:**
- ✓ Stops writers before touching the DB
- ✓ Backs up prod DB before copy (can restore in seconds if needed)
- ✓ Atomic copy (temp → move, no half-copies)
- ✓ Integrity check before restart
- ✓ Can restore from backup if verification fails
- ✓ Colorized output so you see every step

---

## Recommended Workflow

### Step 1: Run Discovery

```bash
./scripts/discover-prod-setup.sh ubuntu@prod.example.com
```

Example output:
```
✓ Repo root: /var/lib/cheddar-logic
✓ DB path: /var/lib/cheddar-logic/packages/data/cheddar.db
  Table count: 23
  Sample row counts:
    - games: 1247
    - cards: 8946
    - card_results: 8934
    - settlements: 234

systemctl: ✓ available
  (cheddar units found)
pm2: ✗ not available
docker: ✗ not available
```

This tells you:
- The repo is at `/var/lib/cheddar-logic` (not `/opt/cheddar-logic`)
- The DB is at `/var/lib/cheddar-logic/packages/data/cheddar.db`
- Current prod DB has ~8k cards and ~2k games
- systemd is the service manager

### Step 2: Verify Paths Look Right

If the discovery output matches your expectations, proceed.

If it looks wrong (e.g., repo path is weird, no DB found, etc.), investigate before running the migration.

### Step 3: Run Migration

```bash
./scripts/migrate-dev-to-prod-safe.sh ubuntu@prod.example.com
```

Watch the output. It will:
- Stop services ✓
- Back up prod DB ✓
- Copy dev → prod ✓
- Verify integrity ✓
- Restart services ✓
- Run settlement rebuild ✓

Then tell you exactly where the backup is, in case you need to restore.

### Step 4: Test

Once done, SSH into prod and test:
```bash
# Check the app works
curl http://localhost:3000/api/games | head

# Check settlement tables were populated
sqlite3 /path/to/cheddar.db "SELECT COUNT(*) FROM settlements;"

# Check logs for errors during rebuild
journalctl -u cheddar-logic -n 50  # if systemd
# or
pm2 logs cheddar-logic              # if pm2
```

---

## If Something Goes Wrong

### "DB integrity check failed"

The script will **automatically** show you the restore command. Example:

```
If integrity check failed, restore from backup:
  ssh ubuntu@prod.example.com
  TS=$(ls /path/to/cheddar.db.bak.* | tail -1 | sed 's/.*bak.//g')
  sudo cp /path/to/cheddar.db.bak.$TS /path/to/cheddar.db
```

### "Services didn't restart"

Check manually:
```bash
ssh user@prod-server
systemctl status cheddar-logic       # if systemd
# or
pm2 ls                               # if pm2
# or
docker compose ps                    # if docker
```

### "Settlement rebuild didn't run"

It's optional. The DB is already in place. You can run jobs manually:
```bash
ssh user@prod-server
cd /path/to/cheddar-logic
npm run job:backfill-card-results
npm run job:settle-games
npm run job:settle-cards
```

---

## What Happens to Dev DB?

Nothing. Dev DB stays where it is (`/Users/ajcolubiale/projects/cheddar-logic/packages/data/cheddar.db`). Only a copy is sent to prod.

---

## What if the Prod DB Already Has Data?

That's fine. The script:
1. **Backs it up first** (with a timestamp, so you can keep multiple backups)
2. **Then replaces it with dev DB**

You'll see something like:
```
✓ Backup complete
  Backed up to: /path/to/cheddar.db.bak.20260302_145723
```

If prod data is important, make sure you have that backup path written down. But since you're trying to start fresh from dev, this is the point.

---

## Questions?

- **"How do I know it's safe?"** Because it stops writers, backs up before touching anything, verifies integrity, and can restore in seconds if needed.
- **"What if SSH fails?"** The script will error early. Fix the SSH connection and try again.
- **"Can I run this while the app is live?"** The script stops services first, so it's safe. Services are restarted after. But plan a short maintenance window to be safe.

---

## TL;DR

```bash
# 1. Check what you're about to migrate
./scripts/discover-prod-setup.sh user@prod-server

# 2. Do it
./scripts/migrate-dev-to-prod-safe.sh user@prod-server

# 3. Profit
```

Done. DB is migrated, services restarted, settlement jobs ran. No guessing, no halfway states.
