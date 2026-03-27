# NBA Totals Calibration Diagnostic — March 2026

**Generated:** 2026-03-27T01:48:57.981Z
**DB:** /Users/ajcolubiale/projects/cheddar-logic/packages/data/cheddar.db
**Sample window:** 2026-03-16T12:14:35.630Z -> 2026-03-25T01:30:20.276Z

## Summary

| Metric | Value |
|--------|-------|
| Settled rows matched | 100 |
| Usable rows analyzed | 100 |
| Dropped rows | 0 |
| Mean bias (projected_total - actual_total) | 9.260 |
| Median bias (projected_total - actual_total) | 11.500 |
| MAE | 17.220 |
| RMSE | 20.632 |
| Current sigma | 14.0 |
| Empirical sigma | 14.000 |
| Sigma source | fallback |
| Sigma games sampled | n/a |

## Data Quality

- none

## Over/Under Split

| Side | Rows | W-L-P | Win Rate | Units | ROI | Mean Bias | MAE | Avg Edge |
|------|------|-------|----------|-------|-----|-----------|-----|----------|
| OVER | 96 | 63-33-0 | 65.6% | 23.93u | 24.9% | 10.95 | 16.64 | 29.04% |
| UNDER | 4 | 0-4-0 | 0.0% | -4.00u | -100.0% | -31.20 | 31.20 | 25.37% |

## Edge Buckets

| Edge Bucket | Rows | W-L-P | Win Rate | Units | ROI | Mean Bias |
|-------------|------|-------|----------|-------|-----|-----------|
| <1% | 0 | 0-0-0 | n/a | 0.00u | n/a | n/a |
| 1-2% | 0 | 0-0-0 | n/a | 0.00u | n/a | n/a |
| 2-4% | 0 | 0-0-0 | n/a | 0.00u | n/a | n/a |
| 4%+ | 100 | 63-37-0 | 63.0% | 19.93u | 19.9% | 9.26 |

## Sigma Sensitivity

Current thresholds use NBA TOTAL support 0.470/0.580 and edge 3.1%/6.2% for LEAN/PLAY.

| Mapping | Sigma | Avg p_fair | Avg Edge | LEAN+ Count | PLAY Count |
|---------|-------|------------|----------|-------------|------------|
| current_sigma_14 | 14.000 | 0.8160 | 29.08% | 100 | 100 |
| empirical_sigma | 14.000 | 0.8160 | 29.08% | 100 | 100 |

Threshold classification changed on 0/100 rows (0.0%).

## Recommendation

Final recommendation: model biased

Absolute mean bias 9.260 meets or exceeds 2.0 points.

## Decision Impact

WI-0589 gate: Hold

WI-0589 remains blocked until the model-bias or sigma-sensitivity issue is resolved, or the sample grows large enough.

## Methodology

- Source rows: latest 100 settled nba-totals-call rows by card_results.settled_at DESC, or all available if fewer.
- Tables: card_payloads + card_results + game_results.
- Filters: cp.sport='nba', cp.card_type='nba-totals-call', cr.status='settled', cr.market_type='TOTAL', gr.status='final'.
- Field priority:
  - projected total: payload.projection.total -> payload.market_context.projection.total -> payload.projection.projected_total
  - selection: card_results.selection -> payload.selection.side -> payload.prediction
  - line: card_results.line -> payload.line
  - price: card_results.locked_price -> pick-side payload price
  - edge: payload.edge_pct -> payload.edge
  - actual total: game_results.final_score_home + game_results.final_score_away
- Pushes stay in sample counts and ROI denominator, but are excluded from win-rate denominators and count as 0.0 units.
