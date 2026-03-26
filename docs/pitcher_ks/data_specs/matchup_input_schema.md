# Matchup input schema

## Purpose

Defines all required and optional fields for the matchup (opponent + game context) input object. This covers the opposing team's statistical profile, the confirmed lineup, park factors, and weather.

---

## Schema

```json
{
  "matchup": {
    "game_date": "string — YYYY-MM-DD",
    "game_time_et": "string — HH:MM ET",
    "home_team": "string — three-letter team code",
    "away_team": "string — three-letter team code",
    "pitcher_team": "string — three-letter team code (which team the pitcher is on)",
    "opponent_team": "string — three-letter team code",

    "opponent": {
      "k_pct_vs_handedness_L30": "float — opp K% vs. pitcher handedness, last 30 days (0–1 decimal)",
      "k_pct_vs_handedness_season": "float — opp K% vs. pitcher handedness, season",
      "k_pct_vs_handedness_pa_L30": "integer — PA sample for L30 split",
      "k_pct_vs_handedness_pa_season": "integer — PA sample for season split",
      "chase_rate_L30": "float — opp O-Swing% last 30 days (0–1 decimal)",
      "chase_rate_season": "float — opp O-Swing% season (0–1 decimal)",
      "team_k_rank_vs_handedness": "integer — team rank by K% vs. pitcher handedness (1=most K-prone)"
    },

    "confirmed_lineup": [
      {
        "batting_order": "integer — 1–9",
        "name": "string — player full name",
        "id": "string — Baseball Reference player ID",
        "handedness": "string — 'R', 'L', or 'S' (switch)",
        "chase_rate": "float — individual player O-Swing% current season (0–1 decimal)",
        "k_pct": "float — individual player K% current season (0–1 decimal)"
      }
    ],

    "park": {
      "park_name": "string",
      "team_code": "string",
      "is_dome": "boolean",
      "roof_closed": "boolean or null — null if not applicable",
      "k_factor_current_season": "float — park K factor from FanGraphs (1.00 = neutral)",
      "k_factor_prior_season": "float — prior season K factor (fallback)"
    },

    "weather": {
      "temp_at_first_pitch": "float — degrees Fahrenheit",
      "wind_speed_mph": "float",
      "wind_direction": "string — 'IN' | 'OUT' | 'L_TO_R' | 'R_TO_L' | 'CALM' | 'VARIABLE'",
      "precipitation_pct": "float — probability of rain (0–1)",
      "humidity_pct": "float — relative humidity (0–100)",
      "weather_source": "string — source and retrieval timestamp"
    }
  }
}
```

---

## Field rules

| Field | Required | Halt if missing |
|-------|----------|----------------|
| `game_date` | Yes | No |
| `opponent.k_pct_vs_handedness_L30` | Yes | Use season fallback if L30 PA <100 |
| `opponent.k_pct_vs_handedness_season` | Yes | Yes — at minimum the season split is required |
| `opponent.chase_rate_L30` | Yes | Contact cap check blocked |
| `confirmed_lineup` | Yes | BvP blocked; lineup context trap cannot run |
| `confirmed_lineup[*].id` | Yes | BvP lookup blocked for that batter |
| `confirmed_lineup[*].handedness` | Yes | Handedness split check blocked |
| `park.is_dome` | Yes | Weather gates blocked |
| `park.k_factor_current_season` | Yes | Use 1.00 neutral and flag |
| `weather.temp_at_first_pitch` | If not dome | Weather adjustment blocked |
| `weather.wind_speed_mph` | If not dome | Wind trap flag blocked |
| `weather.wind_direction` | If not dome | Wind trap flag blocked |

---

## Lineup confirmation rules

The confirmed lineup is valid only if:

1. It was sourced from an official beat reporter post, MLB Gameday, or the team's official Twitter account
2. It was sourced within 90 minutes of first pitch (earlier confirmation is acceptable but may need refresh)
3. It includes all 9 batting spots (or 8 if DH is unavailable due to NL interleague rules)
4. The source and timestamp are logged

**Do not use projected lineups.** Do not use FanDuel or DraftKings projected lineups. Do not use DraftKings lineups from 4 hours before the game.

---

## Validation rules

```python
def validate_matchup_input(m):
    errors = []

    opp = m.opponent
    if opp.k_pct_vs_handedness_pa_season < 100:
        errors.append("WARN: Season opp split sample below 100 PA — use neutral multiplier")

    if opp.k_pct_vs_handedness_L30 is None and opp.k_pct_vs_handedness_season is None:
        errors.append("HALT: No opponent K% data available")

    if m.confirmed_lineup is None:
        errors.append("WARN: Lineup not confirmed — BvP and lineup trap blocked")
    elif len(m.confirmed_lineup) < 8:
        errors.append("WARN: Confirmed lineup has fewer than 8 batters")

    if not m.park.is_dome:
        if m.weather.temp_at_first_pitch is None:
            errors.append("WARN: Outdoor park — temp at first pitch missing")
        if m.weather.wind_direction is None:
            errors.append("WARN: Outdoor park — wind direction missing")

    return errors
```

---

## Example — valid matchup input (abbreviated)

```json
{
  "matchup": {
    "game_date": "2026-04-15",
    "game_time_et": "19:10",
    "home_team": "BAL",
    "away_team": "BOS",
    "pitcher_team": "BAL",
    "opponent_team": "BOS",

    "opponent": {
      "k_pct_vs_handedness_L30": 0.241,
      "k_pct_vs_handedness_season": 0.235,
      "k_pct_vs_handedness_pa_L30": 187,
      "k_pct_vs_handedness_pa_season": 612,
      "chase_rate_L30": 0.298,
      "chase_rate_season": 0.291,
      "team_k_rank_vs_handedness": 14
    },

    "confirmed_lineup": [
      {"batting_order": 1, "name": "Jarren Duran", "id": "duranja01", "handedness": "L", "chase_rate": 0.32, "k_pct": 0.21},
      {"batting_order": 2, "name": "Rafael Devers", "id": "deverra01", "handedness": "L", "chase_rate": 0.28, "k_pct": 0.22}
    ],

    "park": {
      "park_name": "Oriole Park at Camden Yards",
      "team_code": "BAL",
      "is_dome": false,
      "roof_closed": null,
      "k_factor_current_season": 1.02,
      "k_factor_prior_season": 1.01
    },

    "weather": {
      "temp_at_first_pitch": 61,
      "wind_speed_mph": 8,
      "wind_direction": "OUT",
      "precipitation_pct": 0.05,
      "humidity_pct": 52,
      "weather_source": "Weather.com — retrieved 2026-04-15 17:30 ET"
    }
  }
}
```