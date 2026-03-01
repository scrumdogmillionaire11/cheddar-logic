# Task: Assess Overall Model Health

## Overview

Generate a comprehensive snapshot of model health across all sports (NBA, NHL, NCAAM, NFL, FPL).

## Data Sources

- `card_results` table: outcome tracking (win/loss/push)
- `card_payloads` table: confidence scores, prediction metadata
- `game_results` table: actual game outcomes
- `model_outputs` table: model inference metadata

## Metrics to Calculate

### Per-Sport Summary

For each sport, calculate over a 30-day rolling window (customizable):

| Metric            | Calculation                                  | Meaning                |
| ---               | ---                                          | ---                    |
| Hit Rate          | Correct predictions / Total predictions      | % of correct bets      |
| Total Predictions | COUNT(DISTINCT card_id)                      | Sample size            |
| W-L Records       | Win, loss, push counts                       | Outcome distribution   |
| ROI               | (wins - losses) / total * 100                | Profitability (units)  |
| Avg Confidence    | AVG(confidence) from card_payloads           | Mean predicted quality |
| Current Streak    | Last consecutive W or L sequence             | Momentum               |
| Last 10 Hit Rate  | Last 10 games accuracy                       | Recent performance     |

### Status Assignment

```text
✅ HEALTHY    → hit_rate >= 0.52 AND no degradation signals
⚠️  DEGRADED  → hit_rate 0.45-0.52 OR recent downtrend
🚨 STALE      → lastUpdated > 90 minutes old
❌ CRITICAL   → hit_rate < 0.45 OR cascading failures
```

## Output Structure

```javascript
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
      "pushes": 0,
      "roi": 7.6,
      "avgConfidence": 0.62,
      "currentStreak": "W3",
      "last10HitRate": 0.60,
      "degradationSignals": [],
      "warnings": [],
      "lastUpdated": "2026-02-28T14:28:00Z"
    }
  }
}
```

## Execution Steps

1. Connect to database (`packages/data/src/db.js`)
2. For each sport (NBA, NHL, NCAAM, NFL, FPL):
   - Query `card_results` + `card_payloads` for last 30 days
   - Calculate core metrics (hit rate, ROI, streak)
   - Detect degradation signals
   - Assign status
3. Aggregate cross-sport summary
4. Output structured JSON report

## Degradation Signal Thresholds

Flag a warning if ANY of these occur:

- Hit rate drops >15 percentage points vs 30-day average
- Streak reverses unexpectedly (W5 → L3)
- ROI flips negative in last 10 games
- Confidence drops >0.10 while hit rate declining
- No predictions in last 6 hours (stale data)

## Related Tasks

- `assess-sport-health.md` — Deep dive on single sport
- `detect-degradation.md` — Focused anomaly analysis
- `trending.md` — Historical trend calculation

