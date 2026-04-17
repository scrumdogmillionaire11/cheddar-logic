# Page Population Checklist: End-to-End Data Flow

**Status:** Critical path validation  
**Last Updated:** March 5, 2026  
**Scope:** Ensure Results page and Cheddar Board are populated with settled data

---

## 🎯 Five-Phase Data Pipeline

For **any page to show data**, all 5 phases must complete in sequence:

```text
PHASE 1: Schedule Data     → games table populated
   ↓
PHASE 2: Odds Pipeline     → odds_snapshots populated
   ↓
PHASE 3: Model Predictions → card_payloads + card_results (pending)
   ↓
PHASE 4: Game Settlement   → game_results (final scores)
   ↓
PHASE 5: Card Settlement   → card_results updated to 'settled'
   ↓
DISPLAY                     → Results page queries settled cards
```

---

## ✅ PHASE 1: Schedule Data (Games Table)

**What:** Games from ESPN are fetched and stored before any betting models can generate cards

**Jobs That Populate This:**

- `pull_schedule_nba.js` — Fetches NBA games from ESPN
- `pull_schedule_nhl.js` — Fetches NHL games from ESPN
- `pull_schedule_nfl.js` — (Not in scheduler yet, needs setup)

**Current Status:**

| Sport | Job File | In Scheduler? | Trigger | Last Check |
|-------|----------|---------------|---------|------------|
| NBA | `pull_schedule_nba.js` | ❓ | Manual / On-demand | Not verified |
| NHL | `pull_schedule_nhl.js` | ❓ | Manual / On-demand | Not verified |
| NCAAM | Removed in current worker package | ❌ | N/A | Do not advertise manual run |
| NFL | `pull_schedule_nfl.js` | ⚠️ | Not scheduled | MISSING |
| MLB | `pull_schedule_mlb.js` | ⚠️ | Not scheduled | MISSING |
| Soccer | N/A | ❌ | N/A | N/A |
| FPL | N/A | ❌ | N/A | Uses game_id from card context |

**Verification Steps:**

```bash
# 1. Check if games exist in database
sqlite3 /path/to/cheddar.db "SELECT sport, COUNT(*) as count FROM games GROUP BY sport;"

# Expected output:
# Sport | Count
# -----|-------
# NBA   | 800+
# NHL   | 800+
```

**To Fix:**

If any sport has `0` games:
1. Run manually: `node apps/worker/src/jobs/pull_schedule_nba.js`
2. Add to scheduler if missing (PR required)
3. Use backfill script: `npm run backfill:schedule` (if exists)

---

## ✅ PHASE 2: Odds Pipeline (Odds Snapshots Table)

**What:** Latest betting odds are pulled hourly and stored for each game

**Job That Populates This:**

- `pull_odds_hourly.js` — Fetches current odds from DraftKings/ESPN/etc.

**Trigger:** Every hour (configurable via `TICK_MS`)  
**Scheduler Status:** ✅ Active in `main.js` (line 260)

**Verification Steps:**

```bash
# 1. Check if odds exist and are recent
sqlite3 /path/to/cheddar.db "
SELECT sport, MAX(captured_at) as latest, COUNT(*) as count 
FROM odds_snapshots 
GROUP BY sport;
"

# Expected output:
# Sport | Latest | Count
# ------|--------|-------
# NBA   | 2026-03-05T14:00:00.000Z | 5000+
# NHL   | 2026-03-05T14:00:00.000Z | 5000+

# 2. Check if odds are FRESH (within last 2 hours)
sqlite3 /path/to/cheddar.db "
SELECT sport, COUNT(*) as fresh_count
FROM odds_snapshots
WHERE captured_at > datetime('now', '-2 hours')
GROUP BY sport;
"
```

**To Fix:**

If latest odds are stale (>2 hours old):
1. Check scheduler is running: `ps aux | grep scheduler`
2. Run manually: `node apps/worker/src/jobs/pull_odds_hourly.js`
3. Check logs from terminal where scheduler is running

---

## ✅ PHASE 3: Model Predictions (Card Payloads + Card Results)

**What:** Prediction models evaluate each game and generate cards

**Jobs That Populate This:**

- `run_nba_model.js` — NBA predictions
- `run_nhl_model.js` — NHL predictions
- `run_fpl_model.js` — FPL predictions
- `run_nfl_model.js` — NFL predictions (if enabled)
- `run_mlb_model.js` — MLB predictions

**Trigger:** Daily at 09:00 ET and 12:00 ET  
**Scheduler Status:** ✅ Active in `main.js` (lines 269-280)

