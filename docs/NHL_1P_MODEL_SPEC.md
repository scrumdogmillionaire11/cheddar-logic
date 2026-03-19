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
Phase 2 adds market-aware fair probability output behind an explicit env gate.

### Phase 2 Env vars

| Variable | Default | Description |
| --- | --- | --- |
| `NHL_1P_FAIR_PROB_PHASE2` | `false` | Enable fair probability math. Requires stable real 1P line supply. |
| `NHL_1P_SIGMA` | `1.26` | Normal CDF sigma parameter (spec range: 1.22–1.30). |

### Phase 2 Math

```text
mu = final_1p_projection
P(over 1.5)  = 1 - CDF(1.5, mu, sigma_1p)
P(under 1.5) = CDF(1.5, mu, sigma_1p)
```

### Market-line prerequisite

Fair probabilities are computed **only** when `oddsSnapshot.total_1p` is a real number
(i.e. the odds snapshot carries a confirmed real 1P market line, not just the fixed `1.5`
reference). If `total_1p` is absent or not a number, gate output falls back to Phase-1
null behavior regardless of `NHL_1P_FAIR_PROB_PHASE2`.

### Protected invariants

| Condition | Output |
| --- | --- |
| Gate disabled (`NHL_1P_FAIR_PROB_PHASE2=false`) | `fair_over_1_5_prob: null`, `fair_under_1_5_prob: null` |
| Gate enabled but `total_1p` absent | null (market-line prerequisite guard) |
| Gate enabled, `total_1p` present, classification is `PASS` (dead-zone) | null |
| Gate enabled, `total_1p` present, either goalie is `UNKNOWN` (goalie-uncertain cap) | null |
| Gate enabled, `total_1p` present, eligible classification | finite probabilities in (0, 1) |

**PASS records always stay null regardless of gate.** The `NHL_1P_PASS_DEAD_ZONE` and
`NHL_1P_GOALIE_UNCERTAIN` protections from Phase-1 remain fully active.

### Rollback

Set `NHL_1P_FAIR_PROB_PHASE2=false` and redeploy. No DB migration or schema change
is needed — the fields default to null and existing records are unaffected.
