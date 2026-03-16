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

### Decision Pipeline v2 Contract Checks (Wave-1)

Wave-1 (`NBA`/`NHL`/`NCAAM`, `MONEYLINE`/`SPREAD`/`TOTAL`/`PUCKLINE`/`TEAM_TOTAL`) is worker-owned.
Web/API/UI are pure consumers of worker `decision_v2`.

```bash
# Inspect wave-1 plays for decision_v2 and verdict vocabulary
curl -s "http://localhost:3000/api/games?limit=200" | jq '
  .data[]
  | .sport as $sport
  | .plays[]
  | select(
      ((.kind // "PLAY") == "PLAY") and
      ($sport == "NBA" or $sport == "NHL" or $sport == "NCAAM") and
      (.market_type == "MONEYLINE" or .market_type == "SPREAD" or .market_type == "TOTAL" or .market_type == "PUCKLINE" or .market_type == "TEAM_TOTAL")
    )
  | {
      sport: $sport,
      market_type,
      official_status: .decision_v2.official_status,
      primary_reason_code: .decision_v2.primary_reason_code,
      pipeline_version: .decision_v2.pipeline_version
    }'
```

Expected:

- `decision_v2.pipeline_version` is `"v2"`.
- `decision_v2.official_status` is one of `PLAY/LEAN/PASS`.
- Missing `decision_v2` on a wave-1 play is an upstream worker contract failure.

Incident rule:

- Do not hotfix wave-1 verdicts by adding API/UI recompute or repair logic.
- Fix worker decision emission and republish from worker path.

Note: Vercel/Cloudflare static chunk 404 incidents are delivery-layer issues, not decision-contract logic.

### Settlement verification (display -> results parity)

Use this when validating that every displayed play is eligible for settlement and appears on `/api/results`.

```bash
# 0) Load canonical DB env on Pi
set -a; source /opt/cheddar-logic/.env.production; set +a

# 1) Displayed plays in the last 2 hours
sqlite3 "$CHEDDAR_DB_PATH" "
SELECT COUNT(*) AS displayed_last_2h
FROM card_display_log
WHERE displayed_at >= datetime('now', '-2 hours');
"

# 2) Pending results that are display-backed
sqlite3 "$CHEDDAR_DB_PATH" "
SELECT COUNT(*) AS pending_displayed
FROM card_results
WHERE status = 'pending'
  AND card_id IN (SELECT pick_id FROM card_display_log);
"

# 2.5) Read-only settlement health report
npm --prefix apps/worker run job:settlement-report -- --json --limit=10

# 3) Run settlement jobs
npm --prefix apps/worker run job:settle-games
npm --prefix apps/worker run job:settle-cards

# 4) Settled results for recently displayed plays
sqlite3 "$CHEDDAR_DB_PATH" "
SELECT COUNT(*) AS settled_displayed_last_2h
FROM card_results
WHERE status = 'settled'
  AND card_id IN (
    SELECT pick_id
    FROM card_display_log
    WHERE displayed_at >= datetime('now', '-2 hours')
  );
"

# 5) Reconciliation count (must be 0)
sqlite3 "$CHEDDAR_DB_PATH" "
SELECT COUNT(*) AS final_displayed_missing_result
FROM card_display_log cdl
LEFT JOIN card_results cr ON cdl.pick_id = cr.card_id
WHERE cr.id IS NULL
  AND EXISTS (
    SELECT 1
    FROM game_results gr
    WHERE gr.game_id = cdl.game_id
      AND gr.status = 'final'
  );
"

# 6) Detailed orphan listing (must return no rows)
sqlite3 "$CHEDDAR_DB_PATH" "
SELECT cdl.pick_id, cdl.game_id, cdl.sport
FROM card_display_log cdl
LEFT JOIN card_results cr ON cdl.pick_id = cr.card_id
WHERE cr.id IS NULL
  AND EXISTS (
    SELECT 1
    FROM game_results gr
    WHERE gr.game_id = cdl.game_id
      AND gr.status = 'final'
  );
"

# 7) API parity smoke
curl -s http://localhost:3000/api/results | jq '.data.meta'
curl -sI http://localhost:3000/api/results | grep -i '^x-settlement-coverage:'
```

