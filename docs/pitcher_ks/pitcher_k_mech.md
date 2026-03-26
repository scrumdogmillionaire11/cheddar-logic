# Confidence mechanism — Sharp Cheddar K engine

## Why not CLV for props

Prop markets are illiquid. There is no true market-making book. Sharp money moves prop lines disproportionately, making the market less efficient than game markets. CLV is a comfort in this context, not a signal. Confidence has to come from stacked internal inputs, not from line movement validating the pick.

---

## The scoring model — 5 independent signal blocks

Maximum raw score: **10 points** before penalties.

---

### Block 1 — Projection quality (0–3 pts)

| Score | Condition |
|-------|-----------|
| **3 pts** | Margin >1.0K over, or >1.5K under |
| **2 pts** | Margin 0.75–1.0K over, or 1.0–1.5K under |
| **1 pt** | Margin 0.5–0.74K over, or 0.75–1.0K under |
| **0 pts** | Margin below floor — do not continue scoring |

> Under requires bigger margin at every tier because books price over-bias in. The asymmetric threshold is intentional and reflects real market structure.
>
> **Block 1 = 0 is an automatic kill-switch. Stop scoring. No play.**

---

### Block 2 — Leash integrity (0–2 pts)

| Score | Condition |
|-------|-----------|
| **2 pts** | Full leash — 90+ pitches in 2 of last 3 starts |
| **1.5 pts** | Mod+ leash — consistent workload, minor recent dip |
| **1 pt** | Mod leash — recent pitch count volatility |
| **0 pts** | Short leash, IL flag, or extended rest |

> Leash = 0 on an over is an automatic kill-switch. The ceiling on IP is structural and no overlay or market edge recovers it.
>
> IL / extended rest is not a leash tier — it is a structural ceiling flag. Kill the over outright; do not score the rest of the blocks.

---

### Block 3 — Overlay alignment (0–3 pts)

Each sub-signal scores independently. All require a qualifying sample to score. No sample = 0 pts. No exceptions.

#### Trend (0–1 pt)

| Score | Condition |
|-------|-----------|
| **1 pt** | K% delta >2 percentage points over last 4 starts vs. prior 4-start window |
| **0 pts** | Flat, declining, or fewer than 4 starts in window |

#### Umpire (0–1 pt)

| Score | Condition |
|-------|-----------|
| **1 pt** | Ump K rate >+3% vs. league average, minimum 30 GP sample |
| **0 pts** | Neutral, negative, or sample below 30 GP |

> A bad ump does not score -1 here. An unfavorable ump is a trap flag (Block 5 / trap scan), not a confidence deduction.

#### BvP (0–1 pt)

| Score | Condition |
|-------|-----------|
| **1 pt** | 30+ PA sample, pitcher K rate vs. this lineup >28%, AND SwStr% crosscheck confirms |
| **0 pts** | Sample <30 PA, or SwStr% does not support the historical rate |

> The SwStr% crosscheck kills false positives where a historical BvP rate existed under a different pitch mix or velocity profile. If the stuff has changed, the sample is stale.

---

### Block 4 — Market structure (0–1 pt)

| Score | Condition |
|-------|-----------|
| **1 pt** | Line stable or moved in your direction from open. No suspect counter-steam. |
| **0 pts** | Line moved against you after open, or significant counter-steam present |

> This is not a CLV calculation. Prop CLV cannot be trusted in illiquid markets. This is a directional sanity check only — confirming the market is not actively signaling against the play.

---

### Block 5 — Trap clearance (0–1 pt)

| Score | Condition |
|-------|-----------|
| **1 pt** | Trap scan returns no active flags |
| **0 pts** | Any active trap flag present |

> Active trap flags include: hidden role risk (bulk opener / opener swing), lineup context miss, unfavorable handedness concentration, weather impact, public bait line.
>
> One trap flag = 0 pts on this block.
> Two or more trap flags = full play kill. Score is suspended entirely. This is not a 0 — the play is unscoreable because the environment is compromised.

---

## Penalty system — score deductions

Applied after raw score is calculated. Penalties can pull a play from Strong to Marginal or from Marginal to No Play.

| Penalty | Condition |
|---------|-----------|
| **-2 pts** | Contact-heavy lineup vs. projection — opp K% vs. pitcher handedness <18% last 30 days. Projection is likely inflated. |
| **-2 pts** | Velocity drop signal — pitcher velo down >1.5 mph over last 3 starts vs. season average. K/9 hasn't caught up yet — it will. |
| **-1 pt** | Unfavorable handedness split — lineup stacked opposite-hand to pitcher's primary weapon, no edge in BvP breakdown |
| **-1 pt** | Park factor headwind — park suppresses K environment (e.g. Coors, Great American Ball Park). Not a trap, but a structural headwind. |
| **-1 pt** | High-chase-rate batter absent — a high-chase bat the projection assumed is not in the confirmed lineup. Projected K count loses a floor plate appearance. |

