# MLB Full-Game Totals Directionality Guardrails

This document defines the directional hardening contract for MLB full-game totals.

## Problem

A one-sided output mix (for example, mostly UNDER calls) can happen before settlement data is mature enough to judge ROI.
When that happens, we need model-output controls, not settlement-only controls.

## Current Guardrails

- Direction is chosen from shrunk projection deltas, not raw projection deltas.
- Degraded paths are recentered toward the market before shrink is applied.
- Heavily degraded full-game totals are force-passed with `PASS_DEGRADED_TOTAL_MODEL`.
- Full-game totals support two thresholds:
  - Lean threshold: `abs(shrunk_delta) >= 0.75`
  - Fire threshold: `abs(shrunk_delta) >= 1.25` and `FULL_MODEL`
- Each full-game total candidate emits `directional_audit` with raw and shrunk deltas.
- Runner-level directional funnel logging emits raw/shrunk averages plus degraded share.
- Runner emits `DIRECTIONAL_SKEW_ALERT` when side concentration exceeds 80% on a 100+ sample window.

## Directional Audit Shape

```json
{
  "raw_model_total": 7.0,
  "market_total": 9.5,
  "shrunk_model_total": 8.6,
  "proj_minus_line_raw": -2.5,
  "proj_minus_line_shrunk": -0.9,
  "degraded_inputs_count": 3,
  "degraded_mode": true,
  "direction_before_shrink": "UNDER",
  "direction_after_shrink": "UNDER"
}
```

## Operational Expectations

1. If degraded share is high, expect more `PASS_DEGRADED_TOTAL_MODEL` and fewer official plays.
2. If directional skew remains extreme after these guards, inspect upstream feature quality and fallback assumptions.
3. Do not tune ROI thresholds from tiny settled samples; use directional diagnostics first.
