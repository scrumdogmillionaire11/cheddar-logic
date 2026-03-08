# Cheddar Logic — Operations Runbook

> Lessons from production operations. Keep this updated as new issues are discovered.

---

## Infrastructure Overview

| Component | Location | Runs As |
| --- | --- | --- |
| Next.js web app | `/opt/cheddar-logic/web/` | `cheddar-web` (systemd) |
| Worker/scheduler | `/opt/cheddar-logic/apps/worker/` | `cheddar-worker` (systemd) |
| SQLite database | `CHEDDAR_DB_PATH` from `/opt/cheddar-logic/.env.production` | read-only by `cheddar-web`, write-only by `cheddar-worker` (ADR-0002) |
| FPL Sage (FastAPI) | Pi — separate service | `cheddar-fpl-sage` (systemd) |

**SSH to Pi:**

```bash
ssh babycheeses11@192.168.200.198   # local network
# or via Tailscale IP:
ssh babycheeses11@100.71.1.87
```

---

## Database Path Contract

**Canonical Production DB Path:** `/opt/data/cheddar-prod.db`

**Identification:** The production database is identified by the presence of the `card_payloads` table with data. This is the file that contains historical card decisions and must be preserved across deployments.

**Path Configuration:**

- **Recommended:** Set explicit `CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db` in `/opt/cheddar-logic/.env.production`
- **Fallback:** `CHEDDAR_DATA_DIR=/opt/data` enables auto-discovery (scans for databases with `card_payloads`, prefers `-prod` in filename)
- **Explicit path is strongly preferred** to prevent ambiguity and drift

**Legacy Variables (Must Remove in Production):**

- `DATABASE_PATH` (oldest legacy variable)
- `RECORD_DATABASE_PATH` (mid-era variable)
- `DATABASE_URL` (SQLite URL format, no longer supported)

Setting multiple path variables causes `DB_PATH_CONFLICT` error. These are actively unset by `scripts/start-scheduler.sh` and removed by `scripts/consolidate-record-db.sh`.

**Single-Writer Contract (ADR-0002):**

- **Worker** is the sole DB writer (INSERT/UPDATE/DELETE, migrations, snapshots)
- **Web server** is strictly read-only (SELECT/PRAGMA only, uses `closeDatabaseReadOnly()`)
- See [docs/decisions/ADR-0002-single-writer-db-contract.md](decisions/ADR-0002-single-writer-db-contract.md) for rationale

**Validation Commands:**

```bash
# Verify production DB contains card_payloads table
sqlite3 /opt/data/cheddar-prod.db "SELECT name FROM sqlite_master WHERE type='table' AND name='card_payloads';"

# Check services are using canonical path
sudo systemctl show cheddar-web -p Environment | grep CHEDDAR_DB_PATH
sudo systemctl show cheddar-worker -p Environment | grep CHEDDAR_DB_PATH

# Detect DB path drift (expected vs actual)
./scripts/manage-scheduler.sh db
```

---

## Service Management

### Check status of all services

```bash
sudo systemctl status cheddar-web cheddar-worker cheddar-fpl-sage
```

### Start / Stop / Restart

```bash
sudo systemctl restart cheddar-web
sudo systemctl restart cheddar-worker
sudo systemctl restart cheddar-fpl-sage

sudo systemctl stop cheddar-web
sudo systemctl start cheddar-web
```

### View live logs

```bash
sudo journalctl -u cheddar-web -f
sudo journalctl -u cheddar-worker -f
sudo journalctl -u cheddar-fpl-sage -f
```

### View last N log lines

```bash
sudo journalctl -u cheddar-web -n 50 --no-pager
sudo journalctl -u cheddar-worker -n 50 --no-pager
```

---

## Post-deploy verification (Pi)

Deploy workflow also logs API warnings to `/opt/cheddar-logic/logs/deploy.log` after restart.
API checks are warning-only (they do not block deploy completion).
Each deploy writes a compact `[deploy-summary]` log line for quick triage.

