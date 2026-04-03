# 07 — Output format

## Rule

Every evaluated pitcher produces a structured projection-only output in a defined template. The template is not optional and is not abbreviated. Every field is populated. If a field cannot be populated, the field states that explicitly and the row remains PASS.

The verdict is the final record of the engine's reasoning. It must be reproducible — given the same inputs, the same verdict must be producible again.

---

## Standard verdict template

```
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

## Leash
[Full / Mod+ / Mod / Short] — [X.X] IP expected
[Flag if applicable: IL return / Extended rest / Org limit]

## Overlays
- Trend: [Positive (+X.Xpp over last 4 starts) / Neutral / Negative / Unscored — reason]
- Ump: [Boost (+X.Xpp K rate, N GP) / Neutral / Suppressor / Unscored — reason]
- BvP: [Boost (X% K rate, N PA, SwStr% confirmed) / Neutral / Unscored — reason]

## Confidence score
[X/10] — [No play / Marginal / Strong / Max]

## Score breakdown
- Block 1 (projection margin): [X/3]
- Block 2 (leash): [X/2]
- Block 3 (overlays): [X/3] — trend [X], ump [X], BvP [X]
- Block 4 (market): [X/1]
- Block 5 (trap clearance): [X/1]
- Penalties: [−X — reason] or [None]
- Net score: [X/10]

## Trap check
[CLEAR — no active flags]
or
[FLAG: category — description]
or
[ENVIRONMENT COMPROMISED — X active flags — scoring suspended]

## Kill-switch check
[None triggered]
or
[TRIGGERED: reason — evaluation halted at Step X]

## Data quality
Projection source: [FULL_MODEL / DEGRADED_MODEL / SYNTHETIC_FALLBACK]
Missing inputs: [list or none]
Reason codes: [list]

## Verdict
PASS
Reason: PASS_PROJECTION_ONLY_NO_MARKET
```

---

## Populated example — full-model PASS verdict

```
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

## Leash
Full — 6.0 IP expected
No flags

## Overlays
- Trend: Positive (+3.2pp K% over last 4 starts vs. prior 4)
- Ump: Neutral (Jordan Baker, +1.8pp K rate, 38 GP — below +3pp threshold)
- BvP: Unscored — combined lineup PA = 22, below 30 PA minimum

## Confidence score
7/10 — Strong

## Score breakdown
- Block 1 (projection margin): 2/3 — margin +0.9K, over tier
- Block 2 (leash): 2/2 — Full leash confirmed
- Block 3 (overlays): 1/3 — trend +1, ump 0, BvP 0
- Block 4 (market): 1/1 — line stable at 7.5 since open
- Block 5 (trap clearance): 1/1 — scan clean
- Penalties: None
- Net score: 7/10

## Trap check
CLEAR — no active flags

## Kill-switch check
None triggered

## Data quality
Projection source: FULL_MODEL
Missing inputs: []
Reason codes: [PASS_PROJECTION_ONLY_NO_MARKET]

## Verdict
PASS
Reason: PASS_PROJECTION_ONLY_NO_MARKET
```

---

## Populated example — degraded PASS verdict

```
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

## Leash
Mod+ — 5.5 IP expected
No flags

## Overlays
- Trend: Neutral (+0.8pp over last 4 starts — below +2pp threshold)
- Ump: Boost (+4.1pp K rate, 44 GP — qualifies)
- BvP: Unscored — lineup not yet confirmed at evaluation time

## Confidence score
6/10 — Marginal

## Score breakdown
- Block 1 (projection margin): 2/3 — margin +0.7K, over tier
- Block 2 (leash): 1.5/2 — Mod+ leash
- Block 3 (overlays): 1/3 — trend 0, ump +1, BvP 0
- Block 4 (market): 1/1 — stable
- Block 5 (trap clearance): 1/1 — scan clean
- Penalties: -0.5 (Mod+ leash rounds to 1.5, applied as written)
- Net score: 6/10

## Trap check
CLEAR — no active flags

## Kill-switch check
None triggered

## Data quality
Projection source: DEGRADED_MODEL
Missing inputs: [starter_swstr_pct]
Reason codes: [PASS_PROJECTION_ONLY_NO_MARKET, DEGRADED_INPUT:starter_swstr_pct]

## Verdict
PASS
Reason: PASS_PROJECTION_ONLY_NO_MARKET
```

---

## Populated example — pass verdict

```
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

## Leash
Full — 6.0 IP expected

## Overlays
- Trend: Positive (+2.8pp over last 4 starts)
- Ump: Boost (+3.9pp K rate, 51 GP)
- BvP: Boost (31% K rate, 41 PA, SwStr% 13.2% confirmed)

## Confidence score
N/A — halted at Step 4

## Score breakdown
- Block 1 (projection margin): 0/3 — projection 8.1 below line 8.5, margin -0.4K
- Scoring halted — margin below floor

## Trap check
Not run — halted at Block 1

## Kill-switch check
None triggered

## Data quality
Projection source: SYNTHETIC_FALLBACK
Missing inputs: [opponent_contact_profile]
Reason codes: [PASS_PROJECTION_ONLY_NO_MARKET, MISSING_INPUT:opponent_contact_profile]

## Verdict
Pass
Reason: PASS_PROJECTION_ONLY_NO_MARKET. No verified line is attached, so this row is research output only.
```

---

## Halted evaluation template

When a kill-switch fires before scoring completes, use this condensed format:

```
## Evaluated
[Pitcher] Ks PASS [PROJECTION_ONLY]

## Status
HALTED — [reason]

Step halted at: [Step number and name]

## Verdict
Pass — [one-sentence reason]
```

---

## Suspended evaluation template

When two or more trap flags fire:

```
## Evaluated
[Pitcher] Ks PASS [PROJECTION_ONLY]

## Status
SUSPENDED — environment compromised

Active trap flags:
- [Flag 1: category — description]
- [Flag 2: category — description]

## Verdict
No play issued — scoring suspended. Log as environment compromised.
```

---

## Output field rules

| Field | Required | Notes |
|-------|----------|-------|
| Pick | Always | Projection-only label, no book/juice |
| Projection | Always | One decimal place |
| Distribution | Always | Include `P(5+)`, `P(6+)`, `P(7+)` |
| Fair thresholds | Always | Research-only over/under thresholds |
| Leash | Always | Include IP expectation and any flags |
| Overlays | Always | All three shown; unscored must state why |
| Data quality | Always | `projection_source`, `missing_inputs`, `reason_codes` |
| Confidence score | Unless halted/suspended | Show tier label |
| Score breakdown | Unless halted/suspended | All five blocks itemized |
| Trap check | Unless halted before Step 5 | All six categories implicitly scanned |
| Kill-switch check | Always | State if none triggered |
| Verdict | Always | One of: Play / Conditional / Pass / Suspended |

---

## Logging requirement

Every completed evaluation — including passes and halted evaluations — must be logged with:

- Date and game
- Pitcher name
- Side and line evaluated
- Projection at time of evaluation
- Verdict issued
- Confidence score (if reached)
- Actual K total (added post-game for tracking)

This log is the truth set for future calibration. See `tests/golden_cases.md` for the historical truth set format.
