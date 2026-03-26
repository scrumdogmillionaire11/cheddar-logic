# 04 — Overlay rules

## Rule

Three overlays are evaluated after the raw projection is complete: trend, umpire, and BvP. Each overlay is binary — it either qualifies and scores, or it does not qualify and scores zero. There is no partial credit and no estimation. An overlay with an insufficient sample is worth exactly as much as a negative overlay: zero.

Overlays confirm or reinforce a projection. They do not generate edge where the projection has none.

---

## Overlay 1 — Trend

### What it measures

Whether the pitcher is in a measurable positive K% trajectory over a recent window, relative to a prior comparable window.

### Threshold

**Qualifies (1 pt):** K% delta greater than +2 percentage points over the last 4 starts compared to the prior 4 starts. Both windows must have at least 4 starts.

**Does not qualify (0 pts):** Delta is flat (within ±2pp), declining, or either window has fewer than 4 starts.

### Sample requirement

Minimum 4 starts in each window (last 4 and prior 4). No exceptions. If fewer than 8 starts exist on the season, the trend overlay cannot be scored.

### Why the 4-start window

A 1–2 start hot streak is noise. A 4-start directional shift with a measurable delta represents a real change in performance level — either stuff development, pitch mix adjustment, or mechanical improvement. The prior 4-start window provides a comparable baseline that smooths out single-game variance.

### What counts as K%

K% = strikeouts ÷ batters faced. Not K/9. K/9 is confounded by innings pitched variation. K% is a cleaner signal of true swing-and-miss ability within the starts.

### Negative trend

A declining trend (K% delta below -2pp) does not score -1 here. Negative trend is handled as a penalty in the confidence scoring model. Overlays only add signal — they do not subtract.

### Program interpretation

```python
def score_trend(pitcher):
    if pitcher.season_starts < 8:
        return OverlayResult(score=0, reason="Insufficient starts for trend window")

    last4_k_pct = pitcher.k_pct_last_4_starts
    prior4_k_pct = pitcher.k_pct_prior_4_starts
    delta = last4_k_pct - prior4_k_pct

    if delta > 0.02:
        return OverlayResult(score=1, reason=f"K% up {delta*100:.1f}pp over last 4 starts")
    else:
        return OverlayResult(score=0, reason=f"K% delta {delta*100:.1f}pp — threshold not met")
```

---

## Overlay 2 — Umpire

### What it measures

Whether the assigned home plate umpire has a demonstrated tendency to expand the strike zone in ways that increase called-strike frequency and strikeout rate above league average.

### Threshold

**Qualifies (1 pt):** Umpire K rate is greater than +3 percentage points above league average, with a minimum sample of 30 games behind the plate in the current season.

**Does not qualify (0 pts):** K rate differential is less than +3pp, ump is neutral, or sample is below 30 GP.

### Sample requirement

Minimum 30 games behind the plate in the current season. Early-season ump data (before April 15 approximately) should be supplemented with prior-season data if the current season sample is thin. Flag any ump scored on a combined current/prior season sample.

### Data source

UmpScorecards.com is the primary source. Pull K rate differential directly from the umpire's season profile page.

### Unfavorable umpires

A K-suppressing umpire (K rate more than -3pp below league average) does not score -1 here. It is handled as a trap flag in Step 5 (see `docs/06_trap_detection.md`). The overlay layer is additive only.

### Why +3pp threshold

A +1–2pp differential is within the noise range across a 30-game sample. A +3pp differential represents a meaningful, durable tendency — approximately 0.3–0.4 additional Ks per 9 innings in favorable conditions. Below that, the signal is indistinguishable from variance.

### Program interpretation

```python
def score_ump(ump):
    if ump.games_behind_plate_current_season < 30:
        return OverlayResult(score=0, reason=f"Ump sample {ump.games_behind_plate_current_season} GP — below 30 GP minimum")

    if ump.k_rate_diff_vs_league > 0.03:
        return OverlayResult(score=1, reason=f"Ump K rate +{ump.k_rate_diff_vs_league*100:.1f}pp above league avg")
    else:
        return OverlayResult(score=0, reason=f"Ump K rate {ump.k_rate_diff_vs_league*100:.1f}pp — threshold not met")
```

---

## Overlay 3 — BvP (Batter vs. Pitcher)

### What it measures

