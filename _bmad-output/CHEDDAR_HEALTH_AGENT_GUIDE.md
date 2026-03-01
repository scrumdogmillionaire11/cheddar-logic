# Cheddar Health Agent — Implementation Guide

## What Has Been Created

I've created a **cheddar-health agent** and framework for you that mirrors the BMAD agent pattern found in `cheddar-nba-2.0` and `cheddar-nhl`. This agent is designed specifically to assess the health and performance of your sports betting models across all sports in cheddar-logic.

### Files Created

1. **`_bmad/core/agents/cheddar-health.md`** (Agent Definition)
   - Agent persona: Dr. Claire (Medical data scientist)
   - 11 available commands for different analyses
   - Links to task definitions and templates

2. **`_bmad/core/tasks/assess-overall-health.md`**
   - Strategy for calculating cross-sport health metrics
   - Data sources: card_results, card_payloads, game_results, model_outputs
   - Status thresholds and degradation signal definitions

3. **`_bmad/core/tasks/analyze-drivers.md`**
   - Framework for analyzing individual decision drivers by sport
   - Defined driver taxonomy (NBA, NHL, NCAAM, NFL, FPL)
   - Degradation signal detection for drivers

## Architecture Overview

```
cheddar-logic (existing monorepo)
├── apps/worker/
│   └── src/jobs/          ← Model runners (run_nba_model, etc)
├── packages/data/
│   └── src/db.js          ← Available database interface
└── _bmad/
    └── core/
        ├── agents/
        │   └── cheddar-health.md    ← NEW: Health agent
        └── tasks/
            ├── assess-overall-health.md    ← NEW
            └── analyze-drivers.md          ← NEW
```

## Key Metrics the Agent Will Track

### Per-Sport (30-day rolling window, customizable)

| Metric | Why It Matters |
| --- | --- |
| Hit Rate | Primary accuracy indicator (target: ≥52%) |
| ROI | Profitability in units (positive = edge) |
| Win-Loss Records | Raw outcome distribution |
| Current Streak | Momentum (W5 vs L3 flags reversals) |
| Last 10 Hit Rate | Detect recent degradation |
| Avg Confidence | Calibration quality (pred vs actual) |
| Degradation Signals | Automated alerts (hit rate drops, ROI flips, etc) |

### Driver Performance (by sport)

For each driver (rest-advantage, goalie quality, etc):

- Hit rate when driver signals
- Attribution weight in final decision
- Trend (improving/stable/degrading)
- Calibration (predicted vs actual confidence)

## How to Use It

### Option 1: Interactive Mode (Recommended for Now)

When we activate the agent in Copilot Chat, you'll be able to:

```
*health-summary          # Quick snapshot all sports
*health-summary NBA      # Focus on NBA only
*driver-analysis NHL     # NHL driver breakdown
*degradation-check       # Alert on any issues
*recommend-actions       # Get prioritized fixes
```

### Option 2: Integration into Your Workflow

Create a scheduled task (similar to your scheduler in `scripts/start-scheduler.sh`):

```bash
# Future: Add to your scheduler
npm --prefix apps/worker run job:assess-model-health

# Or run manually
node apps/worker/src/jobs/assess-model-health.js
```

## Data Sources & Queries

The agent will query your existing tables:

### card_results
```javascript
// Existing table structure (from context)
SELECT 
  card_id,
  game_id,
  sport,
  result,       // 'W' | 'L' | 'P'
  created_at
FROM card_results
WHERE created_at > datetime('now', '-30 days')
```

### card_payloads
```javascript
// Existing table structure
SELECT 
  id,
  confidence,
  prediction,
  payload_data  // Contains drivers, impact weights, etc
FROM card_payloads
```

### game_results
```javascript
// Existing table structure
SELECT 
  game_id,
  sport,
  status,       // 'completed' | 'in_progress' | 'cancelled'
  home_score,
  away_score
FROM game_results
```

## Comparison: What Basketball Repos Have

### cheddar-nba-2.0
- ✅ `MODEL_HEALTH_METRICS` service (Python)
- ✅ `ModelHealthMetrics.calculate_model_health()` method
- ✅ Segment breakdown by totals range (210-220, 220-230, etc)
- ✅ Driver performance attribution
- ✅ Exports to `nba-2.0.json` for personal dashboard