```bash
# Load canonical DB path from prod env
set -a; source /opt/cheddar-logic/.env.production; set +a

# Services are up
sudo systemctl status cheddar-web cheddar-worker

# Env points to the correct DB
sudo systemctl show cheddar-web -p Environment | grep CHEDDAR_DB_PATH
sudo systemctl show cheddar-worker -p Environment | grep CHEDDAR_DB_PATH

# Schema exists
sqlite3 "$CHEDDAR_DB_PATH" ".tables"

# Data present
sqlite3 "$CHEDDAR_DB_PATH" "SELECT COUNT(*) AS cards FROM card_payloads;"

# Validate production DB identity (card_payloads table must exist)
sqlite3 "$CHEDDAR_DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name='card_payloads';" | grep -qx card_payloads && echo "✅ Production DB validated" || echo "❌ card_payloads missing"

# API returns games
curl -s http://localhost:3000/api/games?limit=1 | head -20
```

### Go/no-go checklist (3 commands)

These three checks cover the critical production contract: DB path, schema integrity, and API health.

```bash
# 1. DB Path Check — worker uses canonical production DB
sudo systemctl show cheddar-worker -p Environment | grep -q "CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db" && echo "✅ DB path correct" || echo "❌ DB path mismatch"

# 2. Schema Check — production DB contains card_payloads table
sqlite3 /opt/data/cheddar-prod.db "SELECT name FROM sqlite_master WHERE type='table' AND name='card_payloads';" | grep -qx card_payloads && echo "✅ Schema valid" || echo "❌ card_payloads missing"

# 3. API Health Check — web server responds with cards
curl -sf http://localhost:3000/api/cards?limit=1 >/dev/null && echo "✅ API responding" || echo "❌ API down or empty"
```

**One-liner version:**

```bash
sudo systemctl show cheddar-worker -p Environment | grep -q "CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db" && sqlite3 /opt/data/cheddar-prod.db "SELECT name FROM sqlite_master WHERE type='table' AND name='card_payloads';" | grep -qx card_payloads && curl -sf http://localhost:3000/api/cards?limit=1 >/dev/null && echo "✅ All checks passed" || echo "❌ Preflight failed"
```

### DB path drop-in precedence (critical)

`CHEDDAR_DB_PATH` for both services must come from exactly one drop-in per unit:

- `/etc/systemd/system/cheddar-web.service.d/10-record-db.conf`
- `/etc/systemd/system/cheddar-worker.service.d/10-record-db.conf`

Remove legacy `10-db-env.conf` drop-ins if present to prevent drift/overrides:

```bash
sudo rm -f /etc/systemd/system/cheddar-web.service.d/10-db-env.conf
sudo rm -f /etc/systemd/system/cheddar-worker.service.d/10-db-env.conf
sudo systemctl daemon-reload
sudo systemctl restart cheddar-web cheddar-worker
```

Expected value for both services:

```bash
sudo systemctl show cheddar-web -p Environment | grep CHEDDAR_DB_PATH
sudo systemctl show cheddar-worker -p Environment | grep CHEDDAR_DB_PATH
# CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db
```

If `cards = 0`, run the seed step from the "Worker shows no such table" section and re-check.

---

## Common Issues & Fixes

### Web service fails with `status=217/USER`

**Cause:** Service file references a user that doesn't exist. All services run as `babycheeses11`.

```bash
# Verify service files have User=babycheeses11 (not cheddar-worker)
grep User /etc/systemd/system/cheddar-*.service
```

### Web service fails with `status=1/FAILURE` — "no production build"

**Cause:** `.next` build directory missing or wrong ownership.

```bash
# Rebuild (run as babycheeses11, NOT as cheddar-worker)
cd /opt/cheddar-logic
env $(cat /opt/cheddar-logic/.env.production | grep -v '^#' | xargs) npm --prefix web run build

# Fix ownership so cheddar-worker can read the build
sudo chown -R cheddar-worker:cheddar-worker /opt/cheddar-logic/web/.next
sudo systemctl restart cheddar-web
```

> **Note:** Always run `chown` on `.next` after rebuilding, because the build runs as `babycheeses11` but the service runs as `cheddar-worker`.

### Results page shows "Unexpected end of JSON input" / all N/A values

**Cause:** `cheddar-web` is running but has no Next.js build. This happens when a deploy ran `rm -rf web/.next` and then the build failed or was interrupted — leaving the Pi with no production bundle. Next.js starts but returns an empty or HTML error body for API routes instead of JSON, which the client fails to parse.

