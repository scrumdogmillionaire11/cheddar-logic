# Task: Analyze Driver Performance

## Overview

Analyze how individual drivers (decision factors) contribute to model accuracy across all sports.

## Driver Taxonomy by Sport

### NBA
- `rest-advantage`: Rest days differential impact
- `travel-burden`: Road trip vs home game fatigue
- `lineup-status`: Key injured players
- `matchup-style`: Pace/defensive profile matches
- `blowout-risk`: Game script expected to be lopsided

### NHL
- `goalie`: Starter Quality (GAA, SV%)
- `specialTeams`: PP/PK effectiveness
- `shotEnvironment`: Expected shots on goal (xGF)
- `recentForm`: Game results last 5-10 games
- `restAdvantage`: Days since last game

### NCAAM
- `base-projection`: Team strength differential
- `matchup-style`: Pace of play compatibility
- `venue-advantage`: Home court impact (2.5 pt HCA)
- `welcome-home`: Team return from road trip

### NFL
- `powerRating`: Vegas implied team strength
- `restAdvantage`: Days off between games
- `weatherImpact`: Wind, temperature effects
- `injuryStatus`: Star player availability

### FPL
- `bankroll-efficiency`: Budget allocation optimality
- `differential`: Attacking threat vs defensive liabilities
- `fixture-difficulty`: Match difficulty rating
- `form-recency`: Last 5 games performance trend

## Calculation Method

For each driver:

```
performance = {
  hitRate: correct_direction_calls / total_calls,
  calibration: avg_predicted_confidence vs actual_win_pct,
  attribution: impact_weight * (signal_contribution),
  sampleSize: total_decisions_using_driver,
  trend: recent_10_vs_overall_ratio
}
```

## Output Structure

```javascript
{
  "sport": "NBA",
  "lookbackDays": 30,
  "drivers": {
    "rest-advantage": {
      "hitRate": 0.61,
      "sampleSize": 38,
      "avgImpact": 0.145,
      "calibration": "Good",
      "trend": "improving",
      "recommendation": "Increase weight: +5pp"
    },
    "travel-burden": {
      "hitRate": 0.48,
      "sampleSize": 42,
      "avgImpact": -0.082,
      "calibration": "Poor",
      "trend": "degrading",
      "recommendation": "Reduce weight or investigate signal decay"
    }
  },
  "summary": {
    "strongDrivers": ["rest-advantage", "matchup-style"],
    "weakDrivers": ["travel-burden"],
    "recalibrationNeeded": true
  }
}
```

## Degradation Signals for Drivers

Alert if a driver shows:

- Hit rate drops >20pp from historical average
- Calibration mismatch: predicted confidence >> actual performance
- Sample size too small (<20 decisions in period)
- Trend line negative over last 10 decisions
- Correlation with other drivers (may indicate redundancy)

## Next Steps

- Reweight underperforming drivers
- Investigate why specific drivers are trending negative
- Consider removing drivers with persistent low sample size
- Validate signal freshness (data staleness)
