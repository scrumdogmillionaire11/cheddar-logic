# Scoring rules — master reference

This document is the single source of truth for how raw scores, penalties, confidence tiers, and verdicts are calculated. It works in conjunction with `rules/confidence_rules.md` (the detailed scoring mechanism) and references the block-by-block logic defined in `docs/02–06`.

---

## Scoring model summary

| Block | What it measures | Max pts | Source doc |
|-------|-----------------|---------|------------|
| Block 1 | Projection margin | 3 | `docs/05_market_tiers.md` |
| Block 2 | Leash integrity | 2 | `docs/03_leash_rules.md` |
| Block 3 | Overlay alignment | 3 | `docs/04_overlay_rules.md` |
| Block 4 | Market structure | 1 | `docs/05_market_tiers.md` |
| Block 5 | Trap clearance | 1 | `docs/06_trap_detection.md` |
| **Raw total** | | **10** | |

---

## Block 1 — Projection margin

**Over tiers:**

| Margin | Score |
|--------|-------|
| <0.5K | 0 — halt |
| 0.5–0.74K | 1 |
| 0.75–1.0K | 2 |
| >1.0K | 3 |

**Under tiers:**

| Margin | Score |
|--------|-------|
| <0.75K | 0 — halt |
| 0.75–1.0K | 1 |
| 1.0–1.5K | 2 |
| >1.5K | 3 |

---

## Block 2 — Leash integrity

| Leash tier | Score | Over eligible |
|------------|-------|--------------|
| Full | 2.0 | Yes |
| Mod+ | 1.5 | Yes |
| Mod | 1.0 | Yes |
| Short | 0 | No — kill |
| IL / extended rest | 0 | No — kill |

---

## Block 3 — Overlay alignment

| Overlay | Score | Qualification |
|---------|-------|--------------|
| Trend | 0 or 1 | K% delta >+2pp, min 4+4 starts |
| Ump | 0 or 1 | K rate >+3pp, min 30 GP |
| BvP | 0 or 1 | K rate >28%, min 30 PA, SwStr% ≥11% |

---

## Block 4 — Market structure

| Condition | Score |
|-----------|-------|
| Line stable or moved favorably | 1 |
| Line moved against play | 0 |

---

## Block 5 — Trap clearance

| Trap flag count | Score | Verdict eligible |
|----------------|-------|-----------------|
| 0 | 1 | Yes |
| 1 | 0 | Yes |
| 2+ | 0 | No — suspended |

---

## Penalty schedule

Applied after raw score is calculated. Subtract from raw total.

| Penalty | Deduction | Trigger |
|---------|-----------|---------|
| Contact-heavy lineup | -2 | Opp K% vs. handedness <18% L30 |
| Velocity drop | -2 | Pitcher velo down >1.5 mph last 3 starts vs. season avg |
| Handedness split unfavorable | -1 | Lineup stacked opposite-hand, no BvP edge |
| Park factor headwind | -1 | Park K factor <0.95 |
| High-chase bat absent | -1 | Key high-chase batter not in confirmed lineup |

Penalties can produce a negative net score. Net score floor is 0.

---

## Confidence tiers

| Net score | Tier | Verdict range |
|-----------|------|--------------|
| 0–4 | No play | Pass |
| 5–6 | Marginal | Conditional play (line-dependent) |
| 7–8 | Strong | Play |
| 9–10 | Max | Play — rare, handle with discipline |

---

## Confidence cap rules (WI-1255)

**Applied in Step 6.5 — after all scoring completes but before final verdict emission.**

These rules prevent fake confidence by hard-capping posture and marking output for exclusion when critical trap prerequisites are missing or stale.

### Enforcement rules

| Priority | Condition | Posture cap | Reason code | Output suppressed |
|----------|-----------|-------------|-------------|------------------|
| 1 (highest) | `opp_profile_staleness = STALE` AND `leash_bucket = UNKNOWN` (both) | `NO_OUTPUT_INSUFFICIENT_DATA` | `INSUFFICIENT_DATA_BOTH_FRESHNESS_LEASH` | **YES** |
| 2 | `opp_profile_staleness = STATIC_FALLBACK` | `DATA_UNTRUSTED` | `CAP_OPP_STATIC_FALLBACK` | NO |
| 3 | `opp_profile_staleness = STALE` | `WATCH` | `CAP_OPP_STALE` | NO |
| 4 | `leash_bucket = UNKNOWN` | `WATCH` | `CAP_LEASH_UNKNOWN` | NO |
| 5 | `leash_bucket = SHORT` + selection is OVER + posture is `OVER_CANDIDATE` | `TRAP_FLAGGED` | `CAP_SHORT_LEASH_OVER` | NO |
| 6 (lowest) | `opp_k_bucket = LOW_K` + projected K > 6.5 | `UNDER_LEAN_ONLY` | `CAP_LOW_OPP_HIGH_PROJ` | NO |

