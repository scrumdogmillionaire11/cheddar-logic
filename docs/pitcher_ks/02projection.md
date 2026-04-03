# 02 — Projection formula

## Rule

The raw K projection is calculated from expected batters faced multiplied by a pitcher/opponent K interaction and a leash multiplier. The result is a single decimal K mean (`k_mean`) plus a Poisson probability ladder for common strikeout thresholds.

---

## Formula

```
bf_exp = projected_IP × batters_per_inning
k_interaction = starter_K% × opp_K%_vs_hand / league_avg_K%
k_mean = bf_exp × k_interaction × k_leash_mult

Poisson ladder = { P(5+), P(6+), P(7+) }
```

---

## Input definitions

### Starter K skill

Use a blended starter K% when rolling windows exist, otherwise season K%:

```
starter_K% = 0.40 × season_K% + 0.60 × rolling_4start_K%
```

- Season K% = full season strikeouts / batters faced
- Rolling 4-start K% = K% over last 4 starts only when available
- If fewer than 4 starts exist on the season, use season K% only
- If fewer than 3 season starts exist, projection is uncalculable — halt

**Why 60/40 toward recent:** Four starts is enough to detect real workload and stuff changes without overreacting to a single outlier. The season baseline prevents recency panic.

---

### Expected innings pitched and leash multiplier

Expected IP is derived from leash classification, not from raw season average:

| Leash tier | Expected IP |
|------------|-------------|
| Full | 6.0 IP |
| Mod+ | 5.5 IP |
| Mod | 5.0 IP |
| Short | 4.0 IP |

`k_leash_mult` dampens strikeout expectation under lighter workload:

| Leash tier | `k_leash_mult` |
|------------|----------------|
| Full | 1.00 |
| Mod+ | 0.98 |
| Mod | 0.95 |
| Short | 0.90 |

> Do not use the pitcher's season IP average as the expected IP input. A pitcher averaging 6.1 IP who has thrown 75 pitches in each of his last 3 starts is a Mod leash, not a Full leash. Leash classification governs IP expectation.

---

### Expected batters faced and opponent interaction

`batters_per_inning` starts from a neutral run environment and is nudged by opponent OBP/xwOBA/hard-hit profile plus pitcher walk/contact suppression. `k_interaction` then scales starter K% by opponent K% against pitcher handedness relative to league average.

```
k_interaction = starter_K% × opp_K%_vs_handedness ÷ league_avg_K%
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
- Pitcher season K%: 28.2%
- Leash: Full (6.0 IP)
- Opp K% vs. RHP last 30 days: 25.5%
- Opponent OBP/xwOBA/hard-hit: neutral
- Park K factor: 1.02 (neutral)

**Calculation:**

```
bf_exp = 6.0 × 4.22 = 25.32

k_interaction = 0.282 × 0.255 ÷ 0.225 = 0.3196

k_mean = 25.32 × 0.3196 × 1.00 = 8.09

park_adjusted = 8.09 × 1.00 = 8.09 Ks

Poisson ladder:
P(5+) = 0.90
P(6+) = 0.80
P(7+) = 0.68
```

**Final projection: 8.2 Ks**

---

## Projection limits and edge cases

| Scenario | Handling |
|----------|----------|
| Fewer than 3 season starts | `projection_source='SYNTHETIC_FALLBACK'` or HALTED PASS diagnostics |
| Pitcher returning from IL | Apply IL flag at Step 2 — halt overs before projection is used |
| Opener / bulk reliever role | Projection uncalculable — expected IP is undefined |
| Double-header first game | Reduce expected IP by 0.5 regardless of leash tier |
| Extreme cold weather (<45°F at first pitch) | Apply 0.95 multiplier to final projection |

---

## Program interpretation

```python
def calculate_projection(pitcher, opponent, park, weather):
    # Starter K%
    if pitcher.season_starts < 3:
        raise ProjectionUncalculable("Insufficient starts")
    if pitcher.season_starts < 4:
        starter_k_pct = pitcher.season_k_pct
    else:
        starter_k_pct = (0.40 * pitcher.season_k_pct) + (0.60 * pitcher.rolling_4start_k_pct)

    # Expected IP from leash
    ip_map = {"Full": 6.0, "Mod+": 5.5, "Mod": 5.0, "Short": 4.0}
    leash_mult_map = {"Full": 1.00, "Mod+": 0.98, "Mod": 0.95, "Short": 0.90}
    expected_ip = ip_map[pitcher.leash_tier]
    k_leash_mult = leash_mult_map[pitcher.leash_tier]

    # Opponent environment
    if opponent.k_pct_vs_handedness_pa >= 100:
        opp_k_pct = opponent.k_pct_vs_handedness_L30
    elif opponent.k_pct_vs_handedness_season_pa >= 100:
        opp_k_pct = opponent.k_pct_vs_handedness_season
    else:
        opp_k_pct = LEAGUE_AVG_K_PCT  # neutral fallback, flag thin sample

    batters_per_inning = estimate_batters_per_inning(
        pitcher.bb_pct,
        pitcher.xwoba_allowed,
        opponent.obp,
        opponent.xwoba,
        opponent.hard_hit_pct,
    )
    bf_exp = expected_ip * batters_per_inning
    k_interaction = starter_k_pct * opp_k_pct / LEAGUE_AVG_K_PCT
    base = bf_exp * k_interaction * k_leash_mult

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

    return {
        "k_mean": round(base, 2),
        "bf_exp": round(bf_exp, 2),
        "k_interaction": round(k_interaction, 4),
        "k_leash_mult": k_leash_mult,
        "probability_ladder": poisson_tail_ladder(base, thresholds=[5, 6, 7]),
    }
```