**Diagnosis:**

```bash
# On Pi — check if build exists
ls /opt/cheddar-logic/web/.next/

# Check service status and recent crash logs
sudo systemctl status cheddar-web
sudo journalctl -u cheddar-web -n 50 --no-pager
```

**Fix:** Rebuild manually:

```bash
cd /opt/cheddar-logic
git pull
npm --prefix web install
env $(cat /opt/cheddar-logic/.env.production | grep -v '^#' | xargs) npm --prefix web run build
sudo chown -R cheddar-worker:cheddar-worker /opt/cheddar-logic/web/.next
sudo systemctl restart cheddar-web
```

### Play Ledger shows `--` for Price and/or Confidence in production

**Cause:** Production is running a stale Next.js build. The web app is a pre-compiled bundle — code changes don't take effect until you rebuild and restart.

Symptoms that confirm this:

- Price column shows `--` even though dev shows real odds values
- Column names don't match current code (e.g. old `Edge` label instead of `Confidence`)
- Matchup column missing from the Play Ledger
- Filter controls show old static chips (Sport / Market / Tier / Edge Band / Odds Band) instead of live selects

**Fix:** Rebuild and restart the web service (same as above — see "no production build" fix).

**Data caveat:** Cards generated before `odds_context` was added to card payloads (pre quick-19, ~2026-03-01) will still show `--` for Price even after deploying — the data was never stored. Only cards generated after that date will have real price values.

To check if a card has `odds_context` data:

```bash
set -a; source /opt/cheddar-logic/.env.production; set +a
sqlite3 "$CHEDDAR_DB_PATH" "
  SELECT id, json_extract(payload_data, '$.odds_context') IS NOT NULL AS has_odds
  FROM card_payloads
  ORDER BY created_at DESC
  LIMIT 10;
"
```

### All API routes return 500 in production

**Cause:** All three APIs (`/api/games`, `/api/results`, `/api/auth/refresh`) failing simultaneously means DB initialization is failing, not route-specific logic. Two likely causes:

**1. No `.next` build** — routes return 500 before reaching any code. Check:

```bash
ls /opt/cheddar-logic/web/.next/
sudo journalctl -u cheddar-web -n 30 --no-pager
```

Fix: see "no production build" section above.

**2. `CHEDDAR_DB_PATH` wrong or not set → empty DB** — The data layer uses `CHEDDAR_DB_PATH` (not `DATABASE_URL` or legacy vars). If the path is wrong or missing, the DB layer loads an empty in-memory DB and you see "no such table" errors on every query.

Telltale log pattern:

```text
Error: no such table: card_results
```

The DB must live at the canonical path (the file that already contains `card_payloads`), and both services must set `CHEDDAR_DB_PATH` to that exact file.

**Detect DB path drift:**

The `manage-scheduler.sh` script compares expected DB path from env vars against the actual DB file the scheduler is using (via `lsof` or job_runs inference):

```bash
./scripts/manage-scheduler.sh db
```

Example output showing drift:

```plaintext
Expected DB: /opt/data/cheddar-prod.db
Scheduler DB: /tmp/cheddar.db
⚠️  Scheduler DB path differs from CHEDDAR_DB_PATH
```

**Check environment configuration:**

```bash
# Verify env var is being injected
sudo systemctl show cheddar-web -p Environment | grep CHEDDAR_DB_PATH
sudo systemctl show cheddar-worker -p Environment | grep CHEDDAR_DB_PATH
sudo -u babycheeses11 cat /opt/cheddar-logic/.env.production | grep CHEDDAR_DB_PATH
```

Fix: update `CHEDDAR_DB_PATH` in `/opt/cheddar-logic/.env.production` to the canonical DB file (contains `card_payloads`), then restart.

Then reload:

```bash
sudo systemctl daemon-reload
sudo systemctl restart cheddar-web cheddar-worker
```

After fixing, verify locally on the Pi:

```bash
curl -s http://localhost:3000/api/results | python3 -c "
import sys,json; d=json.load(sys.stdin); s=d['data']['summary']
print(f'settled: {s[\"settledCards\"]}, wins: {s[\"wins\"]}')
"
```

