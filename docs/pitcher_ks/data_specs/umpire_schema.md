# Umpire schema

## Purpose

Defines the umpire input object used for the umpire overlay (Block 3) and umpire suppression trap flag (Step 5).

---

## Schema

```json
{
  "umpire": {
    "name": "string — full name",
    "id": "string — UmpScorecards umpire ID if available",
    "games_behind_plate_current_season": "integer",
    "k_rate_current_season": "float — ump K% (0–1 decimal)",
    "k_rate_diff_vs_league": "float — ump K rate minus league avg K rate (positive = more Ks)",
    "games_behind_plate_prior_season": "integer — prior season GP (for thin-sample fallback)",
    "k_rate_diff_prior_season": "float — prior season differential",
    "combined_k_rate_diff": "float — blended current + prior if current sample is thin",
    "source": "string — UmpScorecards.com",
    "retrieved_at": "string — ISO timestamp"
  }
}
```

---

## Field rules

| Field | Required | Overlay blocked if missing |
|-------|----------|--------------------------|
| `name` | Yes | Yes |
| `games_behind_plate_current_season` | Yes | Yes — sample gate |
| `k_rate_diff_vs_league` | Yes | Yes |
| `games_behind_plate_prior_season` | No | No — prior season is optional fallback |
| `k_rate_diff_prior_season` | No | No |

---

## Sample fallback logic

If `games_behind_plate_current_season` < 30 AND the season date is before June 1:

1. Pull prior season GP and K rate differential
2. Blend: `combined_k_rate_diff = (current_gp × current_diff + prior_gp × prior_diff) ÷ (current_gp + prior_gp)`
3. If combined GP ≥ 30, use blended differential for scoring
4. Flag output: `[UMP: early season — combined current/prior sample]`
5. If combined GP is still below 30, overlay is blocked

---

## Scoring thresholds (reference)

| Differential | Overlay result | Trap result |
|-------------|---------------|------------|
| > +0.03 (>+3pp) | Score 1 pt | No flag |
| -0.03 to +0.03 | Score 0 | No flag |
| < -0.03 (>-3pp) | Score 0 | No flag |
| < -0.04 (<-4pp) | Score 0 | Ump suppression trap flag (overs only) |

---

## Example

```json
{
  "umpire": {
    "name": "Ángel Hernández",
    "id": "hernandez_a",
    "games_behind_plate_current_season": 44,
    "k_rate_current_season": 0.218,
    "k_rate_diff_vs_league": -0.007,
    "games_behind_plate_prior_season": 112,
    "k_rate_diff_prior_season": -0.009,
    "combined_k_rate_diff": -0.008,
    "source": "UmpScorecards.com",
    "retrieved_at": "2026-04-15T16:00:00Z"
  }
}
```