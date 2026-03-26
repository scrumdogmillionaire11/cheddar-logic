# 02 — Projection formula

## Rule

The raw K projection is calculated from three primary inputs — pitcher K/9, expected innings pitched, and opponent strikeout environment — then adjusted by a contact cap if the matchup qualifies. The result is a single decimal K total representing the engine's true expected output before market comparison.

---

## Formula

```
Base projection = (K/9 ÷ 9) × expected_IP × opponent_environment_multiplier

Final projection = min(base_projection, contact_cap)
```

---

## Input definitions

### K/9

Use a blended K/9 that weights recent performance against the season baseline:

```
blended_K9 = (0.40 × season_K9) + (0.60 × rolling_4start_K9)
```

- Season K/9 = full season strikeouts per 9 innings
- Rolling 4-start K/9 = K/9 over last 4 starts only
- If fewer than 4 starts exist on the season, use season K/9 only (no rolling window)
- If fewer than 3 season starts exist, projection is uncalculable — halt

**Why 60/40 toward recent:** Four starts is enough to detect real workload and stuff changes without overreacting to a single outlier. The season baseline prevents recency panic.

---

### Expected innings pitched (expected_IP)

Expected IP is derived from leash classification, not from raw season average:

| Leash tier | Expected IP |
|------------|-------------|
| Full | 6.0 IP |
| Mod+ | 5.5 IP |
| Mod | 5.0 IP |
| Short | 4.0 IP |

> Do not use the pitcher's season IP average as the expected IP input. A pitcher averaging 6.1 IP who has thrown 75 pitches in each of his last 3 starts is a Mod leash, not a Full leash. Leash classification governs IP expectation.

---

### Opponent environment multiplier

The opponent environment multiplier adjusts the base projection up or down based on how strikeout-prone the opposing lineup is relative to league average.

```
opponent_multiplier = opp_K%_vs_handedness_L30 ÷ league_avg_K%_vs_handedness
```

- Use the opponent's K% against the pitcher's handedness over the last 30 days
- Use the current season league average K% as the denominator
- League average K% for reference: approximately 22.5% (update seasonally)

**Multiplier examples:**

| Opponent K% vs. handedness | Multiplier |
|---------------------------|------------|
| 27%+ | 1.20 |
| 25–26.9% | 1.10 |
| 22–24.9% | 1.00 (neutral) |
| 19–21.9% | 0.90 |
| Below 19% | 0.80 |

> If the opponent's 30-day split sample is fewer than 100 PA, fall back to the season-long split. If the season split is also below 100 PA (e.g., early season), use 1.00 neutral multiplier and flag as thin sample.

---

### Contact cap

The contact cap is a ceiling applied when the matchup context indicates the opponent is likely to put the ball in play at a rate that structurally limits K upside.

**Contact cap triggers:**

| Condition | Cap applied |
|-----------|------------|
| Opp K% vs. handedness < 18% (last 30 days) | Cap = blended_K9 ÷ 9 × 5.0 |
| Opp chase rate < 26% (last 30 days) | Cap = blended_K9 ÷ 9 × 5.0 |
| Both conditions present | Cap = blended_K9 ÷ 9 × 4.5 |

When the contact cap is applied, it replaces the opponent environment multiplier. Do not apply both.

**Why the contact cap exists:** The opponent multiplier assumes K% scales linearly with the base rate. Contact-heavy lineups suppress K ceiling in a non-linear way — disciplined hitters put the ball in play even against elite stuff, reducing the effective K opportunities per inning.

---

## Park factor adjustment

Apply park factor after the base projection is calculated:

```
park_adjusted_projection = base_projection × park_K_factor
```

Park K factor is pulled from FanGraphs park factors (K column). Values above 1.00 favor strikeouts, below 1.00 suppress them.

| Park K factor range | Adjustment |
|--------------------|-----------|
| 1.05+ | Multiply by 1.04 |
| 1.00–1.04 | No adjustment (neutral) |
| 0.95–0.99 | Multiply by 0.97 |
| Below 0.95 | Multiply by 0.94 |

---

## Full worked example

**Inputs:**
- Pitcher season K/9: 10.2
- Pitcher rolling 4-start K/9: 11.4
- Leash: Full (6.0 IP)
- Opp K% vs. RHP last 30 days: 25.5%
- Park K factor: 1.02 (neutral)

**Calculation:**

```
blended_K9 = (0.40 × 10.2) + (0.60 × 11.4) = 4.08 + 6.84 = 10.92

opponent_multiplier = 25.5% ÷ 22.5% = 1.133

base_projection = (10.92 ÷ 9) × 6.0 × 1.133
               = 1.213 × 6.0 × 1.133
               = 8.24

park_adjusted = 8.24 × 1.00 (neutral park)
              = 8.24 Ks
```

**Contact cap check:** Opp K% = 25.5%, chase rate not below 26% — no cap triggered.

**Final projection: 8.2 Ks**

---

## Projection limits and edge cases

| Scenario | Handling |
|----------|----------|
| Fewer than 3 season starts | Projection uncalculable — halt |
| Pitcher returning from IL | Apply IL flag at Step 2 — halt overs before projection is used |
| Opener / bulk reliever role | Projection uncalculable — expected IP is undefined |
| Double-header first game | Reduce expected IP by 0.5 regardless of leash tier |
| Extreme cold weather (<45°F at first pitch) | Apply 0.95 multiplier to final projection |

---

## Program interpretation

```python
def calculate_projection(pitcher, opponent, park, weather):
    # Blended K/9
    if pitcher.season_starts < 3:
        raise ProjectionUncalculable("Insufficient starts")
    if pitcher.season_starts < 4:
        blended_k9 = pitcher.season_k9
    else:
        blended_k9 = (0.40 * pitcher.season_k9) + (0.60 * pitcher.rolling_4start_k9)

    # Expected IP from leash
    ip_map = {"Full": 6.0, "Mod+": 5.5, "Mod": 5.0, "Short": 4.0}
    expected_ip = ip_map[pitcher.leash_tier]

    # Opponent environment
    if opponent.k_pct_vs_handedness_pa >= 100:
        opp_k_pct = opponent.k_pct_vs_handedness_L30
    elif opponent.k_pct_vs_handedness_season_pa >= 100:
        opp_k_pct = opponent.k_pct_vs_handedness_season
    else:
        opp_k_pct = LEAGUE_AVG_K_PCT  # neutral fallback, flag thin sample

    # Contact cap check
    if opponent.k_pct_vs_handedness_L30 < 0.18 and opponent.chase_rate_L30 < 0.26:
        cap = (blended_k9 / 9) * 4.5
        base = min((blended_k9 / 9) * expected_ip, cap)
    elif opponent.k_pct_vs_handedness_L30 < 0.18 or opponent.chase_rate_L30 < 0.26:
        cap = (blended_k9 / 9) * 5.0
        base = min((blended_k9 / 9) * expected_ip, cap)
    else:
        multiplier = opp_k_pct / LEAGUE_AVG_K_PCT
        base = (blended_k9 / 9) * expected_ip * multiplier

    # Park adjustment
    park_factor = get_park_k_factor(park)
    if park_factor >= 1.05:
        base *= 1.04
    elif park_factor < 0.95:
        base *= 0.94
    elif park_factor < 1.00:
        base *= 0.97

    # Weather adjustment
    if weather.temp_at_first_pitch < 45:
        base *= 0.95

    return round(base, 1)
```