### Worker shows "no such table: games" or API returns empty `data: []`

**Cause:** Migrations ran against a different SQLite file than the worker is using. The worker reads `CHEDDAR_DB_PATH` only.

**Fix:** Point both services to the same canonical file, migrate it, then restart:

```bash
sudo nano /opt/cheddar-logic/.env.production
sudo systemctl daemon-reload
set -a; source /opt/cheddar-logic/.env.production; set +a; npm --prefix /opt/cheddar-logic/packages/data run migrate
sudo systemctl restart cheddar-web cheddar-worker
```

**Verify tables:**

```bash
set -a; source /opt/cheddar-logic/.env.production; set +a; sqlite3 "$CHEDDAR_DB_PATH" ".tables"
```

If tables exist but the UI still shows no cards, seed cards:

```bash
set -a; source /opt/cheddar-logic/.env.production; set +a; npm --prefix /opt/cheddar-logic/packages/data run seed:cards
```

---

### Web app returns 502 Bad Gateway

**Cause:** Usually one of these:

- `cheddar-web` is down/restarting and Cloudflare returns upstream 502
- Static build artifacts are missing/incomplete under `web/.next`
- Home page references chunk paths that the running origin cannot serve

**Fast diagnosis (run on Pi):**

```bash
# 1) Service health
sudo systemctl status cheddar-web --no-pager
sudo journalctl -u cheddar-web -n 80 --no-pager

# 2) Build artifacts exist
test -f /opt/cheddar-logic/web/.next/BUILD_ID && echo "BUILD_ID OK" || echo "BUILD_ID MISSING"
find /opt/cheddar-logic/web/.next/static/chunks -name "*.js" | head -5

# 3) Origin serves chunk files
SAMPLE=$(find /opt/cheddar-logic/web/.next/static/chunks -name "*.js" | sort | head -n1)
REL=${SAMPLE#/opt/cheddar-logic/web/.next/static/chunks/}
curl -I "http://127.0.0.1:3000/_next/static/chunks/$REL"

# 4) Home page references a chunk that is actually reachable on origin
REF=$(curl -s http://127.0.0.1:3000/ | grep -Eo '/_next/static/chunks/[^" ]+\.js' | head -n1)
echo "$REF"
curl -I "http://127.0.0.1:3000$REF"

# 5) CSS asset exists and is reachable on origin
CSS_REF=$(curl -s http://127.0.0.1:3000/ | grep -Eo '/_next/static/[^" ]+\.css' | head -n1)
echo "$CSS_REF"
curl -I "http://127.0.0.1:3000$CSS_REF"
```

If origin is `200` but public URL is `502`, purge Cloudflare cache and check edge/proxy path:

```bash
# Manual Cloudflare cache purge (matches deploy workflow behavior)
curl -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"purge_everything":true}'

# Wait 30s for propagation, then test
sleep 30
curl -I "https://cheddarlogic.com$REF"
curl -I "https://cheddarlogic.com$CSS_REF"
sudo tail -n 100 /var/log/nginx/error.log
sudo tail -n 100 /var/log/nginx/access.log
```

**Recovery:**

```bash
cd /opt/cheddar-logic
git fetch origin main && git reset --hard origin/main
npm --prefix web install --include=dev
set -a; source /opt/cheddar-logic/.env.production; set +a
npm --prefix web run build
sudo systemctl restart cheddar-web
sleep 5
curl -I http://127.0.0.1:3000/
```

If the chunk still fails on origin after rebuild, do not proceed with traffic changes — inspect latest `cheddar-web` journal errors first.

---

### Vercel + Cloudflare: Static chunk 404s (CSS/JS missing)

**Symptoms:** Console shows `/_next/static/chunks/*.js` 404s, CSS not loading, or hydration failures after a successful deploy.

**Diagnosis (public domain):**

