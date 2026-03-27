# PLAY vs LEAN Tier Audit — March 2026

**Work Item:** WI-0589  
**Generated:** 2026-03-27T11:17:52.993Z  
**DB:** `/Users/ajcolubiale/projects/cheddar-logic/packages/data/cheddar.db`  
**Sample window:** 2026-03-13T11:17:52.993Z -> 2026-03-27T11:17:52.993Z  
**Report command:** `npm --prefix apps/worker run job:report-telemetry-calibration -- --days 14`

## Summary

- This WI adds an explicit `PLAY` cleanliness ceiling for targeted priced wave-1 markets in `NBA` and `NHL`.
- `PLAY` can now be capped to `LEAN` when the row is not fully fresh/clean even if edge and support clear the raw `PLAY` thresholds.
- `report_telemetry_calibration` now emits a `decision_tier_audit` section so recent settled `PLAY` vs `LEAN` performance is visible in both JSON and text output.
- The current 14-day sample still does **not** satisfy the WI outcome target. `PLAY` is worse than `LEAN` on both win rate and ROI, so the WI should remain operationally open until further tightening or a refreshed post-change sample proves the ordering has flipped.

## Before / After

### Before this change

- `PLAY` vs `LEAN` was decided only by edge/support thresholds plus existing hard invalidation paths.
- `CAUTION` freshness and high contradiction could reduce confidence math but still leave a row actionable at the top tier.
- Telemetry had no dedicated settled `PLAY` vs `LEAN` section.

### After this change

- `PLAY` is capped to `LEAN` for targeted priced `NBA`/`NHL` wave-1 markets when:
  - `watchdog_status !== 'OK'` -> `PLAY_REQUIRES_FRESH_MARKET`
  - `conflict_score > 0.30` -> `PLAY_CONTRADICTION_CAPPED`
- Existing proxy behavior remains in force through `PROXY_EDGE_CAPPED`.
- Existing NBA totals quarantine remains in force and still demotes actionable NBA totals one level after the cleanliness logic runs.
- Telemetry now reports settled `PLAY` and `LEAN` outcomes in a dedicated `decision_tier_audit` section.

## Current 14-Day Decision Tier Audit

| Tier | Rows | W-L-P | Win Rate | Total PnL | Avg PnL/Card | ROI |
|------|------|-------|----------|-----------|--------------|-----|
| PLAY | 116 | 58-58-0 | 50.00% | -7.161u | -0.062u | -6.17% |
| LEAN | 199 | 117-82-0 | 58.79% | 22.347u | 0.112u | 11.23% |

## Operational Read

- The logic change is implemented and verified by focused worker regressions plus the telemetry audit output.
- The current database sample still shows `PLAY` underperforming `LEAN`.
- Treat this as a successful instrumentation and guardrail landing, not as final closeout evidence for the WI acceptance target.

## Downgrade Paths Added

- `PLAY_REQUIRES_FRESH_MARKET`
  - Used when a targeted `PLAY` candidate is only `CAUTION` freshness, not fully `OK`.
- `PLAY_CONTRADICTION_CAPPED`
  - Used when a targeted `PLAY` candidate has `conflict_score > 0.30`.
- `PROXY_EDGE_CAPPED`
  - Existing cap retained; proxy-backed rows still cannot resolve to clean top-tier `PLAY`.

## Verification

- `npm --prefix apps/worker test -- src/utils/__tests__/decision-publisher.v2.test.js src/jobs/__tests__/report_telemetry_calibration.test.js`
- `npm --prefix apps/worker run job:report-telemetry-calibration -- --days 14`
- `npm --prefix web run test:card-decision`
- `npm --prefix web run test:decision:canonical`
