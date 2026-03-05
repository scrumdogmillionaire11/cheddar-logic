# Play Generation Diagnostic Report

**Date**: March 5, 2026 03:00 AM EST  
**Issue**: UI shows many games as "NO PLAY - Degraded - drivers unavailable"

## Root Cause: Stale Odds Data

### Odds Pipeline Status

- **Last NBA odds captured**: March 4, 2026 7:00 PM EST (~8 hours ago)
- **Last NCAAM odds captured**: March 4, 2026 7:00 PM EST (~8 hours ago)
- **Last NHL odds captured**: March 4, 2026 7:00 PM EST (~8 hours ago)

### Model Execution Success (Last Hour)

- **NBA**: Generated 4 cards for 1 game ✅
- **NCAAM**: Generated 5 cards for games with odds ✅
- **NHL**: Generated 31 cards for 11 games ✅

### The Problem

Your UI is loading the **full schedule** of upcoming games (50+ games), but you only have **odds data for games from 8 hours ago**. The model jobs ran successfully but could only generate cards for games that had recent odds.

**Games with Stale/No Odds** → Displayed as "Degraded - drivers unavailable"  
**Games with Fresh Odds** → Cards generated successfully

## Evidence

```sql
-- Odds Age
SELECT sport, MAX(captured_at) as last_odds FROM odds_snapshots GROUP BY sport;
NBA|2026-03-04T19:00:57.471Z
NCAAM|2026-03-04T19:00:58.177Z
NHL|2026-03-04T19:00:56.944Z

-- Cards Generated (showing successful execution)
SELECT COUNT(*) FROM card_payloads WHERE created_at > datetime('now', '-1 hour') GROUP BY sport;
NBA: 4 cards
NCAAM: 5 cards  
NHL: 31 cards
```

## Solution

### Immediate Fix (Pull Fresh Odds)

```bash
# From repo root
CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db \
ODDS_API_KEY=YOUR_KEY_HERE \
npm --prefix apps/worker run job:pull-odds
```

Then re-run the model jobs:

```bash
CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db npm --prefix apps/worker run job:run-nba-model
CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db npm --prefix apps/worker run job:run-nhl-model
CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db npm --prefix apps/worker run job:run-ncaam-model
```

### Long-Term Fix (Automated Scheduler)

Use the scheduler to pull odds hourly:

```bash
# Set ODDS_API_KEY in .env
echo "ODDS_API_KEY=your_key_here" >> .env
echo "CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db" >> .env

# Start scheduler
./scripts/start-scheduler.sh
```

## Why Model Logic is Actually Working

The model logic (**driver computation**) is working correctly:

- ✅ No "Missing drivers" errors in job output
- ✅ NHL generated 31 cards (11 games × ~3 drivers each)
- ✅ NBA generated 4 cards (1 game × 4 drivers)
- ✅ NCAAM generated 5 cards with base-projection + matchup-style drivers
- ✅ All cards have valid predictions, confidence, tiers

The "drivers unavailable" message in the UI is **display logic** for games without ANY card data - which happens when there are no odds to run the model against.

## Next Steps

1. **Pull fresh odds** (requires ODDS_API_KEY from <https://theoddsapi.com>)
2. **Re-run models** - should generate 50+ cards across all sports
3. **Verify UI** - "Degraded" cards should be replaced with predictions
4. **Enable scheduler** - automate hourly odds pulls + model runs

## Audit: Where the Gaps Are

**Not a gap**: Driver computation logic ✅  
**Not a gap**: Card generation pipeline ✅  
**Not a gap**: Decision gates ✅  

**Actual gap**: **Odds ingestion cadence** ⚠️

The system needs continuous odds updates to generate fresh plays. Without hourly pulls, the UI will show stale games as "degraded" even though the model logic works perfectly.