```bash
# 1) Inspect HTML cache headers
curl -I https://cheddarlogic.com/ | grep -iE 'cache-control|cf-cache-status|x-vercel-cache'

# 2) Extract a referenced chunk/CSS from the homepage HTML
HOMEPAGE=$(curl -fsS https://cheddarlogic.com/)
REF=$(printf "%s" "$HOMEPAGE" | grep -Eo '/_next/static/[^" ]+\.(js|css)' | head -n 1)
echo "$REF"

# 3) Verify the referenced asset is reachable
curl -I "https://cheddarlogic.com$REF" | grep -iE 'http/|cache-control|cf-cache-status|x-vercel-cache'
```

**Interpretation:**

- `cf-cache-status: HIT` with a 404 suggests stale Cloudflare cache — purge and re-check.
- `x-vercel-cache: MISS` with a 404 suggests the Vercel origin is missing the chunk — trigger a redeploy and verify the build output.

**Recovery:**

1. Purge Cloudflare cache (full purge).
2. Re-deploy on Vercel (clean build) if the origin still returns 404 for the referenced chunk.
3. Re-run the diagnosis steps to confirm `200` responses and expected cache headers.

---

## Database Operations

### DB location

```text
Production:  CHEDDAR_DB_PATH in /opt/cheddar-logic/.env.production
Local dev:   /tmp/cheddar-logic/cheddar.db (recommended)
```

> **Note:** If you need a persistent local DB, set `CHEDDAR_DB_PATH` to a stable path in your `.env`.

### Check DB health (run on Pi)

```bash
set -a; source /opt/cheddar-logic/.env.production; set +a
sqlite3 "$CHEDDAR_DB_PATH" "SELECT status, COUNT(*) FROM card_results GROUP BY status;"
sqlite3 "$CHEDDAR_DB_PATH" "SELECT status, COUNT(*) FROM game_results GROUP BY status;"
```

### FPL Sage Database Corruption Recovery

The FPL Sage service uses a **separate SQLite database** from the main Cheddar Logic DB. If corruption is detected, the worker job will fail with a detailed error message.

**Symptoms:**

- Worker logs show: `❌ FATAL: FPL Sage DB corrupted at /opt/data/fpl_snapshots.sqlite`
- FPL model job fails repeatedly on every scheduler tick
- Error mentions "database disk image is malformed" or PRAGMA integrity_check failure

**Recovery procedure:**

```bash
# 1. Stop the scheduler to prevent repeated errors
sudo systemctl stop cheddar-worker

# 2. Back up the corrupt database with timestamp
cp "$CHEDDAR_FPL_DB_PATH" "$CHEDDAR_FPL_DB_PATH.corrupt.$(date +%Y%m%d-%H%M%S)"

# 3. Run integrity check to confirm corruption
sqlite3 "$CHEDDAR_FPL_DB_PATH" "PRAGMA integrity_check;"
# If output is NOT "ok", database is corrupt

# 4. Choose recovery option:

# Option A: Restore from backup (if available)
LATEST_BACKUP=$(ls -t /opt/data/backups/fpl_snapshots-*.db 2>/dev/null | head -1)
if [ -n "$LATEST_BACKUP" ]; then
  cp "$LATEST_BACKUP" "$CHEDDAR_FPL_DB_PATH"
  echo "Restored from: $LATEST_BACKUP"
fi

# Option B: Re-collect fresh FPL data (if no backup or backup also corrupt)
cd /opt/cheddar-logic/cheddar-fpl-sage
rm -f "$CHEDDAR_FPL_DB_PATH"  # Remove corrupt DB
python scripts/data_pipeline_cli.py run-full --season 2025-26 --gw 29
# This re-initializes the DB and collects current gameweek data

# 5. Verify new DB is healthy
sqlite3 "$CHEDDAR_FPL_DB_PATH" "PRAGMA integrity_check;"
# Should output: ok

# 6. Restart the scheduler
sudo systemctl start cheddar-worker
sudo systemctl status cheddar-worker
```

**Prevention:**

- Set up automatic backups of FPL Sage DB (similar to main DB cron job)
- Monitor disk space on `/opt/data` partition
- Review worker logs regularly for I/O errors or power loss events

**Environment variable:**

```bash
# In /opt/cheddar-logic/.env.production
CHEDDAR_FPL_DB_PATH=/opt/data/fpl_snapshots.sqlite
```

### Backups

Daily backups run automatically at 3am ET via cron (set up once on Pi):

