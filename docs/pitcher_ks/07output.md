# 07 — Output format

## Rule

Every evaluated prop produces a structured verdict in a defined template. The template is not optional and is not abbreviated. Every field is populated. If a field cannot be populated (e.g., BvP unscored due to lineup not confirmed), the field states that explicitly — it is not omitted.

The verdict is the final record of the engine's reasoning. It must be reproducible — given the same inputs, the same verdict must be producible again.

---

## Standard verdict template

```
## Pick
[Pitcher full name] [o/u][line] Ks — [Book] [Juice]

## Projection
[X.X] Ks

## Margin
[+X.X] Ks ([side] edge)

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

## Verdict
[Play / Conditional play / Pass]

[If Play or Conditional:]
Side: [Over / Under]
Line: [X.X] at [Book]
Confidence: [X/10]
[HIGH VIG] if applicable

[If Pass:]
Reason: [specific reason — thin margin / leash / trap / confidence below floor]
```

---

## Populated example — play verdict

```
## Pick
Corbin Burnes o7.5 Ks — DraftKings -115

## Projection
8.4 Ks

## Margin
+0.9 Ks (over edge)

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

## Verdict
Play
Side: Over
Line: o7.5 at DraftKings -115
Confidence: 7/10
```

---

## Populated example — conditional play verdict

```
## Pick
Logan Webb o5.5 Ks — FanDuel -120

## Projection
6.2 Ks

## Margin
+0.7 Ks (over edge)

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

## Verdict
Conditional play
Side: Over
Line: o5.5 at FanDuel -120
Confidence: 6/10
Condition: Play only if lineup confirms no absence of high-K bats (Soler, Chapman). Re-run BvP if confirmed.
Note: Marginal tier. Line must remain at 5.5 or better at time of play.
```

---

## Populated example — pass verdict

```
## Pick
[Evaluated: Zack Wheeler o8.5 Ks — DraftKings -110]

## Projection
8.1 Ks

## Margin
-0.4 Ks (under the line — no over edge)

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
TRIGGERED: Block 1 = 0 — projection below line. No margin. Evaluation halted at Step 4.

## Verdict
Pass
Reason: No projection margin. Wheeler projected at 8.1, line set at 8.5. Overlays and leash are both favorable but the number is not there. Do not play the over. Under would require projection of 7.75 or below to clear the under floor — projection does not support that either. No play on either side.
```

---

## Halted evaluation template

When a kill-switch fires before scoring completes, use this condensed format:

```
## Evaluated
[Pitcher] [side][line] — [Book]

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
[Pitcher] [side][line] — [Book]

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
| Pick | Always | Include book and juice |
| Projection | Always | One decimal place |
| Margin | Always | Show +/- and label side |
| Leash | Always | Include IP expectation and any flags |
| Overlays | Always | All three shown; unscored must state why |
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