### Read-only settlement health report

Use this before any rerun if the question is:

- do we still have unsettled plays?
- are unsettled rows actionable or blocked?
- which settlement failures happened in prod, and why?

Command:

```bash
# Human-readable summary
npm --prefix apps/worker run job:settlement-report

# Machine-readable JSON for incident notes / jq
npm --prefix apps/worker run job:settlement-report -- --json --limit=10

# Restrict to one sport and recent window
npm --prefix apps/worker run job:settlement-report -- --sport=NHL --days=7 --json

# Optional: override saved log file path
npm --prefix apps/worker run job:settlement-report -- --log-file /tmp/settlement-health.json --json
```

Default log artifact:

- Every CLI run saves the full report JSON to `logs/settlement-health-<timestamp>.json`.
- Use `--log-file <PATH>` to override the saved path.
- Use `--no-log` if you only want terminal output.

What it reports:

- `summary.hasUnsettledPlays`: whether any `card_results.status='pending'` rows remain
- `summary.hasActionableUnsettledFinalDisplayed`: pending rows that already have both display-log evidence and `game_results.status='final'`
- `coverage.pendingWithFinalNoDisplay`: pending rows blocked only because `card_display_log` is missing
- `coverage.pendingWithFinalMissingMarketKey`: pending rows blocked because settlement contract fields are incomplete
- `coverage.pendingDisplayedWithoutFinal`: displayed pending rows still waiting on a final game result
- `failures.byCode`: grouped `metadata.settlement_error.code` counts for `card_results.status='error'`
- `jobRuns`: latest success/failure snapshots for `settle_game_results` and `settle_pending_cards`

Suggested incident flow:

1. Run `job:settlement-report -- --json` and save the output.
2. If `hasActionableUnsettledFinalDisplayed=true`, rerun `job:settle-games` then `job:settle-cards`.
3. Compare the new report to the saved one:

- actionable pending should decrease
- failure-code buckets should stabilize to known contract issues
- recent job failures should explain any non-zero blocked counts

Expected relationships:

- `final_displayed_missing_result` is always `0`.
- For the same recent window, `displayed_last_2h = pending_displayed + settled_displayed_last_2h`.
- `/api/results` remains display-log scoped (no phantom rows outside `card_display_log`).

### Settlement contract details (totals + P/L)

- Canonical P/L formula:
  - `win`: `odds > 0 ? odds/100 : 100/abs(odds)`
  - `loss`: `-1`
  - `push`: `0`
- Malformed odds (`null`, non-numeric, or `0`) do not block W/L grading.
  - Settlements still write `status='settled'` and `result`.
  - `pnl_units` is set to `NULL` when a win cannot compute units from bad odds.
  - Worker log emits `PNL_ODDS_INVALID` anomaly lines.
- NHL 1P totals settlement requires first-period scores in `game_results.metadata.firstPeriodScores` (`home`, `away`).
  - If missing, card settles to `status='error'` + `result='void'` with `settlement_error.code='MISSING_PERIOD_SCORE'`.
- `job:settle-cards` logs market-bucket daily counters for:
  - `NBA_TOTAL`
  - `NHL_TOTAL`
  - `NHL_1P_TOTAL`

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
p=s.get('totalPnlUnits')
p_txt=round(p,2) if isinstance(p,(int,float)) else 'N/A'
print(f'settled: {s[\"settledCards\"]}, record: {s[\"wins\"]}-{s[\"losses\"]}-{s[\"pushes\"]}, pnl(optional): {p_txt}')
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

**Symptoms:**