---

## Confidence tiers

| Net score | Tier | Verdict |
|-----------|------|---------|
| **0–4** | No play | Signal insufficient. Pass without hesitation. |
| **5–6** | Marginal | Edge present but thin. Only play if line is favorable and margin is at the top of its tier. |
| **7–8** | Strong | Multiple confirming signals. Core play. |
| **9–10** | Max | All 5 blocks fire, no penalties. Rare. Handle with discipline. |

---

## Kill-switch override rules

These override the scoring entirely. No verdict is issued when a kill-switch fires.

| Trigger | Action |
|---------|--------|
| Block 1 = 0 pts | Stop scoring immediately. No play. |
| Block 2 = 0 pts on an over | Stop scoring immediately. Structural ceiling present. No play. |
| IL flag / extended rest (over) | Kill the over outright. Do not score. |
| Two or more active trap flags | Score suspended. Play is unscoreable. Log as environment compromised. |
| Penalties bring net score below 5 | Play enters marginal zone. Re-evaluate line and margin before committing. This is a warning, not a kill. |

---

## Worked example

**Pitcher:** Example starter, over 7.5 Ks

| Block | Inputs | Score |
|-------|--------|-------|
| Block 1 — projection margin | Over, +0.9K margin | **2 / 3** |
| Block 2 — leash | Full leash, 90+ pitches in 2 of last 3 | **2 / 2** |
| Block 3 — overlays | Trend positive, ump neutral, BvP sample <30 PA | **1 / 3** |
| Block 4 — market | Line stable since open | **1 / 1** |
| Block 5 — trap clearance | Scan clean | **1 / 1** |
| Penalty — park factor | Mild K-suppression environment | **-1** |
| **Net score** | | **6 / 10** |

**Tier: Marginal.** Play only if line is favorable and margin sits at the top of the 2-pt tier. If the line has moved against you since open, pass.

---

## Output template integration

The confidence score feeds directly into the verdict block:

```
## Confidence score
6 / 10 — Marginal

## Score breakdown
- Block 1 (projection): 2/3
- Block 2 (leash): 2/2
- Block 3 (overlays): 1/3 — trend +1, ump 0, BvP 0 (small sample)
- Block 4 (market): 1/1
- Block 5 (trap): 1/1
- Penalty (park): -1

## Kill-switch check
None triggered.

## Verdict
Conditional play — line must be favorable. Pass if margin has compressed since projection.
```

---

## Rule · Why it exists · Program interpretation

### Block 1 margin floors

**Rule:** Over minimum margin 0.5K. Under minimum margin 0.75K.

**Why it exists:** Books price slight over-bias into strikeout props because the public leans over. The under needs a larger margin to compensate for that structural disadvantage.

**Program interpretation:** Calculate `projection - line`. If result < floor for side, return `Block1 = 0`. Halt scoring.

---

### Block 2 IL / extended rest flag

**Rule:** IL flag or return from 10+ day absence kills the over regardless of pitch count history.

**Why it exists:** A pitcher returning from IL operates under an organizational pitch limit that does not appear in recent pitch count data. The leash is a structural ceiling, not a tier.

**Program interpretation:** Check `pitcher_status`. If `IL_return == True` or `days_rest >= 10`, return `leash_flag = KILL`. Do not score Block 2. Halt scoring for overs.

---

### Block 3 trend window

**Rule:** Trend scores only if K% delta >2pp over a minimum 4-start window vs. the prior 4-start window.

**Why it exists:** A 1–2 start hot streak is noise. A 4-start directional shift with a measurable delta is signal.

**Program interpretation:** Compute `k_pct_last4 - k_pct_prior4`. If delta > 0.02 and both windows have >= 4 starts, return `trend_score = 1`. Else return `trend_score = 0`.

---

### Block 3 BvP SwStr% crosscheck

**Rule:** Historical BvP K rate must be supported by current SwStr% before scoring 1 pt.

**Why it exists:** A pitcher's historical rate against a lineup may have been built under a different velocity profile or pitch mix. If the stuff has changed, the BvP is a false positive.

**Program interpretation:** If `bvp_pa >= 30` and `bvp_k_rate > 0.28`, then check `current_swstr_pct`. If `current_swstr_pct >= 0.11`, return `bvp_score = 1`. Else return `bvp_score = 0`.

---

### Penalty — velocity drop

**Rule:** -2 pts if pitcher velo is down >1.5 mph over last 3 starts vs. season average.

**Why it exists:** K/9 is a lagging indicator. Velocity loss precedes strikeout decline. The market has not yet adjusted. Betting the over into a velo decline is betting against regression.

**Program interpretation:** Compute `season_avg_velo - last3_avg_velo`. If delta > 1.5, apply `penalty = -2`.

---

*Last updated: 2026-03-25*
*Engine: Sharp Cheddar K — confidence mechanism v1.0*