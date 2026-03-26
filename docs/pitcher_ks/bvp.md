# BvP escalator

## Purpose

This document defines the full qualification logic for the BvP overlay, including sample thresholds, the SwStr% crosscheck, handedness split requirements, and escalation conditions that can elevate BvP from a confirming signal to a primary signal.

---

## Base qualification

For BvP to score 1 point in Block 3:

| Requirement | Threshold |
|-------------|-----------|
| Combined PA (pitcher vs. confirmed lineup batters) | ≥ 30 PA |
| Pitcher K rate against those batters | > 28% |
| Pitcher current season SwStr% | ≥ 11% |
| Lineup status | Confirmed — not projected |

All three conditions must be met simultaneously. Failing any single condition = 0 pts.

---

## The SwStr% crosscheck — full logic

The SwStr% crosscheck exists because BvP history is not stable across pitcher versions.

### What a "pitcher version" means

A pitcher is effectively a different pitcher if any of the following has changed materially since the BvP history was recorded:

- **Velocity decline:** Average fastball velocity down >2 mph from the historical matchup period
- **Arsenal change:** Primary secondary pitch (SL, CB, CH) has been reduced to <10% usage or removed
- **Mechanical change:** Documented mechanical adjustment (e.g., arm slot change) that fundamentally alters pitch movement profiles
- **Health history:** Tommy John surgery or significant arm injury since the historical BvP was recorded

### SwStr% as the proxy

SwStr% ≥ 11% serves as the real-time proxy for "this pitcher's stuff still works." It is not a perfect proxy but it is the most available signal that correlates with the ability to generate swings and miss.

**The logic chain:**
1. Historical BvP shows pitcher has dominated these batters in the past
2. SwStr% ≥ 11% confirms the pitcher still has the stuff to generate whiffs
3. Therefore the historical rate is likely to persist → BvP scores

**If SwStr% < 11%:**
1. Historical BvP may have been built on better stuff
2. Current stuff may not replicate historical swing-and-miss performance
3. Historical rate is potentially stale → BvP does not score

---

## Escalation conditions

In rare cases, BvP can be treated as a primary confirming signal (rather than merely a secondary one) when multiple conditions are met simultaneously. This does not change the scoring — BvP still scores a maximum of 1 point — but it changes how the play is labeled in the output.

### BvP escalation trigger

BvP escalates to primary confirming signal when ALL of the following are true:

| Condition | Threshold |
|-----------|-----------|
| Combined PA | ≥ 60 PA |
| Pitcher K rate vs. lineup | > 32% |
| SwStr% | ≥ 13% |
| Trend overlay | Also scores 1 pt |
| Leash | Full or Mod+ |

When BvP escalates, the output notes: `BvP: Primary signal (elevated) — [X]% K rate on [N] PA, SwStr% [X]%, trend confirming.`

This escalation does not affect the numerical score. It provides interpretive context that distinguishes a strong BvP signal from a threshold-clearing BvP signal.

---

## Handedness split requirement

BvP is assessed against the full confirmed lineup, but handedness composition affects how the signal is interpreted.

**Same-handedness stack:**
If 5 or more batters in the confirmed lineup share the opposite handedness from the pitcher's primary weapon (e.g., 5+ LHB against a RHP whose primary weapon is a slider that breaks away from RHB), the BvP must also be assessed split by handedness.

If the pitcher's K rate against opposite-handed batters (within the BvP sample) is below 22%, BvP does not qualify regardless of the aggregate rate. The aggregate rate may be inflated by favorable same-handed matchups that won't appear in this game's lineup.

---

## How to calculate combined PA

1. Pull the confirmed lineup (9 batters, or fewer if DH is unavailable)
2. For each batter in the lineup, pull career PA vs. this pitcher from Baseball Reference
3. Sum all PA and all K across all lineup members who appear in the matchup data
4. Calculate aggregate K rate: total_K ÷ total_PA
5. Count only batters where matchup data exists — if only 4 of 9 batters have faced the pitcher, use those 4

**Minimum threshold:** 30 PA from any combination of lineup batters. This can be 10 PA from 3 batters, 5 PA from 6 batters, etc. — the total is what matters.

---

## BvP in early season (before May 1)

Early in the season, current-season split data is thin. For early-season evaluations:

- Use career BvP data, not current-season splits
- Apply a 0.90 confidence discount to the BvP contribution in the output narrative (the score is still 0 or 1 — this is a label, not a numeric adjustment)
- Flag: `BvP: Early season — career data applied, current-season confirmation unavailable`

---

## BvP program interpretation

```python
def score_bvp(pitcher, confirmed_lineup, season_date):
    # Gate: lineup must be confirmed
    if confirmed_lineup is None:
        return OverlayResult(score=0, reason="Lineup not confirmed")

    # Gate: SwStr% crosscheck
    if pitcher.current_season_swstr_pct < 0.11:
        return OverlayResult(
            score=0,
            reason=f"SwStr% {pitcher.current_season_swstr_pct*100:.1f}% — below 11% threshold"
        )

    # Collect BvP data
    total_pa, total_k = 0, 0
    opp_hand_pa, opp_hand_k = 0, 0

    for batter in confirmed_lineup:
        matchup = get_bvp_data(pitcher.id, batter.id)
        if not matchup:
            continue
        total_pa += matchup.pa
        total_k += matchup.k
        if batter.handedness != pitcher.primary_weapon_favored_side:
            opp_hand_pa += matchup.pa
            opp_hand_k += matchup.k

    # Gate: minimum PA
    if total_pa < 30:
        return OverlayResult(
            score=0,
            reason=f"BvP sample {total_pa} PA — below 30 PA minimum"
        )

    # Calculate aggregate K rate
    k_rate = total_k / total_pa

    # Handedness split check
    opp_hand_batters = sum(1 for b in confirmed_lineup
                           if b.handedness != pitcher.primary_weapon_favored_side)
    if opp_hand_batters >= 5 and opp_hand_pa >= 15:
        opp_hand_k_rate = opp_hand_k / opp_hand_pa
        if opp_hand_k_rate < 0.22:
            return OverlayResult(
                score=0,
                reason=f"BvP opp-hand K rate {opp_hand_k_rate*100:.1f}% — handedness-stacked lineup, rate below 22%"
            )

    # Score
    if k_rate > 0.28:
        # Check for escalation
        escalated = (
            total_pa >= 60 and
            k_rate > 0.32 and
            pitcher.current_season_swstr_pct >= 0.13
        )
        early_season = season_date.month < 5

        return OverlayResult(
            score=1,
            reason=f"BvP {k_rate*100:.1f}% K rate, {total_pa} PA, SwStr% confirmed",
            escalated=escalated,
            early_season_flag=early_season
        )
    else:
        return OverlayResult(
            score=0,
            reason=f"BvP {k_rate*100:.1f}% K rate — below 28% threshold"
        )
```