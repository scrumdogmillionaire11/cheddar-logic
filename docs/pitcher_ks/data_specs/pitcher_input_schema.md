# Pitcher input schema

## Purpose

Defines all required and optional fields for the pitcher input object passed to the engine at evaluation time. Every field includes its type, source, and behavior when missing.

---

## Schema

```json
{
  "pitcher": {
    "name": "string — full name",
    "id": "string — Baseball Reference player ID",
    "team": "string — three-letter team code",
    "handedness": "string — 'R' or 'L'",

    "season_starts": "integer — number of starts this season",
    "season_k9": "float — season K/9",
    "season_k_pct": "float — season K% (0–1 decimal)",
    "season_swstr_pct": "float — season SwStr% (0–1 decimal)",
    "season_avg_velo": "float — season average fastball velocity (mph)",

    "rolling_4start_k9": "float — K/9 over last 4 starts",
    "rolling_4start_k_pct": "float — K% over last 4 starts",
    "prior_4start_k_pct": "float — K% over starts 5–8 (for trend calculation)",
    "last_3start_avg_velo": "float — average fastball velocity over last 3 starts",

    "last_three_pitch_counts": "array[integer] — pitch counts for last 3 starts, most recent first",
    "last_three_ip": "array[float] — innings pitched for last 3 starts, most recent first",

    "il_status": "boolean — true if currently on IL or returning from IL this start",
    "il_return": "boolean — true if this is first or second start back from IL",
    "days_since_last_start": "integer — calendar days since most recent start",
    "role": "string — 'starter' | 'opener' | 'bulk' | 'tandem'",
    "org_pitch_limit": "integer or null — stated organizational pitch limit for this start, null if not stated",

    "primary_weapon": "string — primary secondary pitch (e.g., 'SL', 'CB', 'CH', 'SL/CT')",
    "primary_weapon_favored_side": "string — which batter handedness this pitch is most effective against: 'R', 'L', or 'both'"
  }
}
```

---

## Field rules

| Field | Required | Type | Halt if missing |
|-------|----------|------|----------------|
| `name` | Yes | string | No — log only |
| `id` | Yes | string | Yes — needed for BvP lookup |
| `team` | Yes | string | No |
| `handedness` | Yes | string | Yes — needed for opp splits |
| `season_starts` | Yes | integer | Yes |
| `season_k9` | Yes | float | Yes |
| `season_k_pct` | Yes | float | Yes — Block 3 trend |
| `season_swstr_pct` | Yes | float | Yes — BvP crosscheck |
| `season_avg_velo` | Yes | float | Yes — velocity penalty check |
| `rolling_4start_k9` | If ≥4 starts | float | Yes if ≥4 starts exist |
| `rolling_4start_k_pct` | If ≥4 starts | float | Yes if ≥4 starts exist |
| `prior_4start_k_pct` | If ≥8 starts | float | Trend overlay blocked if missing |
| `last_3start_avg_velo` | Yes | float | Velocity penalty blocked if missing |
| `last_three_pitch_counts` | Yes | array[int] | Yes — leash classification |
| `last_three_ip` | Yes | array[float] | Yes |
| `il_status` | Yes | boolean | Yes |
| `il_return` | Yes | boolean | Yes |
| `days_since_last_start` | Yes | integer | Yes |
| `role` | Yes | string | Yes |
| `org_pitch_limit` | No | integer or null | No — optional |
| `primary_weapon` | No | string | BvP handedness split blocked |
| `primary_weapon_favored_side` | No | string | BvP handedness split blocked |

---

## Validation rules

```python
def validate_pitcher_input(p):
    errors = []

    if p.season_starts < 3:
        errors.append("HALT: season_starts < 3 — projection uncalculable")

    if p.handedness not in ["R", "L"]:
        errors.append("HALT: handedness invalid")

    if p.season_k9 <= 0 or p.season_k9 > 20:
        errors.append("HALT: season_k9 out of range")

    if p.season_swstr_pct < 0 or p.season_swstr_pct > 0.30:
        errors.append("HALT: season_swstr_pct out of range")

    if len(p.last_three_pitch_counts) < 3:
        errors.append("HALT: fewer than 3 pitch counts available")

    if p.il_status and not isinstance(p.il_return, bool):
        errors.append("HALT: il_return must be boolean when il_status is true")

    if p.role not in ["starter", "opener", "bulk", "tandem"]:
        errors.append("HALT: role invalid")

    if p.season_starts >= 4 and p.rolling_4start_k9 is None:
        errors.append("HALT: rolling_4start_k9 required when season_starts >= 4")

    return errors
```

---

## Example — valid pitcher input

```json
{
  "pitcher": {
    "name": "Corbin Burnes",
    "id": "burnsco01",
    "team": "BAL",
    "handedness": "R",

    "season_starts": 12,
    "season_k9": 10.4,
    "season_k_pct": 0.289,
    "season_swstr_pct": 0.138,
    "season_avg_velo": 95.2,

    "rolling_4start_k9": 11.1,
    "rolling_4start_k_pct": 0.311,
    "prior_4start_k_pct": 0.268,
    "last_3start_avg_velo": 95.6,

    "last_three_pitch_counts": [97, 91, 88],
    "last_three_ip": [6.2, 6.0, 6.1],

    "il_status": false,
    "il_return": false,
    "days_since_last_start": 5,
    "role": "starter",
    "org_pitch_limit": null,

    "primary_weapon": "CB",
    "primary_weapon_favored_side": "L"
  }
}
```