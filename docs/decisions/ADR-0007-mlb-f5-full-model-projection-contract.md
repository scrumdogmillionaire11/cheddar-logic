# ADR-0007: MLB F5 full-model projection contract

## Status
Accepted

## Context
MLB F5 totals were previously derived from ERA + WHIP/K9 overlays, and synthetic fallback projections could surface as if they were real plays. That violates the project rule that missing inputs or no edge must not become a promoted card.

## Decision
- Use a starter/matchup/environment F5 model whenever the required inputs are present:
  - starter skill RA9:
    `0.40 * SIERA + 0.35 * xFIP + 0.25 * xERA`, then K%, BB%, HR/9, and GB% adjustments
  - opponent split profile: wRC+, K%, BB%, ISO, xwOBA, hard-hit%, and rolling 14-day wRC+ vs starter handedness
  - environment: park run factor, temperature, wind, roof state
  - leash / exposure: projected starter F5 IP from recent IP + pitch-count average, plus a third-time-through penalty multiplier
- Keep F5 v1 starter-only by default:
  - `team_f5_runs = adjusted_starter_ra9 * (starter_ip_f5_exp / 9)`
  - no bullpen bridge component unless a future WI explicitly adds it
- Keep variance/distribution explicit:
  - use Poisson-style width around the mean for `projected_total_low/high`
- Add a hard projection provenance contract to `mlb-f5` payloads:
  - `projection_source: "FULL_MODEL" | "DEGRADED_MODEL" | "SYNTHETIC_FALLBACK"`
  - `status_cap: "PLAY" | "LEAN" | "PASS"`
  - `projection.projected_total`, `projection.projected_total_low`, `projection.projected_total_high`
  - `projection.projected_home_f5_runs`, `projection.projected_away_f5_runs`
  - `playability.over_playable_at_or_below`, `playability.under_playable_at_or_above`
  - `missing_inputs[]`, `reason_codes[]`, `pass_reason_code`
- Enforce these decision rules:
  - `projection_source="SYNTHETIC_FALLBACK"` => `status=PASS`, `action=PASS`, `ev_passed=false`
  - `projection_source="DEGRADED_MODEL"` => cap display/action at `WATCH` / `LEAN`
  - `abs(model_total - market_line) < 0.5` => emit a visible `PASS` card with `PASS_NO_EDGE`
- Do not use ERA as the projection anchor:
  - synthetic fallback may use weighted SIERA/xFIP/xERA when present, otherwise a neutral floor
  - ERA can remain a display/debug field, but not the primary driver
- Keep MLB F5 in `PROJECTION_ONLY` runtime mode until a later promotion WI explicitly moves the family to `LIVE`.

## Consequences
- No-edge and fallback F5 cards remain visible for operator/user diagnostics, but they are demoted to PASS.
- Full-model F5 output is now explainable and range-aware instead of a single ERA-derived point estimate.
- Historical `mlb-f5` payload rows pre-ADR-0007 may not contain the new fields; the new schema is enforced on writes only.