- Console shows `/_next/static/chunks/*.js` 404s, CSS not loading, or hydration failures after a successful deploy.
- `/cards` renders shell UI but shows `0 games` and **no `/api/games` request appears in Network**.
  - This indicates the client bundle failed before the cards fetch effect could run.

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
4. Browser validation (post-fix):
   - Open `/cards`
   - Confirm `/api/games` appears in Network on first load
   - Confirm card list populates

### Cloudflare Tunnel outage: split traffic, `1016`, or `530`

**Observed production failure pattern (March 2026):**

- Public `/cards` served a mix of webpack production chunks and stale Turbopack/dev chunks.
- Cloudflare Tunnel cutover temporarily produced `1016 Origin DNS error`.
- Follow-up requests returned `530` while Pi origin stayed healthy (`127.0.0.1:3000 -> 200`).
- Root cause was tunnel control-plane drift: multiple tunnels/connectors, hostname routes attached to the wrong tunnel, and conflicting/manual DNS records.

**Non-negotiable production rules:**

- Maintain **exactly one** production website tunnel.
- Manage `cheddarlogic.com`, `www.cheddarlogic.com`, and `api.cheddarlogic.com` only from **Published application routes** on that one tunnel.
- Do **not** use **Zero Trust → Networks → Routes** for the public website. That screen is for private hostname/Gateway routing.
- Do **not** leave old production tunnels alive after cutover.
- Prefer `127.0.0.1` instead of `localhost` in tunnel route origins.

**Canonical production route mapping:**

- `cheddarlogic.com` → `http://127.0.0.1:3000`
- `www.cheddarlogic.com` → `http://127.0.0.1:3000`
- `api.cheddarlogic.com` → `http://127.0.0.1:8000`

**Fast diagnosis:**

```bash
# 1) Public symptom
curl -sS -o /dev/null -w "%{http_code}\n" https://cheddarlogic.com/cards

# 2) Local origin health on Pi
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/cards

# 3) Connector health on Pi
sudo systemctl status cloudflared --no-pager
sudo journalctl -u cloudflared -n 30 --no-pager

# 4) Confirm the Pi token's tunnel UUID
sudo cat /etc/systemd/system/cloudflared.service | grep -o 'eyJ[A-Za-z0-9._-]*' | \
  cut -d'.' -f2 | base64 -d 2>/dev/null
```

Interpretation:

- **`1016`**: DNS points at a missing/deleted tunnel target.
- **`530` + local origin `200`**: Cloudflare is not routing traffic to the active connector/tunnel route.
- **Mixed prod/dev chunks**: multiple active connectors or tunnels are serving the same hostname.

**Recovery sequence:**

1. In **Zero Trust → Networks → Connectors**, identify the single tunnel whose **Tunnel ID** matches the Pi's installed `cloudflared` token.
2. On that tunnel only, configure **Published application routes** for root/www/api using the canonical mappings above.
3. In the public DNS zone, remove conflicting `A`, `AAAA`, or `CNAME` records for `cheddarlogic.com`, `www`, and `api` if Cloudflare refuses to auto-create managed records.
4. Re-save the Published application routes so Cloudflare recreates the correct DNS records.
5. Restart `cloudflared` once on the Pi to force re-registration after route changes:

   ```bash
   sudo systemctl restart cloudflared
   ```

6. Re-test both public URL and local origin. Do not close the incident until public `/cards` is stable at `200`.

**Post-change smoke test:**

```bash
# Public site
for i in $(seq 1 5); do
  curl -sS -o /dev/null -w "%{http_code}\n" "https://cheddarlogic.com/cards?cb=$(date +%s%N)"
done

# Tunnel metrics on Pi should show requests after recovery
curl -s http://127.0.0.1:20241/metrics | \
  egrep 'cloudflared_tunnel_request_errors|cloudflared_proxy_connect_latency_count|cloudflared_tunnel_request' | head -20
```

Expected end state:

- Public `/cards` returns `200`
- Pi origin returns `200`
- Only one production tunnel is active
- Published application routes own the public website DNS records

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

### Main DB Corruption Recovery

Covers `database disk image is malformed` on the production main SQLite DB (`CHEDDAR_DB_PATH`). This incident workflow is containment-first: stop writes, preserve evidence, repair, verify, then restart.

**Symptoms:**

- Worker or web logs show: `database disk image is malformed`
- `bash scripts/db-context.sh` reports the DB path but sqlite3 table counts fail or return errors
- `./scripts/manage-scheduler.sh db` may show path drift or unexpected scheduler DB
- `sqlite3 "$CHEDDAR_DB_PATH" "PRAGMA integrity_check;"` returns anything other than `ok`

**Recovery Procedure:**

**Step 1 — Stop the worker** (single-writer contract: no writes during repair):

```bash
sudo systemctl stop cheddar-worker
sudo systemctl status cheddar-worker   # confirm stopped
```

**Step 2 — Load production env** so `$CHEDDAR_DB_PATH` is set:

```bash
set -a; source /opt/cheddar-logic/.env.production; set +a
echo "DB path: $CHEDDAR_DB_PATH"
```

**Step 3 — Run diagnostics** to confirm corruption and identify owner:

```bash
# Identify process currently holding the DB open (should be empty after stop)
lsof "$CHEDDAR_DB_PATH" 2>/dev/null || echo "No open handles"

# Run integrity check
sqlite3 "$CHEDDAR_DB_PATH" "PRAGMA integrity_check;"
# Output other than "ok" confirms corruption

# Full diagnostic snapshot
bash scripts/db-context.sh
./scripts/manage-scheduler.sh db
```

**Step 4 — Preserve the corrupt DB** with a timestamped backup BEFORE any repair:

```bash
cp "$CHEDDAR_DB_PATH" "${CHEDDAR_DB_PATH}.corrupt.$(date +%Y%m%d-%H%M%S)"
echo "Backed up corrupt DB"
```

**Step 5 — Choose recovery path:**

*Option A: Restore from daily backup* (preferred if a recent clean backup exists):

```bash
BACKUP_DIR="$(dirname "$CHEDDAR_DB_PATH")/backups"
ls -lt "$BACKUP_DIR"/cheddar-*.db | head -5   # find latest backup
# Pick the newest backup that pre-dates the corruption
LATEST_BACKUP="$BACKUP_DIR/cheddar-YYYYMMDD.db"   # substitute actual filename
sqlite3 "$LATEST_BACKUP" "PRAGMA integrity_check;"   # verify backup is healthy
cp "$LATEST_BACKUP" "$CHEDDAR_DB_PATH"
echo "Restored from: $LATEST_BACKUP"
```

*Option B: Attempt SQLite dump-and-restore* (partial recovery if no clean backup):

```bash
# Dump recoverable rows to SQL (corrupt pages produce errors but may yield partial data)
sqlite3 "$CHEDDAR_DB_PATH" ".recover" > /tmp/cheddar-recover.sql 2>/tmp/cheddar-recover.err
# Review errors
cat /tmp/cheddar-recover.err

# Rebuild from dump
sqlite3 /tmp/cheddar-recovered.db < /tmp/cheddar-recover.sql
sqlite3 /tmp/cheddar-recovered.db "PRAGMA integrity_check;"
cp /tmp/cheddar-recovered.db "$CHEDDAR_DB_PATH"
```

*Option C: Controlled rebuild* (last resort — loses historical data):

```bash
# Run migrations to create a fresh schema
set -a; source /opt/cheddar-logic/.env.production; set +a
npm --prefix /opt/cheddar-logic/packages/data run migrate
# Data will be empty; worker will repopulate via scheduled jobs
```

**Step 6 — Verify integrity** of the restored/rebuilt DB:

```bash
sqlite3 "$CHEDDAR_DB_PATH" "PRAGMA integrity_check;"
# Must output: ok

# Confirm expected tables and minimum row counts
sqlite3 "$CHEDDAR_DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
sqlite3 "$CHEDDAR_DB_PATH" "SELECT COUNT(*) AS card_payloads  FROM card_payloads;"
sqlite3 "$CHEDDAR_DB_PATH" "SELECT COUNT(*) AS odds_snapshots FROM odds_snapshots;"
sqlite3 "$CHEDDAR_DB_PATH" "SELECT COUNT(*) AS game_results   FROM game_results;"
sqlite3 "$CHEDDAR_DB_PATH" "SELECT COUNT(*) AS card_results   FROM card_results;"
```

**Step 7 — Restart services** in single-writer order (worker first, then web):

```bash
sudo systemctl start cheddar-worker
sleep 5
sudo systemctl status cheddar-worker

sudo systemctl restart cheddar-web
sleep 5
sudo systemctl status cheddar-web
```

**Step 8 — Post-recovery smoke checks:**

```bash
# Confirm both services use canonical DB path
sudo systemctl show cheddar-worker -p Environment | grep CHEDDAR_DB_PATH
sudo systemctl show cheddar-web -p Environment | grep CHEDDAR_DB_PATH

# DB reads healthy from web side
curl -s http://localhost:3000/api/games?limit=1 | head -20

# Worker is writing (check recent job_runs after a few minutes)
sqlite3 "$CHEDDAR_DB_PATH" "SELECT job_name, started_at, status FROM job_runs ORDER BY started_at DESC LIMIT 5;"
```

**Key Guardrails:**

> **NEVER** skip the timestamped corrupt backup (Step 4). It is required for post-incident forensics.
>
> **NEVER** start `cheddar-web` before `cheddar-worker` completes its first clean write cycle — web is read-only and must not race against an empty DB.
>
> **Do NOT** enable `CHEDDAR_DB_ALLOW_MULTI_PROCESS=true` in production as a workaround — this bypasses the single-writer contract (ADR-0002).
>
> If corruption recurs, check disk space on `/opt/data` and review `journalctl` for I/O errors suggesting hardware or power-loss events.

---

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
- **Nightly sweep**: runs at **02:00 ET** (strict display-log mode)

Display-log contract:

- `settle_pending_cards` grades only rows that already exist in `card_display_log`.
- Automatic payload-to-display backfill is disabled by default.
- Emergency override only: `CHEDDAR_SETTLEMENT_ENABLE_DISPLAY_BACKFILL=true`.

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
p=s.get('totalPnlUnits')
p_txt=round(p,2) if isinstance(p,(int,float)) else 'N/A'
print(f'settled: {s[\"settledCards\"]}, record: {s[\"wins\"]}-{s[\"losses\"]}-{s[\"pushes\"]}, pnl(optional): {p_txt}')
"
```

W/L-first interpretation:

- Treat `wins/losses/pushes` and `settledCards` as primary health signals.
- `totalPnlUnits` may be `null`; this is non-blocking when settlement counts are coherent.

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

---

## Dependency Security

### packages/odds — axios

Upgraded from axios `^0.27.2` to `^1.7.0` (WI-0342, 2026-03-08).

- Previous version had 3 high-severity CVEs (CSRF, SSRF, DoS via `__proto__`)
- axios 1.x API is backwards-compatible for the basic `axios.get(url, { params, timeout })` usage in this package
- Run `npm --prefix packages/odds audit --omit=dev` to confirm clean; should show `found 0 vulnerabilities`

### Next.js Build Warnings

- **Multi-lockfile root warning**: Resolved — `web/next.config.ts` sets `turbopack.root` to the monorepo root
- **Middleware convention**: Current `web/src/middleware.ts` uses supported `NextResponse.next()` pattern with `config.matcher` — no deprecation warnings expected

---

## Lineage Audit Procedure

Use this procedure to verify end-to-end record traceability from ingest through settlement. Run after any settlement job failure, before/after schema migrations, or as a monthly health check.

### When to Run

- After any `settle_pending_cards` or `settle_game_results` job failure
- Before and after any schema migration touching `card_payloads`, `card_results`, or `model_outputs`
- Monthly as a standing health check (first Monday of each month)
- Before any incident post-mortem that involves settlement counts or P&L accuracy

### How to Run

```bash
# From repo root (CHEDDAR_DB_PATH must be set)
node scripts/audit-lineage.js

