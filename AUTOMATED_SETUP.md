# Cheddar Logic — Automated Setup Guide

## Overview

Your cheddar-logic system is now configured to run automatically with **zero manual intervention** once started. The system consists of 3 independent components that work together:

```
📊 Database (SQLite)
   ↓ (reads/writes)
🚀 Scheduler (background job orchestrator)
   • Pulls odds every hour
   • Runs models every 2 hours
   • Updates card payloads
   ↓ (writes)
💾 Database (persists state)
   ↓ (reads)
🌐 Web App (Next.js UI + API)
   ← User queries /api/cards
```

---

## One-Time Setup (First Run)

### 1. Prerequisites
```bash
# Ensure you have Node 18+
node -v          # Should be v18 or higher

# Check ODDS_API_KEY is set in .env
grep ODDS_API_KEY .env
# Should see: ODDS_API_KEY=e8d243da014123436569cc1bc73b91b4
```

### 2. Install Dependencies
```bash
# Install all packages (one time only)
npm --prefix packages/data install
npm --prefix apps/worker install
npm --prefix web install
```

### 3. Initialize Database

```bash
# Create tables
npm --prefix packages/data run migrate
```

**Expected output:**

```
✅ Migrations complete!
```

**Then pull live odds:**

Get your free API key from [theoddsapi.com](https://theoddsapi.com), then:

```bash
ODDS_API_KEY=YOUR_ACTUAL_KEY_HERE npm --prefix apps/worker run job:pull-odds
```

---

## Daily Operations

### Start Everything (3 Terminal Tabs)

Open 3 separate terminal windows **from the repo root** (`/Users/ajcolubiale/projects/cheddar-logic`):

**Tab 1 — Web App** (user-facing UI)

```bash
npm --prefix web run dev
# Wait for: ▲ Next.js running on http://localhost:3000
# (or http://localhost:3001 if 3000 is busy)
```

**Tab 2 — Scheduler** (background job orchestrator)

```bash
./scripts/start-scheduler.sh
# You should see:
# ✓ Scheduler started (PID: 12345)
# → Log: tail -f apps/worker/logs/scheduler.log
```

**Tab 3 — Development** (optional, for debugging)

```bash
./scripts/manage-scheduler.sh logs
# Watch live scheduler activity
# Press Ctrl+C to exit logs (scheduler keeps running)
```

### Verify Everything Works

```bash
# Check web app responds
curl http://localhost:3000/api/cards | jq '.data | length'

# Check scheduler is running
./scripts/manage-scheduler.sh status
# ✓ Scheduler is running (PID: 12345)
```

---

## Managing the Scheduler

### Quick Commands

```bash
# Check status
./scripts/manage-scheduler.sh status

# View logs (live tail)
./scripts/manage-scheduler.sh logs

# Restart (useful if odds aren't updating)
./scripts/manage-scheduler.sh restart

# Stop (if you need to pause pulls)
./scripts/manage-scheduler.sh stop

# Start again
./scripts/manage-scheduler.sh start
```

### What the Scheduler Does Automatically

**Odds Pull** (Hourly bucket):
```
[SCHEDULER] 09:00 ET: Pull odds from The Odds API
[SCHEDULER] 10:00 ET: Pull odds from The Odds API
[SCHEDULER] ... (every hour, 24/7)
```

**Token Budget** (Your free tier: 20,000/month):
```
Per fetch cost:       8 tokens (NHL: 2 + NBA: 3 + NCAAM: 3)
Fetches per day:      24 (hourly)
Fetches per month:    720 (24 × 30 days)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Monthly token usage:  5,760 tokens
Your limit:           20,000 tokens
Usage %:              28.8% ✅ SAFE
Buffer:               14,240 tokens available
```

**Model Runs** (Intelligent, not "every 2 hours"):
```
Fixed-time windows (daily):
  09:00 ET  Run all models (afternoon games)
  12:00 ET  Run all models (evening games updated)

T-minus windows (before each game):
  T-120 min Refresh models (2-hour pre-game)
  T-90 min  Refresh models (1.5-hour pre-game)
  T-60 min  Refresh models (1-hour pre-game)
  T-30 min  Final update (30-min pre-game)

Result: Cards are freshest when users need them most
```

The scheduler respects **sport seasons** — it only pulls/runs models for active sports:
- ✅ NHL (Oct 1 – Apr 30)
- ✅ NBA (Oct 1 – Jun 30)
- ✅ NCAAM (Nov 1 – Apr 15)
- ❌ MLB, NFL, SOCCER (disabled unless in season)

---

## Database Schema

| Table | Purpose | Updated By |
|-------|---------|-----------|
| `job_runs` | Log of every job execution (pull_odds, run_*_model) | Scheduler |
| `games` | Game metadata (team names, times, sport) | pull_odds |
| `odds_snapshots` | Snapshot of odds at a point in time | pull_odds |
| `model_outputs` | Inference results from model drivers | run_*_model |
| `card_payloads` | Ready-to-display card JSON | run_*_model |
| `card_results` | User interactions (clicks, views) | Web UI |

**Key:** Web app reads from `card_payloads` table — if no cards appear, the model job hasn't run yet.

---

## Troubleshooting

### No Cards Appearing

**Problem:** `curl http://localhost:3000/api/cards` returns empty array

**Solution:**
```bash
# Check if scheduler has pulled odds
sqlite3 packages/data/cheddar.db \
  "SELECT COUNT(*) FROM job_runs WHERE job_name='pull_odds_hourly';"

# If 0, run it manually
npm --prefix apps/worker run job:pull-odds

# Then run a model manually
npm --prefix apps/worker run job:run-nba-model

# Check cards generated
sqlite3 packages/data/cheddar.db \
  "SELECT COUNT(*) FROM card_payloads;"
```

### Scheduler Stopped

**Problem:** `./scripts/manage-scheduler.sh status` shows "not running"

**Solution:**
```bash
# Restart it
./scripts/manage-scheduler.sh restart

# Or start manually to see errors
cd apps/worker && npm run scheduler:dev
```

### API Key Issues

**Problem:** Logs show "ODDS_API_KEY not found"

**Solution:**
```bash
# Verify key in .env
grep ODDS_API_KEY .env

# If empty, get a free key from https://theoddsapi.com
# Then update .env and restart scheduler
./scripts/manage-scheduler.sh restart
```

### Database Lock

**Problem:** "database is locked" errors

**Solution:**

```bash
# Stop scheduler
./scripts/manage-scheduler.sh stop

# Kill any stuck processes
pkill -f "node.*scheduler\|npm.*scheduler"

# Wait 5 seconds
sleep 5

# Restart
./scripts/manage-scheduler.sh start
```

### Web App Port Already in Use

**Problem:** "Unable to acquire lock" or "Port 3000 is already in use"

**Solution:**

```bash
# Kill any stuck Next.js processes
lsof -ti :3000 | xargs kill -9 2>/dev/null || true

# Remove the lock file
rm -f web/.next/dev/lock

# Start web app again
npm --prefix web run dev
```

(Web app will auto-use port 3001 if 3000 is busy, but it's cleaner to free the port)

### Web App Shows Multiple Lockfiles Warning

**Problem:** "Detected multiple lockfiles" warning on startup

**Solution:** This is harmless but optional to fix. If it bothers you:

```bash
# The repo root has a package-lock.json from the monorepo
# The /web subdirectory has its own package-lock.json
# They can coexist, but if you want silence, you can remove the root one:

rm package-lock.json  # Only if you don't need the monorepo lockfile
```

---

## Environment Variables

Key variables in `.env`:

```bash
# Database path (required)
DATABASE_PATH=packages/data/cheddar.db

# Odds API (required for live pulls)
ODDS_API_KEY=your_key_here

# Timezone (default: America/New_York)
TZ=America/New_York

# Scheduler loop interval (default: 60000ms = 60s)
TICK_MS=60000

# Disable specific sports (if seasons ended)
ENABLE_ODDS_PULL=true          # Disable if over token budget
ENABLE_NHL_MODEL=true          # Run model jobs for this sport
ENABLE_NBA_MODEL=true
ENABLE_NCAAM_MODEL=true
ENABLE_NFL_MODEL=false         # Disabled (out of season)
ENABLE_MLB_MODEL=false         # Disabled (out of season)
ENABLE_SOCCER_MODEL=false      # Disabled
ENABLE_FPL_MODEL=true          # Fantasy Premier League

# Dry-run mode (logs only, no DB writes)
DRY_RUN=false

# Catchup behavior (default: true — allows catch-up on restarts)
FIXED_CATCHUP=true
```

**Token Budget Optimization:**

At current usage (hourly pulls, 3 active sports):
- Monthly: 5,760 tokens (28.8% of 20,000)
- You have 14,240 tokens of buffer

If approaching limit:

```bash
# Disable a sport (saves ~72 tokens/day)
ENABLE_NCAAM_MODEL=false ./scripts/manage-scheduler.sh restart

# Or reduce pull frequency (2-hour buckets instead of hourly = 50% token reduction)
TICK_MS=120000 ./scripts/manage-scheduler.sh restart
```

To change: Edit `.env`, then restart scheduler:

```bash
./scripts/manage-scheduler.sh restart
```

---

## Production Deployment

For a production server, use the systemd service:

```bash
# Copy service file
sudo cp cheddar-worker.service /etc/systemd/system/

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable cheddar-worker
sudo systemctl start cheddar-worker

# Check status
sudo systemctl status cheddar-worker

# View logs
journalctl -u cheddar-worker -f
```

See `PRODUCTION_CUTOVER.md` for full deployment steps.

---

## What You've Just Set Up

✅ **Database** — SQLite with 9 migration tables  
✅ **Scheduler** — Runs in background, never missed pulls/models  
✅ **Web App** — Serves cards on http://localhost:3000  
✅ **Job Logging** — Every pull and model run is logged  
✅ **Auto-restart** — Scheduler survives crashes  
✅ **Easy Management** — Simple scripts to start/stop/restart

---

## Next Steps

1. **Start everything:**
   ```bash
   npm --prefix web run dev          # Terminal 1
   ./scripts/start-scheduler.sh       # Terminal 2
   ./scripts/manage-scheduler.sh logs # Terminal 3 (watch)
   ```

2. **Wait 1 hour** for first scheduled pull

3. **Or manually trigger** (don't wait):
   ```bash
   npm --prefix apps/worker run job:pull-odds
   npm --prefix apps/worker run job:run-nba-model
   ```

4. **Check dashboard:**
   ```
   http://localhost:3000
   ```

5. **Set up monitoring** (optional):
   - Add alerts to job_runs table for failures
   - Set up log rotation (see `cheddar-worker.service`)
   - Monitor ODDS API quota usage

---

## FAQ

**Q: Can I close the terminal where the scheduler is running?**

A: Yes! The scheduler runs in `nohup`, so it persists even after terminal closes. Start it once with `./scripts/start-scheduler.sh`, then open a new terminal to check logs with `./scripts/manage-scheduler.sh logs`.

**Q: How often do odds update?**

A: Every hour, 24/7. Uses ~5,760 tokens/month (28.8% of your 20,000 limit). Safe and well within budget!

**Q: When do models run?**

A: Intelligently (not just "every 2 hours"):

- **Fixed-time windows** (daily): 9:00 AM & 12:00 PM ET (before afternoon/evening games)
- **Pre-game windows** (T-minus): T-120, T-90, T-60, T-30 min before each game starts
- **Why:** Cards are freshest exactly when users need them (right before games)

**Q: What's the token budget math?**

A: You have 20,000 tokens/month:

```
Hourly pulls: 8 tokens/fetch × 24 fetches/day × 30 days
            = 5,760 tokens/month
Usage:        28.8% of limit
Buffer:       14,240 tokens remaining ✅
```

Plenty of headroom!

**Q: What if I want to run a model right now (not wait for next window)?**

A: Run manually:

```bash
npm --prefix apps/worker run job:run-nba-model
```

**Q: Can I customize which sports run?**

A: Yes! Two ways:

1. Edit `.env` to disable models: `ENABLE_NCAAM_MODEL=false`
2. Edit `packages/odds/src/config.js` to disable odds fetching by sport

Then restart:

```bash
./scripts/manage-scheduler.sh restart
```

**Q: What if I'm approaching the 20,000 token limit?**

A: You have options:

- Disable a sport: `ENABLE_NCAAM_MODEL=false` (saves ~72 tokens/day)
- Reduce pull frequency: `TICK_MS=120000` (2-hour buckets = 50% fewer tokens)
- At 28.8% usage, you're nowhere near the limit yet

**Q: How much data does this store?**

A: ~500MB per year of odds/model data (SQLite fits on any device).

---

## You're All Set! 🎉

Your cheddar board is now automated. The scheduler will keep it updated throughout the day without any manual intervention.

**What's running:**
- ⏰ Odds fetched **every hour** (5,760 tokens/month = 28.8% of limit)
- 🧠 Models run **intelligently** (fixed times + T-mins before games)
- 💾 Database updated **continuously** as each job completes
- 📊 Job runs logged **for debugging & monitoring**
- 🔄 Auto-restart **if anything crashes**

**Go watch:** `./scripts/manage-scheduler.sh logs`

Your end goal is now achievable. The system runs 24/7, pulls fresh odds hourly, runs models strategically (morning, afternoon, then pre-game windows), and your web app always serves the freshest cards.

For production deployment, see `PRODUCTION_CUTOVER.md`.