Whether the pitcher has a demonstrated historical advantage against the specific batters in today's confirmed lineup, validated by a supporting swing-and-miss metric.

### Threshold

**Qualifies (1 pt):** The pitcher's career K rate against batters in the confirmed lineup is greater than 28%, with a minimum of 30 combined PA, AND the pitcher's current SwStr% supports the historical rate.

**Does not qualify (0 pts):** Combined PA below 30, K rate below 28%, or SwStr% crosscheck fails.

### Sample requirement

30 combined PA across all batters in the confirmed lineup who have faced this pitcher. If only 3 batters have faced him and the combined PA is 22, the sample does not qualify. Count PA from all lineup members who appear in the historical matchup data.

### The SwStr% crosscheck

This is the critical filter that prevents false positives.

A pitcher's historical BvP rate may have been built under a different velocity profile, pitch mix, or physical condition. If the pitcher is now throwing 2+ mph softer, has lost a dominant secondary pitch, or has significantly changed his arsenal, the historical rate against these batters does not predict future performance against them.

**SwStr% qualification:**
- If pitcher's current season SwStr% is ≥ 11%: crosscheck passes
- If pitcher's current season SwStr% is below 11%: crosscheck fails, BvP scores 0 regardless of historical rate

**Why 11%:** A SwStr% of 11% is approximately the league average threshold for pitchers who generate strikeouts at a meaningful rate. Below this level, the stuff has degraded enough that historical BvP rates built on better stuff are not reliable.

### What "confirmed lineup" means

BvP is only scored against the confirmed starting lineup — not the projected or expected lineup. If lineup has not been posted at evaluation time, BvP cannot be scored. Do not estimate the lineup.

### Why BvP alone is never sufficient

BvP against a lineup is a single historical data point. It is not a projection. It does not account for pitcher aging, stuff changes, lineup composition changes, or ballpark differences at the time the PA were recorded. It is a confirming signal only, not a primary signal.

### Program interpretation

```python
def score_bvp(pitcher, confirmed_lineup):
    if confirmed_lineup is None:
        return OverlayResult(score=0, reason="Lineup not confirmed — BvP not scoreable")

    # SwStr% crosscheck first
    if pitcher.current_season_swstr_pct < 0.11:
        return OverlayResult(score=0, reason=f"SwStr% {pitcher.current_season_swstr_pct*100:.1f}% below 11% — historical BvP unreliable")

    # Calculate combined BvP across confirmed lineup
    total_pa = 0
    total_k = 0
    for batter in confirmed_lineup:
        matchup = get_bvp_data(pitcher.id, batter.id)
        if matchup:
            total_pa += matchup.pa
            total_k += matchup.k

    if total_pa < 30:
        return OverlayResult(score=0, reason=f"Combined BvP sample {total_pa} PA — below 30 PA minimum")

    k_rate = total_k / total_pa
    if k_rate > 0.28:
        return OverlayResult(score=1, reason=f"BvP K rate {k_rate*100:.1f}% on {total_pa} PA, SwStr% confirmed")
    else:
        return OverlayResult(score=0, reason=f"BvP K rate {k_rate*100:.1f}% — below 28% threshold")
```

---

## Overlay interaction rules

Overlays are independent. A strong BvP does not raise the bar for trend or vice versa. Each is scored on its own threshold.

The maximum overlay contribution is 3 points (all three qualify). The minimum is 0 points (none qualify). Neither extreme is common. Most plays score 1 or 2 overlay points.

**What to do when all three overlays score 0:** The play can still be valid — a strong projection margin and clean leash with zero overlay support can reach a Marginal confidence tier (score ~5–6). The overlay layer failing does not kill the play; it reduces the confidence ceiling.

**What to do when all three overlays score 1:** This is a strong confirmation environment. The confidence score will reflect it, but overlays cannot substitute for projection margin. Three positive overlays on a thin margin is still a thin play.

---

## Overlay scoring summary

| Overlay | Max pts | Minimum sample | Key threshold |
|---------|---------|---------------|---------------|
| Trend | 1 | 8 starts (4+4 windows) | K% delta >+2pp |
| Umpire | 1 | 30 GP behind plate | K rate >+3pp vs. league avg |
| BvP | 1 | 30 combined PA, lineup confirmed | K rate >28% AND SwStr% ≥11% |
| **Total** | **3** | | |