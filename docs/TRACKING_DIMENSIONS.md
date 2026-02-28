# Tracking Dimensions — Performance Analytics Design

## Overview

Defines aggregation dimensions for `tracking_stats` table and dashboard views.

---

## Primary Dimensions

### 1. Sport
- Values: `NHL`, `NBA`, `NFL`, `MLB`, `FPL`, `ALL`
- Use Case: Compare model performance across leagues
- Key Metric: Win rate by sport

### 2. Market Type
- Values: `moneyline`, `spread`, `puck_line`, `total`, `unknown`, `all`
- Use Case: Identify which bet types are most profitable
- Key Metric: Avg P&L per market

### 3. Direction (Prediction)
- Values: `HOME`, `AWAY`, `OVER`, `UNDER`, `all`
- Use Case: Detect home/away bias or total tendencies
- Key Metric: Win rate by direction

### 4. Confidence Tier
- Values: `<60`, `60-70`, `70-80`, `80-90`, `>90`, `all`
- Use Case: Validate confidence calibration
- Key Metric: Actual win rate vs predicted confidence

### 5. Driver (Sport-Specific)
- **NHL:** `goalie`, `specialTeams`, `shotEnvironment`, `emptyNet`, `totalFragility`, `pdoRegression`, `all`
- **NBA:** `restAdvantage`, `travel`, `lineup`, `matchupStyle`, `blowoutRisk`, `all`
- Use Case: Identify strongest/weakest driver signals
- Key Metric: Win rate by driver

### 6. Time Period
- Values: `YYYY-MM` (monthly), `YYYY-Wnn` (weekly), `season-YYYY`, `all-time`
- Use Case: Track performance over time, detect model drift
- Key Metric: Rolling win rate + P&L

---

## Secondary Dimensions (Metadata Filters)

### 7. Inference Source
- Values: `mock`, `remote`
- Use Case: Validate real model vs mock fallback performance
- Key Metric: Win rate comparison

### 8. EV Threshold
- Values: `ev_passed=true`, `ev_passed=false`, `all`
- Use Case: Confirm EV filter improves outcomes
- Key Metric: P&L with vs without EV gate

### 9. Game Context (Future)
- Values: `back_to_back`, `rest_advantage`, `home_stand`, `road_trip`
- Use Case: Detect situational edges
- Key Metric: Win rate in specific contexts

---

## Aggregation Hierarchy

```
Level 1: All Time Summary
  ├─ Sport (NHL/NBA/NFL/MLB)
  │   ├─ Market Type (moneyline/spread/total)
  │   │   ├─ Direction (HOME/AWAY/OVER/UNDER)
  │   │   │   ├─ Confidence Tier (<60/60-70/70-80/80-90/>90)
  │   │   │   │   └─ Driver (goalie/specialTeams/etc)
  │   │   │   └─ Time Period (monthly/weekly/season)
```

**Example stat_key:** `NHL|moneyline|AWAY|70-80|goalie|2026-02`

---

## Computed Metrics

### Win Rate
```sql
win_rate = wins / settled_cards
```

### Average P&L Per Card
```sql
avg_pnl_per_card = total_pnl_units / settled_cards
```

### Confidence Calibration
```sql
confidence_calibration = actual_win_rate - avg_predicted_confidence
```
- **Negative:** Model is overconfident
- **Positive:** Model is underconfident
- **~0:** Well-calibrated

### ROI (Assuming -110 juice)
```sql
roi = ((wins * 0.909) - losses) / settled_cards
```

### Kelly Fraction (Optimal Bet Sizing)
```sql
kelly = (win_rate * avg_win_payout - (1 - win_rate)) / avg_win_payout
```

---

## Dashboard Views

### 1. **Executive Summary**
- All-time totals across all dimensions
- Top 3 performing: sport, market, driver
- Bottom 3 underperforming areas
- Monthly P&L chart

### 2. **Sport Deep Dive**
- Filter: Select sport (NHL/NBA/NFL/MLB)
- Show: Market breakdown, direction bias, confidence calibration
- Chart: Win rate by confidence tier

