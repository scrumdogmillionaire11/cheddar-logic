# 06 — Trap detection

## Rule

Before any play is issued, the engine runs a structured trap scan across six categories. This is a program step, not a gut check. Each category is evaluated against a defined trigger. One active flag scores Block 5 as zero. Two or more active flags suspend scoring entirely — the play is unscoreable and logged as environment compromised.

The governing question at this step is: **why does this line exist?**

Not "is this line wrong?" First: why does it exist. If the answer is "because it's the right number," proceed. If the answer is "because the public wants the over on this pitcher," that's a public bias trap. Assume bait before assuming value when the play looks too easy.

---

## Trap category 1 — Public bias

### Trigger

The pitcher is a nationally recognized name and the over is being heavily bet by the recreational market, resulting in a line that is shorter than projection-based pricing would suggest.

### How to identify it

- Bet percentage on the over significantly exceeds handle percentage (public is loading over tickets, not necessarily over dollars)
- Line has not moved despite heavy public over action (book is holding the line, not afraid of the over — that's confidence, not error)
- The pitcher is a star name, recent no-hitter candidate, or in the middle of a K streak that is generating media coverage

### What to do

Public bias does not automatically flag a trap. The question is whether the bias has mispriced the line or simply created volume. If the projection still shows real margin despite the bias, the bias is not a trap — it's just noise.

**Flag triggers:** Line is softer than comparable starts for this pitcher, AND heavy public over action is documented, AND projection margin is thin (Block 1 = 1 pt). All three together = active flag.

---

## Trap category 2 — Hidden role risk

### Trigger

There is credible evidence or organizational pattern suggesting the pitcher's role for this start is different from his standard role — bulk reliever deployment, game-script-driven early hook, opener-following bullpen game, or tandem start structure.

### How to identify it

- Beat reporter mentions "piggyback" or "tandem" arrangement
- Manager has used this pitcher in a bulk role before this season
- Team's bullpen situation (overworked or thin) makes an early hook likely regardless of performance
- Pitcher's recent usage pattern shows early exits not driven by performance

### Why it matters

Hidden role risk is the trap category that most directly destroys the projection. The entire IP assumption built into the projection formula collapses if the pitcher is pulled at 55 pitches not because of performance but because of a pre-planned bullpen structure.

**Flag triggers:** Any credible source (beat reporter, manager quote, prior-start pattern) suggesting a non-standard role. This is a single-source flag — one credible mention is enough.

---

## Trap category 3 — Lineup context gap

### Trigger

The projected lineup contains material differences from the lineup the projection assumes, specifically:

- Multiple high-K hitters from the opposing order are resting (day off, injury, load management)
- The lineup is heavily stacked opposite-handed to the pitcher's primary weapon without that being captured in the BvP or opponent environment calculation
- A notable lineup spot (cleanup, 3-hole) is filled by a contact bat who was not in the standard lineup used for the environment multiplier

### How to identify it

The projected lineup and the confirmed lineup must be compared at evaluation time. If the evaluation is run before lineup confirmation, do not score — this trap category cannot be assessed on a projected lineup.

**Flag triggers:** 2 or more high-K hitters from the standard order are absent from the confirmed lineup, OR the handedness composition of the confirmed lineup is meaningfully different from what the opponent environment multiplier was calculated against.

---

## Trap category 4 — Market movement anomaly

### Trigger

The line has moved in a direction that contradicts your play, particularly when the movement is sharp (handle-weighted, not ticket-weighted) or when it originates from a sharp-accepting book (Pinnacle, Circa, Bookmaker).

### How to identify it

- Line moved against your play after a period of stability
- Movement originated at a book known for accepting sharp action
- Bet percentage and handle percentage are diverging (public on one side, sharp money on the other — and the other side is not yours)

### What market movement is and is not

Movement at sharp books in game markets is a meaningful signal. Movement in prop markets is a weaker signal — prop markets are illiquid and small sharp bets move lines disproportionately. Do not treat prop line movement as equivalent to game market movement.

**Flag triggers:** Material movement (0.5+ on the line, or significant juice shift) at a sharp book against your play, without a clear informational reason (injury news, weather change, etc.) that you have already accounted for.

---

## Trap category 5 — Weather and park environment

### Trigger

Game-time weather conditions create a meaningful suppression of offensive activity, OR the park environment for this game is materially more K-suppressive than captured in the park factor adjustment.

### How to identify it

**Weather triggers:**
- Temperature at first pitch below 45°F (already applied as a projection modifier — flag if not yet applied)
- Wind blowing in significantly (15+ mph, directly from outfield toward home plate)
- Heavy humidity in dome environments affecting pitch grip

**Park triggers:**
- Temporary park configurations (postseason setup, field dimensions changed)
- Known pitcher-friendly park not fully captured in the season park factor (e.g., early season before factors update)

**Flag triggers:** Weather conditions that would suppress K environment AND were not captured in the projection calculation.

---

## Trap category 6 — Umpire suppression

### Trigger

The assigned home plate umpire has a documented K-suppression tendency that is severe enough to materially compress the K ceiling below the projection.

### Threshold

Ump K rate more than -4 percentage points below league average, with a 30+ GP sample.

### Why this is a trap, not an overlay deduction

A moderately unfavorable ump (-1 to -3pp) is an overlay non-score — the ump didn't help, but it's not a trap. A severely unfavorable ump (-4pp+) is a trap because it creates a structural ceiling on Ks that the projection formula doesn't account for. It's not just that the ump didn't help — it's that the ump is actively working against the over.

**Flag triggers:** Ump K rate suppression > -4pp AND the play is an over.

---

## Trap evaluation output

After all six categories are scanned, return:

```
trap_flags = [list of active flag categories]
trap_count = len(trap_flags)

if trap_count == 0:
    block5_score = 1
    verdict_eligible = True

elif trap_count == 1:
    block5_score = 0
    verdict_eligible = True
    # Play continues — one flag hurts confidence but doesn't kill

elif trap_count >= 2:
    block5_score = 0
    verdict_eligible = False
    log_reason = "Environment compromised — {trap_count} active trap flags"
    # No verdict issued
```

---

## Trap scan checklist (run order)

Run in this order. Stop at two flags.

```
[ ] 1. Public bias — star name + thin margin + documented public lean?
[ ] 2. Hidden role risk — any credible non-standard role signal?
[ ] 3. Lineup context gap — confirmed lineup vs. projection assumptions?
[ ] 4. Market movement anomaly — sharp counter-movement at sharp book?
[ ] 5. Weather/park — unaccounted suppression conditions?
[ ] 6. Ump suppression — ump K rate below -4pp?
```

If two flags are checked before reaching item 6, stop. Score is suspended.

---

## Program interpretation

```python
def run_trap_scan(pitcher, game, market, ump, weather):
    flags = []

    # 1. Public bias
    if (game.pitcher_is_star and
        market.over_bet_pct > 70 and
        market.line_soft_vs_comparable and
        market.block1_score <= 1):
        flags.append("PUBLIC_BIAS")

    # 2. Hidden role risk
    if game.has_role_signal:
        flags.append("HIDDEN_ROLE_RISK")

    # 3. Lineup context gap
    if game.confirmed_lineup is None:
        flags.append("LINEUP_UNCONFIRMED")
    elif game.high_k_hitters_absent >= 2 or game.handedness_shift_material:
        flags.append("LINEUP_CONTEXT_GAP")

    # 4. Market movement anomaly
    if (market.movement_against_play and
        market.movement_magnitude >= 0.5 and
        market.movement_source_sharp):
        flags.append("SHARP_COUNTER_MOVEMENT")

    # 5. Weather/park
    if weather.temp_at_first_pitch < 45 and not pitcher.projection_weather_adjusted:
        flags.append("WEATHER_UNACCOUNTED")
    if weather.wind_in_mph > 15 and weather.wind_direction == "IN":
        flags.append("WIND_SUPPRESSION")

    # 6. Ump suppression (overs only)
    if (game.side == "over" and
        ump.k_rate_diff_vs_league < -0.04 and
        ump.games_behind_plate >= 30):
        flags.append("UMP_SUPPRESSION")

    return TrapResult(
        flags=flags,
        count=len(flags),
        block5_score=1 if len(flags) == 0 else 0,
        verdict_eligible=len(flags) < 2
    )
```