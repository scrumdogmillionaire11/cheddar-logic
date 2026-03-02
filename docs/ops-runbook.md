# Cheddar Logic — Operations Runbook

> Lessons from production operations. Keep this updated as new issues are discovered.

---

## Infrastructure Overview

| Component | Location | Runs As |
| --- | --- | --- |
| Next.js web app | `/opt/cheddar-logic/web/` | `cheddar-worker` (systemd) |
| Worker/scheduler | `/opt/cheddar-logic/apps/worker/` | `cheddar-worker` (systemd) |
| SQLite database | `/opt/data/cheddar.db` | read/write by `cheddar-worker` |
| FPL Sage (FastAPI) | Pi — separate service | `cheddar-worker` (systemd) |

**SSH to Pi:**

```bash
ssh babycheeses11@192.168.200.198   # local network
# or via Tailscale IP:
ssh babycheeses11@100.82.80.89
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
sqlite3 /opt/data/cheddar.db "
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

**2. `DATABASE_PATH` wrong or not set → empty DB** — The service has `ProtectSystem=strict` (filesystem is read-only except `/opt/data`) and `PrivateTmp=true` (isolated `/tmp`). If `DATABASE_PATH` is wrong or missing, two things happen: the DB layer loads from an empty path, AND any attempt to save fails with `EROFS: read-only file system`. The result is an empty in-memory DB and "no such table" errors on every query.

Telltale log pattern:

```text
EROFS: read-only file system, open '/opt/cheddar-logic/packages/data/cheddar.db'
Error: no such table: card_results
```

The DB must live at `/opt/data/cheddar.db` — that's the only path in `ReadWritePaths`.

Check:

```bash
# Verify env var is being injected
sudo systemctl show cheddar-web -p Environment
sudo -u babycheeses11 cat /opt/cheddar-logic/.env.production | grep DATABASE_PATH
```

Fix: the correct value is `DATABASE_PATH=/opt/data/cheddar.db`. Update and restart:

```bash
sed -i 's|DATABASE_PATH=.*|DATABASE_PATH=/opt/data/cheddar.db|' /opt/cheddar-logic/.env.production
```

Then reload:

```bash
sudo systemctl daemon-reload
sudo systemctl restart cheddar-web
```

After fixing, verify locally on the Pi:

```bash
curl -s http://localhost:3000/api/results | python3 -c "
import sys,json; d=json.load(sys.stdin); s=d['data']['summary']
print(f'settled: {s[\"settledCards\"]}, wins: {s[\"wins\"]}')
"
```

---

### Web app returns 502 Bad Gateway

**Cause:** Cloudflare can't reach the Pi — either the service is down or still starting.

1. Check service status: `sudo systemctl status cheddar-web`
2. If `activating (auto-restart)` — check journal for crash reason
3. If `active (running)` — give it 15–30 seconds to fully initialize, then retry

---

## Database Operations

### DB location

```text
Production:  /opt/data/cheddar.db
Local dev:   /Users/ajcolubiale/projects/cheddar-logic/data/cheddar.db
```

> **Warning:** The local DB was previously stored in `/tmp/cheddar-logic/cheddar.db` which is wiped on reboot. It's now fixed to `data/cheddar.db` in the project root.

### Check DB health (run on Pi)

```bash
sqlite3 /opt/data/cheddar.db "SELECT status, COUNT(*) FROM card_results GROUP BY status;"
sqlite3 /opt/data/cheddar.db "SELECT status, COUNT(*) FROM game_results GROUP BY status;"
```

### Backups

Daily backups run automatically at 3am ET via cron (set up once on Pi):

```bash
mkdir -p /opt/data/backups
(crontab -l 2>/dev/null; echo "0 3 * * * cp /opt/data/cheddar.db /opt/data/backups/cheddar-\$(date +\%Y\%m\%d).db && find /opt/data/backups -name 'cheddar-*.db' -mtime +7 -delete") | crontab -
```

Backups live at `/opt/data/backups/cheddar-YYYYMMDD.db`. To restore:

```bash
cp /opt/data/backups/cheddar-20260301.db /opt/data/cheddar.db
sudo systemctl restart cheddar-web cheddar-worker
```

### Migrate local DB to production

> **WARNING: This overwrites the entire production database.** Always back up first.

```bash
# 1. Back up prod DB first (on Pi)
ssh babycheeses11@192.168.200.198 "cp /opt/data/cheddar.db /opt/data/cheddar.db.bak-$(date +%Y%m%d)"

# 2. Copy local DB to Pi (from Mac)
scp /Users/ajcolubiale/projects/cheddar-logic/data/cheddar.db babycheeses11@192.168.200.198:/opt/data/cheddar.db

# 3. Restart services
ssh babycheeses11@192.168.200.198 "sudo systemctl restart cheddar-web cheddar-worker"
```

---

## Settlement

The nightly settlement sweep runs automatically at **02:00 ET** via the worker scheduler.

**Why games may not be settled:**

- Scheduler ran at 2am but games weren't final yet (late games)
- The dated jobKey was consumed — idempotency prevents re-run with the same key

### Manually run settlement (bypasses idempotency)

```bash
# On Pi
cd /opt/cheddar-logic/apps/worker
DATABASE_PATH=/opt/data/cheddar.db node -e "
const { settleGameResults } = require('./src/jobs/settle_game_results');
settleGameResults({ jobKey: null, dryRun: false, minHoursAfterStart: 3 })
  .then(r => console.log(JSON.stringify(r, null, 2)));
"

DATABASE_PATH=/opt/data/cheddar.db node -e "
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