`NCAAM` and `Soccer` model runner files are not present in the current worker package and should not be listed as fallback jobs.

**Verification Steps:**

```bash
# 1. Check if cards were generated today
sqlite3 /path/to/cheddar.db "
SELECT 
  sport,
  COUNT(DISTINCT cp.id) as card_count,
  COUNT(DISTINCT cr.game_id) as unique_games,
  MAX(cp.created_at) as latest_card
FROM card_payloads cp
INNER JOIN card_results cr ON cp.id = cr.card_id
WHERE DATE(cp.created_at) = DATE('now')
GROUP BY sport;
"

# Expected output (if models ran today):
# Sport | Card Count | Unique Games | Latest Card
# ------|------------|--------------|------------------
# NBA   | 500+       | 50+          | 2026-03-05T14:30:00Z
# NHL   | 400+       | 40+          | 2026-03-05T14:30:00Z

# 2. Check PENDING cards count (cards not yet settled)
sqlite3 /path/to/cheddar.db "
SELECT sport, COUNT(*) as pending_count
FROM card_results
WHERE status = 'pending'
GROUP BY sport
ORDER BY pending_count DESC;
"

# Expected: HIGH pending counts = cards waiting for game results
```

**To Fix:**

If no cards exist or count is low:
1. Check current time: Is it between 09:00–09:15 or 12:00–12:15 ET?
2. Run manually: `node apps/worker/src/jobs/run_nba_model.js`
3. Verify odds exist (PHASE 2) — models need odds input
4. Check error logs in scheduler terminal

---

## ✅ PHASE 4: Game Settlement (Game Results Table)

**What:** Final game scores are fetched from ESPN and stored

**Job That Populates This:**

- `settle_game_results.js` — Fetches final scores from ESPN

**Trigger:**

- Hourly (first 5 minutes) — checks for any games that finished
- Nightly (02:00 ET) — backfill sweep with 3-hour grace period

**Scheduler Status:** ✅ Active in `main.js` (lines 300–352)

**Verification Steps:**

```bash
# 1. Check if game_results exist
sqlite3 /path/to/cheddar.db "
SELECT sport, COUNT(*) as final_count, MAX(settled_at) as latest_settled
FROM game_results
WHERE status = 'final'
GROUP BY sport;
"

# Expected:
# Sport | Final Count | Latest Settled
# ------|-------------|-------------------
# NBA   | 500+        | 2026-03-04T02:00:00Z
# NHL   | 400+        | 2026-03-04T02:00:00Z

# 2. Check how many PENDING cards are waiting for game results
sqlite3 /path/to/cheddar.db "
SELECT COUNT(*) as pending_awaiting_scores
FROM card_results cr
WHERE cr.status = 'pending'
  AND NOT EXISTS (SELECT 1 FROM game_results WHERE game_id = cr.game_id AND status = 'final');
"

# Expected: Should be LOW if settlement job ran recently
```

**To Fix:**

If no game_results or count is low:
1. Check if time is right: Settlement runs hourly at :00–:05 minutes
2. Run manually: `node apps/worker/src/jobs/settle_game_results.js`
3. Check ESPN API is accessible
4. Look for "no safe ESPN match" errors in logs

---

## ✅ PHASE 5: Card Settlement (Card Results Settled)

**What:** Final scores are applied to cards; win/loss/push outcomes calculated

**Job That Populates This:**

- `settle_pending_cards.js` — Applies outcomes, updates card_results to 'settled'

**Trigger:**

- Hourly (first 5 minutes) — **after** settle_game_results
- Nightly (02:00 ET) — backfill sweep

**Scheduler Status:** ✅ Active in `main.js` (lines 300–352)

**Verification Steps:**

```bash
# 1. Check SETTLED cards count (what Results page reads)
sqlite3 /path/to/cheddar.db "
SELECT sport, COUNT(*) as settled_count, MAX(settled_at) as latest_settled
FROM card_results
WHERE status = 'settled'
GROUP BY sport
ORDER BY settled_count DESC;
"

# Expected:
# Sport | Settled Count | Latest Settled
# ------|---------------|-------------------
# NBA   | 500+          | 2026-03-05T02:00:15Z
# NHL   | 400+          | 2026-03-05T02:00:15Z

# 2. Check tracking_stats (aggregated record)
sqlite3 /path/to/cheddar.db "
SELECT sport, SUM(total_bets) as total_cards, SUM(wins) as total_wins
FROM tracking_stats
GROUP BY sport;
"

# Expected: Should have positive numbers
```

**To Fix:**