### 3. **Driver Performance**
- Filter: Select sport + driver
- Show: Win rate, avg P&L, sample size
- Chart: Performance over time (detect drift)

### 4. **Time Series**
- Filter: Rolling window (7d/30d/90d/all)
- Show: Cumulative P&L, rolling win rate
- Chart: Drawdown analysis

### 5. **Confidence Analysis**
- Show: Predicted confidence vs actual win rate (scatter plot)
- Identify: Overconfident ranges (prune future cards)

---

## stat_key Construction

**Format:** `{sport}|{market}|{direction}|{confidence}|{driver}|{period}`

**Examples:**
```
NHL|moneyline|HOME|70-80|goalie|2026-02
NBA|spread|AWAY|60-70|restAdvantage|2026-W08
NFL|total|OVER|>80|all|season-2026
all|all|all|all|all|all-time
```

**Wildcard Rules:**
- `all` at any level aggregates across that dimension
- Dashboard queries filter by splitting stat_key on `|`

---

## Pre-Computation Strategy

### Incremental Updates
```sql
-- After each settlement batch, update affected stat_keys
INSERT OR REPLACE INTO tracking_stats (stat_key, sport, ...)
SELECT 
  sport || '|' || market_type || '|' || direction || '|' || confidence_tier || '|' || 'all' || '|' || 'all-time' AS stat_key,
  sport,
  COUNT(*) AS total_cards,
  SUM(CASE WHEN status='settled' THEN 1 ELSE 0 END) AS settled_cards,
  SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
  SUM(CASE WHEN result='push' THEN 1 ELSE 0 END) AS pushes,
  SUM(pnl_units) AS total_pnl_units,
  ROUND(CAST(SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS REAL) / settled_cards, 4) AS win_rate,
  ROUND(total_pnl_units / settled_cards, 4) AS avg_pnl_per_card
FROM card_results
WHERE settled_at IS NOT NULL
GROUP BY sport, market_type, direction, confidence_tier;
```

**Run Frequency:** After each `settle_cards.js` execution

---

## Query Examples

### Get NHL Moneyline Performance
```sql
SELECT * FROM tracking_stats
WHERE sport = 'NHL' AND market_type = 'moneyline'
ORDER BY total_cards DESC;
```

### Get Top Driver This Month
```sql
SELECT driver_key, win_rate, settled_cards
FROM tracking_stats
WHERE time_period = '2026-02' AND driver_key != 'all'
ORDER BY win_rate DESC
LIMIT 5;
```

### Get Overconfident Ranges
```sql
SELECT confidence_tier, win_rate, confidence_calibration
FROM tracking_stats
WHERE confidence_calibration < -0.05  -- More than 5% overconfident
AND settled_cards > 30  -- Sufficient sample
ORDER BY confidence_calibration ASC;
```

---

## Implementation Checklist

- [ ] Create 009_create_tracking_stats.sql migration
- [ ] Build `compute_tracking_stats.js` job
- [ ] Add incremental update logic (upsert by stat_key)
- [ ] Create dashboard API endpoints:
  - GET /api/tracking/summary
  - GET /api/tracking/sport/{sport}
  - GET /api/tracking/driver/{driver}
- [ ] Add UI components for tracking dashboard
- [ ] Set up nightly cron for full recomputation (data integrity check)

---

## Future Enhancements

### Phase 7+
- Add **bet sizing recommendations** (Kelly fractions)
- Track **bankroll simulation** (what-if analysis)
- Detect **model drift** (alert when win rate drops 10%)
- Add **edge decay** analysis (how long does a driver edge last?)
- Implement **live updating** (WebSocket for real-time P&L)

---

## References

- Confidence Calibration: https://en.wikipedia.org/wiki/Calibration_(statistics)
- Kelly Criterion: https://en.wikipedia.org/wiki/Kelly_criterion
- Sample Size Requirements: Minimum 30 cards per dimension for statistical significance