# Load env from production file first (on Pi):
set -a; source /opt/cheddar-logic/.env.production; set +a
node /opt/cheddar-logic/scripts/audit-lineage.js

# Redirect to file for evidence (include in incident notes):
node scripts/audit-lineage.js > /tmp/lineage-audit-$(date +%Y%m%d).txt
```

### Triage Decision Table (Full Lineage %)

| Coverage % | Action |
|-----------|--------|
| 95-100% | No action needed |
| 80-94% | Investigate write-path gaps in settle_pending_cards.js; check metadata field population for direction, driver_key, and confidence_tier |
| 50-79% | Settlement pipeline likely not running; check job_runs for recent settle_pending_cards entries; verify game_results has final rows |
| <50% | Critical — card_payloads may be missing decision_v2; check worker model job output and insertCardPayload() call sites |

**Note on expected baseline:** Evidence/driver cards (e.g. `nhl-base-projection`, `nhl-goalie`) do not carry `decision_v2` by design. The 33% `call_action` / `driver_context` baseline is expected until GAP-05 and GAP-06 in `DATA_CONTRACTS.md` are resolved.

### Per-Field Triage

- **market_type missing or 'unknown'**: Check `normalizeMarketType()` in `packages/data/src/normalize.js` and the card_type to recommended_bet_type mapping in `settle_pending_cards.js`.

- **call_action (decision_v2.official_status) missing**: Card pre-dates wave-1 `decision_v2` pipeline (legacy evidence/driver row) OR worker failed to emit `decision_v2`. Check model job logs for the relevant game_id. Wave-1 call cards (`*-totals-call`, `*-spread-call`) must always have `decision_v2`; evidence cards do not.

- **projection_source missing**: `model_output_ids` not set on `card_payloads` AND `meta.inference_source` absent. Check the `insertCardPayload()` call site in the relevant model job. See GAP-07 in `DATA_CONTRACTS.md`.

- **driver_context missing**: `decision_v2.drivers_used` is empty or absent. For call-type cards, check the driver evaluation step in the model job. For evidence/driver cards, absence is expected.

### Record Linkage Manual Check Command

```bash
# Check 10 recent settled records for full lineage (requires sqlite3 CLI on Pi)
set -a; source /opt/cheddar-logic/.env.production; set +a

sqlite3 "$CHEDDAR_DB_PATH" "
SELECT
  cr.id,
  cr.sport,
  cr.card_type,
  cr.recommended_bet_type,
  cr.result,
  json_extract(cp.payload_data, '$.decision_v2.official_status') AS call_action,
  json_extract(cp.payload_data, '$.decision_v2.drivers_used') AS drivers,
  json_extract(cp.payload_data, '$.meta.inference_source') AS infer_source,
  cp.model_output_ids
FROM card_results cr
JOIN card_payloads cp ON cp.id = cr.card_id
WHERE cr.status = 'settled'
ORDER BY cr.settled_at DESC
LIMIT 10;
"
```

Note: `CHEDDAR_DB_PATH` is resolved by `packages/data/src/db-path.js`. Check that file for current env resolution order (`CHEDDAR_DB_PATH` takes precedence over `CHEDDAR_DATA_DIR` auto-discovery).

### Gap Reference

See `docs/DATA_CONTRACTS.md` — **Record Lineage Map** section for the full gap classification table (GAP-01 through GAP-09) with fix recommendations for each missing lineage field.
