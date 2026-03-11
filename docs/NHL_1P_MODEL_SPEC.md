# NHL 1P Model Spec (WI-0385)

## Objective
Replace legacy NHL first-period projection logic with a pass-first, de-biased model that emits explicit classification and reason codes.

## Phase 1 Scope
- Projection + classification only
- Explicit dead-zone PASS behavior
- Goalie uncertainty caps actionability
- No priced 1P market output (fair probabilities remain `null`)

## Formula

```text
base_1p = 0.18 + 0.275 * full_game_total_model

pace_1p_adj = clamp(first_period_pace_score, -0.12, 0.12)
special_teams_1p_adj = clamp(first_period_penalty_pressure_score, -0.08, 0.08)
goalie_1p_adj = clamp(raw_goalie_1p_delta * goalie_certainty_multiplier, -0.10, 0.10)
rest_1p_adj = clamp(first_period_rest_delta, -0.05, 0.05)

total_adj = clamp(
  pace_1p_adj + special_teams_1p_adj + goalie_1p_adj + rest_1p_adj,
  -0.18,
  0.18
)

raw_1p_projection = base_1p + total_adj
final_1p_projection = clamp(raw_1p_projection, 1.20, 2.25)
```

## Classification Bands

| Projection | Classification |
|---|---|
| `<= 1.42` | `BEST_UNDER` |
| `1.43–1.50` | `PLAY_UNDER` |
| `1.51–1.58` | `LEAN_UNDER` |
| `1.59–1.99` | `PASS` |
| `2.00–2.14` | `LEAN_OVER` |
| `2.15–2.24` | `PLAY_OVER` |
| `>= 2.25` | `BEST_OVER` |

## Goalie Certainty Policy

```text
CONFIRMED = 1.0
EXPECTED  = 0.6
UNKNOWN   = 0.0
```

- If either goalie is `UNKNOWN`, classification is capped to `PASS`.
- Confidence labels:
  - `HIGH`: both confirmed
  - `MEDIUM`: no unknown, at least one expected
  - `LOW`: either unknown

## Required Reason Codes
- `NHL_1P_PASS_DEAD_ZONE`
- `NHL_1P_OVER_LEAN`
- `NHL_1P_OVER_PLAY`
- `NHL_1P_OVER_BEST`
- `NHL_1P_UNDER_LEAN`
- `NHL_1P_UNDER_PLAY`
- `NHL_1P_UNDER_BEST`
- `NHL_1P_GOALIE_UNCERTAIN`
- `NHL_1P_CLAMP_LOW`
- `NHL_1P_CLAMP_HIGH`
- `NHL_1P_MODEL_HOT_CAP`

## Invariants
- No fixed `30%` transform path for active 1P projection
- No legacy `[1.4, 2.4]` rail
- Projection delta vs `1.5` is telemetry only
- PASS must be explicit when dead-zone/uncertain
- 1P output remains projection-only in Phase 1

## Phase 2 Boundary
Phase 2 may add market-aware fair probability output:

```text
mu = projection_final
sigma_1p = 1.22 to 1.30
P(over 1.5)  = 1 - CDF(1.5, mu, sigma_1p)
P(under 1.5) = CDF(1.5, mu, sigma_1p)
```

This is intentionally not active in Phase 1.