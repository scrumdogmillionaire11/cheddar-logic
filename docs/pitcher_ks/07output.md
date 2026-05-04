# 07 — Output format

## Rule

Every evaluated pitcher produces a structured projection-only output. The row is always `PASS`; the informative surface is the projection package plus a posture label.

The output is intentionally limited to:

- projected strikeouts
- fair ladder probabilities
- projection quality / missing-input diagnostics
- posture label derived from baseline K skill, opponent K factor, and projected innings
- trap diagnostics / availability visibility

No line, price, margin, or executable `PLAY` state appears unless a future user-provided price contract is introduced.

---

## Standard template

```text
## Pick
[Pitcher full name] Ks PASS [PROJECTION_ONLY]

## Projection
[X.X] Ks

## Distribution
P(5+)=[x.xx]
P(6+)=[x.xx]
P(7+)=[x.xx]

## Fair thresholds
Over playable at <= [x.x]
Under playable at >= [x.x]

## Posture
[OVER_CANDIDATE / UNDER_CANDIDATE / UNDER_LEAN_ONLY / NO_EDGE_ZONE / TRAP_FLAGGED / DATA_UNTRUSTED]

## Posture inputs
- Pitcher K baseline: [OVER_SUPPORT / UNDER_SUPPORT / NEUTRAL]
- Opponent K factor: [OVER_SUPPORT / UNDER_SUPPORT / NEUTRAL]
- Projected innings bucket: [OVER_SUPPORT / UNDER_SUPPORT / NEUTRAL]

## Data quality
Projection source: [FULL_MODEL / DEGRADED_MODEL / SYNTHETIC_FALLBACK]
Missing inputs: [list or none]
Reason codes: [list]

## Trap diagnostics
- trap_inputs_present: [sorted keys]
- trap_inputs_missing: [sorted keys]
- trap_flags: [sorted emitted flags]
- confidence_cap_reason: null
- opp_k_bucket: [LOW_K / MID_K / HIGH_K / UNKNOWN]
- leash_bucket: [SHORT / STANDARD / LONG / UNKNOWN]
- name_risk_proxy: [CLEAR / AMBIGUOUS / UNKNOWN]
- projection_band: [LOW / MID / HIGH / OUTSIDE_STATIC_BAND / UNKNOWN]
- opp_k_volatility: [LOW / MID / HIGH / UNKNOWN]
- opp_profile_staleness: [FRESH / STALE / STATIC_FALLBACK / UNKNOWN]

## Verdict
PASS
Reason: PASS_PROJECTION_ONLY_NO_MARKET
```

---

## Example — over candidate

```text
## Pick
Corbin Burnes Ks PASS [PROJECTION_ONLY]

## Projection
8.4 Ks

## Distribution
P(5+)=0.90
P(6+)=0.80
P(7+)=0.68

## Fair thresholds
Over playable at <= 7.5
Under playable at >= 8.5

## Posture
OVER_CANDIDATE

## Posture inputs
- Pitcher K baseline: OVER_SUPPORT
- Opponent K factor: OVER_SUPPORT
- Projected innings bucket: OVER_SUPPORT

## Data quality
Projection source: FULL_MODEL
Missing inputs: []
Reason codes: [PASS_PROJECTION_ONLY_NO_MARKET]

## Verdict
PASS
Reason: PASS_PROJECTION_ONLY_NO_MARKET
```

---

## Example — under lean only

```text
## Pick
Logan Webb Ks PASS [PROJECTION_ONLY]

## Projection
6.2 Ks

## Distribution
P(5+)=0.73
P(6+)=0.57
P(7+)=0.40

## Fair thresholds
Over playable at <= 5.5
Under playable at >= 6.5

## Posture
UNDER_LEAN_ONLY

## Posture inputs
- Pitcher K baseline: UNDER_SUPPORT
- Opponent K factor: UNDER_SUPPORT
- Projected innings bucket: OVER_SUPPORT

## Data quality
Projection source: DEGRADED_MODEL
Missing inputs: [starter_swstr_pct]
Reason codes: [PASS_PROJECTION_ONLY_NO_MARKET, DEGRADED_INPUT:starter_swstr_pct]

## Verdict
PASS
Reason: PASS_PROJECTION_ONLY_NO_MARKET
```

---

## Example — data untrusted

```text
## Pick
Zack Wheeler Ks PASS [PROJECTION_ONLY]

## Projection
8.1 Ks

## Distribution
P(5+)=0.86
P(6+)=0.72
P(7+)=0.55

## Fair thresholds
Over playable at <= 7.5
Under playable at >= 8.5

## Posture
DATA_UNTRUSTED

## Posture inputs
- Pitcher K baseline: UNKNOWN
- Opponent K factor: NEUTRAL
- Projected innings bucket: NEUTRAL

## Data quality
Projection source: SYNTHETIC_FALLBACK
Missing inputs: [opponent_contact_profile]
Reason codes: [PASS_PROJECTION_ONLY_NO_MARKET, PASS_MISSING_DRIVER_INPUTS]

## Verdict
PASS
Reason: PASS_PROJECTION_ONLY_NO_MARKET
```