### cheddar-nhl
- ✅ AGENTS.md migration contract
- ✅ .bmad-core agent structure (like what we're creating)
- ⚠️ No formal model health metrics yet (you're building this first)

## What You're Getting (cheddar-logic)

### Advantages Over Existing Repos

1. **Multi-Sport from Day One**: Framework covers NBA, NHL, NCAAM, NFL, FPL in one agent
2. **BMAD-Native**: Integrates directly with your BMAD master agent system
3. **Database-Backed**: Queries your existing cheddar.db (no new DBs)
4. **Extensible Tasks**: Each analysis type is a pluggable task
5. **CLI & Scheduled**: Can run interactively or on a timer

## Next Steps (Recommended Order)

### Step 1: Activate the Agent (Now)
```bash
# In Copilot Chat, use the agent selector or:
/bmad-cheddar-health
```

### Step 2: Run `*health-summary` (5 min)
This will:
- Query your card_results for last 30 days
- Calculate overall hit rates by sport
- Show any degradation signals
- Give you baseline metrics

### Step 3: Create a Data Collection Task (15 min)
- Write Node.js wrapper around `packages/data/src/db.js`
- Create `apps/worker/src/jobs/assess-model-health.js`
- Make it idempotent (use job_run logging)
- Add to your scheduler

### Step 4: Build Dashboard Integration (1-2 hours)
- Similar to cheddar-nba-2.0's `export_with_model_health()`
- Output: `_bmad-output/model-health-report.json`
- Optional: Integrate into your web app's `/dashboard`

### Step 5: Set Up Alerts (30 min)
- Add degradation signal detection
- Send alerts when hit rate drops >15pp
- Set up daily/weekly health check emails

## File Structure for Full Implementation

```
_bmad/
├── core/
│   ├── agents/
│   │   └── cheddar-health.md           ← CREATED
│   ├── tasks/
│   │   ├── assess-overall-health.md     ← CREATED
│   │   ├── assess-sport-health.md       ← TO CREATE
│   │   ├── analyze-drivers.md           ← CREATED
│   │   ├── detect-degradation.md        ← TO CREATE
│   │   ├── generate-health-report.md    ← TO CREATE
│   │   └── compare-sports.md            ← TO CREATE
│   └── templates/
│       ├── health-summary-tmpl.md       ← TO CREATE
│       ├── health-details-tmpl.md       ← TO CREATE
│       └── recommendation-report-tmpl.md ← TO CREATE

apps/worker/src/jobs/
└── assess-model-health.js               ← TO CREATE

_bmad-output/
└── model-health-reports/                ← Output destination
```

## Example Output (What You'll Get)

```json
{
  "generatedAt": "2026-02-28T14:30:00Z",
  "lookbackDays": 30,
  "overallStatus": "mostly-healthy",
  "sports": {
    "NBA": {
      "status": "healthy",
      "hitRate": 0.54,
      "totalPredictions": 145,
      "wins": 78,
      "losses": 67,
      "roi": 7.6,
      "currentStreak": "W3",
      "last10HitRate": 0.60,
      "warnings": []
    },
    "NHL": {
      "status": "degraded",
      "hitRate": 0.48,
      "warnings": [
        "Hit rate dropped 8pp in last 10 games",
        "Goalie driver performing poorly (0.42 accuracy)"
      ]
    }
  }
}
```

## Questions to Ask the Agent

When activated, try:

1. **"What's the overall health of my models?"**
2. **"Which sport is performing worst?"**
3. **"Are any drivers underperforming?"**
4. **"What should I fix first?"**
5. **"Compare NBA vs NHL performance"**
6. **"Show me last 10 games trends"**
7. **"Export full health report"**

## Integration with Your Existing Workflow

The agent fits naturally into your current setup:

```bash
# Tab 1: Web App (already running)
npm --prefix web run dev

# Tab 2: Scheduler (already running)
./scripts/start-scheduler.sh

# Tab 3: Health Agent (NEW - optional)
# Run manually or on cron:
npm --prefix apps/worker run job:assess-model-health
# Or: npx copilot-agent-exec cheddar-health --command="health-summary"
```

## Notes on Data Freshness

Your current models emit cards immediately:

- NBA/NHL models: Run hourly + manual
- FPL model: Runs on schedule
- Cards expire 1 hour before game start (per docs)

The health agent uses `card_results` settlement data, which means:

✅ **Accurate**: Settled actual outcomes
⚠️ **Delayed**: Need completed games to measure
⚠️ **Sparse**: Only games that have settled

So the agent works best for:

- Post-game analysis (next day)
- Weekly/monthly reviews
- Multi-week trending
- Not real-time alerts (but we can add those)

## Questions for You

1. **Frequency**: Do you want daily health snapshots, weekly, or manual only?
2. **Alerting**: Should degradation trigger Slack/Discord alerts?
3. **Dashboard**: Should this integrate into your web app or stay in CLI?
4. **Segments**: Which segments matter most (by totals range, by driver, by date)?
5. **Scope**: Monitor only active sports or include archived ones?

---

**Let's activate the agent and see what your current model health looks like!**