**Applied in order (first match wins; all others ignored).**

### Output suppression

When **both** `opp_profile_staleness` is STALE or STATIC_FALLBACK **AND** `leash_bucket` is UNKNOWN:
- Posture assigned: `NO_OUTPUT_INSUFFICIENT_DATA`
- Card marked for exclusion from candidate output
- `confidence_cap_reason` set to `INSUFFICIENT_DATA_BOTH_FRESHNESS_LEASH`

### `confidence_cap_reason` field

Field added to pitcher K card payloads in Step 6.5 to document which (if any) cap rule applied:
- Remains `null` when no cap applies
- Set to the cap rule reason code (e.g., `CAP_OPP_STALE`, `INSUFFICIENT_DATA_BOTH_FRESHNESS_LEASH`) when a cap is enforced

---

## Kill-switch override table

These halt or suspend evaluation before scoring completes.

| Condition | Step triggered | Action |
|-----------|---------------|--------|
| Projection uncalculable | Step 1 | Halt — no play |
| Block 1 = 0 (margin below floor) | Step 1 | Halt — no play |
| Leash = Short (over) | Step 2 | Halt — structural ceiling |
| IL / extended rest flag (over) | Step 2 | Halt — structural ceiling |
| Opener / bulk role confirmed | Step 1 | Halt — IP undefined |
| Two+ trap flags | Step 5 | Suspend — environment compromised |
| Net score <5 after penalties | Step 6 | Pass verdict |

---

## Verdict decision matrix

| Kill-switch | Trap flags | Net score | Verdict |
|-------------|-----------|-----------|---------|
| Any triggered | — | — | Pass (halted) or No verdict (suspended) |
| None | 2+ | — | Suspended — no verdict |
| None | 0–1 | 0–4 | Pass |
| None | 0–1 | 5–6 | Conditional play |
| None | 0–1 | 7–8 | Play |
| None | 0–1 | 9–10 | Play (max) |

---

## Scoring computation (pseudocode)

```python
def score_play(pitcher, matchup, market, ump, weather):

    # Step 1 — projection and Block 1
    try:
        projection = calculate_projection(pitcher, matchup, market.park, weather)
    except ProjectionUncalculable as e:
        return Verdict(status="HALTED", reason=str(e))

    block1 = score_market_margin(projection, market.line, market.side)
    if block1.halt:
        return Verdict(status="HALTED", reason="Block 1 = 0 — no margin")

    # Step 2 — leash and Block 2
    leash = classify_leash(pitcher)
    if not leash.over_eligible and market.side == "over":
        return Verdict(status="HALTED", reason=f"Leash flag: {leash.flag}")
    block2 = score_leash(leash)

    # Step 3 — overlays
    trend = score_trend(pitcher)
    ump_score = score_ump(ump)
    bvp = score_bvp(pitcher, matchup.confirmed_lineup)
    block3 = trend.score + ump_score.score + bvp.score

    # Step 4 — market structure
    block4 = score_market_structure(market)

    # Step 5 — trap detection
    trap = run_trap_scan(pitcher, matchup, market, ump, weather)
    if not trap.verdict_eligible:
        return Verdict(status="SUSPENDED", reason=f"{trap.count} trap flags")
    block5 = trap.block5_score

    # Step 6 — confidence scoring
    raw_score = block1.score + block2.score + block3 + block4.score + block5
    penalties = calculate_penalties(pitcher, matchup)
    net_score = max(0, raw_score + penalties)  # penalties are negative values

    tier = get_confidence_tier(net_score)
    verdict_type = get_verdict_type(tier)

    return Verdict(
        status="COMPLETE",
        projection=projection,
        margin=block1.margin,
        leash=leash.tier,
        overlays={"trend": trend, "ump": ump_score, "bvp": bvp},
        blocks={"b1": block1.score, "b2": block2.score, "b3": block3,
                "b4": block4.score, "b5": block5},
        penalties=penalties,
        net_score=net_score,
        tier=tier,
        verdict=verdict_type,
        trap_flags=trap.flags
    )
```