```bash
set -a; source /opt/cheddar-logic/.env.production; set +a
BACKUP_DIR="$(dirname "$CHEDDAR_DB_PATH")/backups"
mkdir -p "$BACKUP_DIR"
(crontab -l 2>/dev/null; echo "0 3 * * * cp $CHEDDAR_DB_PATH $BACKUP_DIR/cheddar-$(date +\%Y\%m\%d).db && find $BACKUP_DIR -name 'cheddar-*.db' -mtime +7 -delete") | crontab -
```

Backups live in the `backups/` folder next to the canonical DB. To restore:

```bash
set -a; source /opt/cheddar-logic/.env.production; set +a
cp "$(dirname "$CHEDDAR_DB_PATH")/backups/cheddar-20260301.db" "$CHEDDAR_DB_PATH"
sudo systemctl restart cheddar-web cheddar-worker
```

### Migrate local DB to production

> **WARNING: This overwrites the entire production database.** Always back up first.

```bash
# 1. Back up prod DB first (on Pi)
ssh babycheeses11@192.168.200.198 "set -a; source /opt/cheddar-logic/.env.production; set +a; cp \"$CHEDDAR_DB_PATH\" \"$CHEDDAR_DB_PATH\".bak-$(date +%Y%m%d)"

# 2. Copy local DB to Pi (from Mac)
CANONICAL_PROD_DB_PATH=$(ssh babycheeses11@192.168.200.198 "grep -E '^CHEDDAR_DB_PATH=' /opt/cheddar-logic/.env.production | cut -d= -f2-")
scp /tmp/cheddar-logic/cheddar.db "babycheeses11@192.168.200.198:$CANONICAL_PROD_DB_PATH"

# 3. Restart services
ssh babycheeses11@192.168.200.198 "sudo systemctl restart cheddar-web cheddar-worker"
```

---

## Settlement

Settlement runs automatically via the worker scheduler:

- **Hourly sweep**: runs once per hour (during first 5 minutes by default)
- **Nightly sweep**: runs at **02:00 ET** (includes backfill)

**Why games may not be settled:**

- Hourly sweep window was disabled (`ENABLE_HOURLY_SETTLEMENT_SWEEP=false`)
- Games were not final yet at the time of a sweep
- A specific hourly/nightly `jobKey` already succeeded, so the same window is skipped

### Manually run settlement (bypasses idempotency)

```bash
# On Pi
cd /opt/cheddar-logic/apps/worker
set -a; source /opt/cheddar-logic/.env.production; set +a
node -e "
const { settleGameResults } = require('./src/jobs/settle_game_results');
settleGameResults({ jobKey: null, dryRun: false, minHoursAfterStart: 3 })
  .then(r => console.log(JSON.stringify(r, null, 2)));
"
node -e "
const { settlePendingCards } = require('./src/jobs/settle_pending_cards');
settlePendingCards({ jobKey: null, dryRun: false })
  .then(r => console.log(JSON.stringify(r, null, 2)));
"
```

### Verify settlement results

```bash
curl -s https://cheddarlogic.com/api/results | python3 -c "
import sys,json; d=json.load(sys.stdin); s=d['data']['summary']
print(f'settled: {s[\"settledCards\"]}, wins: {s[\"wins\"]}, losses: {s[\"losses\"]}, pnl: {round(s[\"totalPnlUnits\"],2)}')
"
```

---

## Deploy

Deploys are triggered automatically via GitHub Actions on push to `main`.

### Manual rebuild + restart (if deploy didn't work)

```bash
# On Pi
cd /opt/cheddar-logic
git pull
npm --prefix web install
env $(cat /opt/cheddar-logic/.env.production | grep -v '^#' | xargs) npm --prefix web run build
sudo chown -R cheddar-worker:cheddar-worker /opt/cheddar-logic/web/.next
sudo systemctl restart cheddar-web cheddar-worker
```

---

## Environment Files

| File | Purpose |
| --- | --- |
| `/opt/cheddar-logic/.env.production` | Production secrets on Pi |
| `~/.env` | Local dev secrets (Mac) |
| `.env.production.example` | Template for Pi env setup |

> **Never commit `.env` or `.env.production`** — they contain API keys and auth secrets.