If settled card count is low/zero:
1. Verify PHASE 4 completed (game_results exist)
2. Run manually: `node apps/worker/src/jobs/settle_pending_cards.js`
3. Check database permissions (job_runs, tracking_stats tables writable)
4. Look for settlement errors in logs

---

## 🔍 PHASE 6: Results Page Display

**What:** Web UI queries settled cards and renders Results page

**Endpoint:** `GET /api/results?sport=NBA&limit=50`  
**Location:** [`web/src/app/api/results/route.ts`](web/src/app/api/results/route.ts)  

**Data Source:** `card_results` table WHERE `status='settled'`

**Verification Steps:**

```bash
# 1. Test API directly
curl 'http://localhost:3000/api/results?limit=5&sport=NBA'

# Expected response:
# {
#   "success": true,
#   "data": {
#     "summary": {
#       "totalCards": 500,
#       "settledCards": 500,
#       "wins": 350,
#       "losses": 150,
#       ...
#     },
#     "ledger": [
#       {
#         "id": "card-123",
#         "game": "Lakers vs Celtics",
#         "result": "win",
#         "pnl": 1.5,
#         ...
#       },
#       ...
#     ]
#   }
# }

# 2. Check if page is loading
# (Browser) Visit http://localhost:3000/results
# Should see: Results page with settled cards list, summary stats
```

**To Fix:**

If Results page is empty or shows 0 cards:
1. Run the PHASE 1–5 checklist above
2. Verify database connection: `npm run inspect-db` (if exists)
3. Check page is querying correct database (see ARCHITECTURE_SEPARATION.md)
4. Inspect browser DevTools → Network → `/api/results` response

---

## 🚀 Complete Diagnostic: Run This Now

```bash
# From repo root
cd /Users/ajcolubiale/projects/cheddar-logic

# 1. Check database exists and has tables
sqlite3 packages/data/cheddar.db ".tables"

# 2. Count data in each critical table
sqlite3 packages/data/cheddar.db "
SELECT 'games' as table_name, COUNT(*) as count FROM games
UNION ALL
SELECT 'odds_snapshots', COUNT(*) FROM odds_snapshots
UNION ALL
SELECT 'card_payloads', COUNT(*) FROM card_payloads
UNION ALL
SELECT 'card_results', COUNT(*) FROM card_results
UNION ALL
SELECT 'card_results (pending)', COUNT(*) FROM card_results WHERE status='pending'
UNION ALL
SELECT 'card_results (settled)', COUNT(*) FROM card_results WHERE status='settled'
UNION ALL
SELECT 'game_results', COUNT(*) FROM game_results
UNION ALL
SELECT 'tracking_stats', COUNT(*) FROM tracking_stats;
"

# 3. Check scheduler is running
ps aux | grep scheduler

# 4. Check if scheduler logs show recent ticks
tail -50 /path/to/scheduler/logs

# 5. Test Results API if dev server running
curl 'http://localhost:3000/api/results?limit=3'
```

---

## 📋 Action Items (In Priority Order)

**TODAY:**
- [ ] Run diagnostic above ↑
- [ ] Identify which PHASE is blocked
- [ ] Fix PHASE 1 (games missing) by running `pull_schedule_*.js` if needed
- [ ] Verify scheduler is running and logging

**THIS WEEK:**
- [ ] Add missing schedule jobs to scheduler (NFL, MLB if absent)
- [ ] Add cron/systemd triggers for schedule jobs (they may need manual kickoff)
- [ ] Enable Cheddar Board page once PHASE 5 validated

**NEXT**:
- [ ] Add data freshness monitoring (alerts if odds stale >2h)
- [ ] Add page load instrumentation (log which PHASE failed)
- [ ] Document per-sport seasonal schedules (off-season handling)

---

## 🔗 Related Docs

- [SETTLEMENT_CANONICAL_WORKFLOW.md](SETTLEMENT_CANONICAL_WORKFLOW.md) — How settlement works
- [ARCHITECTURE_SEPARATION.md](ARCHITECTURE_SEPARATION.md) — Database and app isolation
- [ops-runbook.md](ops-runbook.md) — Production troubleshooting

---

## 🆘 Common Blockers

**"Results page is empty"**  
→ PHASE 5 block: Run `settle_pending_cards.js` manually

**"No cards generated"**  
→ PHASE 3 block: Run `run_nba_model.js` manually (check time is 09:00–12:00 ET)

**"Odds are stale"**  
→ PHASE 2 block: Run `pull_odds_hourly.js` manually or restart scheduler

**"Games table empty"**  
→ PHASE 1 block: Run `pull_schedule_nba.js` manually or add to scheduler

**"API returns 500"**  
→ Check database path in `.env` matches actual file location
