# SOG V1 vs V2 Mu Calibration Study — March 2026

**Generated:** 2026-03-24T01:30:23.728Z
**DB:** /tmp/test-calibrate.db
**Window:** Last 90 days

> **Note:** No settled data available in this environment. Run with `CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db node scripts/calibrate_sog_v1_v2.js` to populate with real data.

## Summary

| Metric | V1 (recency-decay) | V2 (rate-weighted Poisson) |
|--------|-------------------|---------------------------|
| Cards analyzed | 0 | 0 |
| MAE | N/A | N/A |
| Skipped (missing data) | 0 | — |

## Calibration Table — V1

Bucket = floor(mu_v1 - line, 1 decimal). Win rate = fraction of settled cards
where the bet won.

| Edge Bucket | N | Win Rate | Notes |
|-------------|---|----------|-------|
| — | — | — | No data |


## Calibration Table — V2

| Edge Bucket | N | Win Rate | Notes |
|-------------|---|----------|-------|
| — | — | — | No data |


## Recommendation

**More accurate model:** insufficient data to determine
**Basis:** MAE V1=N/A, MAE V2=N/A

**Proposed EDGE_MIN (V1):** insufficient data
**Basis:** No bucket with N >= 10 and win_rate >= 55% found. Recommend re-running after 30+ more settled cards.

**Proposed EDGE_MIN (V2):** insufficient data
**Basis:** No bucket with N >= 10 and win_rate >= 55% found. Recommend re-running after 30+ more settled cards.

## Methodology

- Data source: card_payloads JOIN card_results (status=settled, result=win|loss) JOIN game_results
- V1 mu: payload_data.decision.projection
- V2 mu: payload_data.decision.v2.sog_mu (only cards where non-null)
- Actual SOG: game_results.metadata.playerShots.fullGameByPlayerId[player_id]
- Bucketing: floor((mu - line) * 10) / 10 (0.1 SOG increments)
- Win rate threshold for EDGE_MIN: 55% with N >= 10
