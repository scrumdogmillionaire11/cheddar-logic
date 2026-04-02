# ADR-0007: MLB F5 full-model projection contract

## Status
Accepted

## Context
MLB F5 totals were previously derived from ERA + WHIP/K9 overlays, and synthetic fallback projections could surface as if they were real plays. That violates the project rule that missing inputs or no edge must not become a promoted card.

## Decision
- Use a starter/matchup/environment F5 model whenever the required inputs are present:
  - starter skill: `x_fip` (or `siera`) plus K%, BB%, HR/9 adjustments
  - opponent split profile: wRC+, K%, ISO vs starter handedness
  - environment: park run factor, temperature, wind
- Add a hard projection provenance contract to `mlb-f5` payloads:
  - `projection_source: "FULL_MODEL" | "SYNTHETIC_FALLBACK"`
  - `projection.projected_total`, `projection.projected_total_low`, `projection.projected_total_high`
  - `projection.projected_home_f5_runs`, `projection.projected_away_f5_runs`
  - `playability.over_playable_at_or_below`, `playability.under_playable_at_or_above`
  - `missing_inputs[]`, `reason_codes[]`, `pass_reason_code`
- Enforce these decision rules:
  - `projection_source="SYNTHETIC_FALLBACK"` => `status=PASS`, `action=PASS`, `ev_passed=false`
  - `abs(model_total - market_line) < 0.5` => emit a visible `PASS` card with `PASS_NO_EDGE`
- Keep MLB F5 in `PROJECTION_ONLY` runtime mode until a later promotion WI explicitly moves the family to `LIVE`.

## Consequences
- No-edge and fallback F5 cards remain visible for operator/user diagnostics, but they are demoted to PASS.
- Full-model F5 output is now explainable and range-aware instead of a single ERA-derived point estimate.
- Historical `mlb-f5` payload rows pre-ADR-0007 may not contain the new fields; the new schema is enforced on writes only.

