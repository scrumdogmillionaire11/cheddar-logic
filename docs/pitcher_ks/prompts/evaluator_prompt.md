# Evaluator prompt

## Purpose

This is the per-pitcher prompt template used to submit a single prop evaluation to the engine. It structures the input data in a consistent format and specifies the exact output required.

---

## Template

```
Evaluate the following strikeout prop using the Sharp Cheddar K pipeline.

## Prop to evaluate
Pitcher: [Full name]
Side: [Over / Under]
Line: [X.X]
Book: [Book name]
Juice: [American odds]
Opening line: [X.X] at [Book] ([timestamp])
Best available line: [X.X] at [Book] at [juice]

## Pitcher data
[Paste pitcher input JSON or structured fields]

## Opponent and matchup data
[Paste matchup input JSON or structured fields]

## Umpire data
[Paste umpire input JSON or structured fields]

## Market data
[Paste market line input JSON or structured fields]

## Instructions
Run the full six-step pipeline. Do not look at the market line before completing the projection. Produce the complete verdict template. Do not abbreviate any field. If a field cannot be scored, state the reason explicitly.

Projection must be calculated before margin. All kill-switch checks must be run before a verdict is issued. All six trap categories must be scanned.
```

---

## Populated example

```
Evaluate the following strikeout prop using the Sharp Cheddar K pipeline.

## Prop to evaluate
Pitcher: Corbin Burnes
Side: Over
Line: 7.5
Book: DraftKings
Juice: -115
Opening line: 7.5 at Pinnacle (2026-04-15 10:30 ET)
Best available line: 7.0 at FanDuel at -125

## Pitcher data
{
  "name": "Corbin Burnes",
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
  "org_pitch_limit": null
}

## Opponent and matchup data
{
  "opponent_team": "BOS",
  "k_pct_vs_handedness_L30": 0.241,
  "k_pct_vs_handedness_pa_L30": 187,
  "chase_rate_L30": 0.298,
  "confirmed_lineup": [confirmed lineup array],
  "park": {"k_factor_current_season": 1.02, "is_dome": false},
  "weather": {"temp_at_first_pitch": 61, "wind_speed_mph": 8, "wind_direction": "OUT"}
}

## Umpire data
{
  "name": "Dan Bellino",
  "games_behind_plate_current_season": 38,
  "k_rate_diff_vs_league": 0.041
}

## Market data
{
  "side": "over",
  "line": 7.5,
  "juice": -115,
  "opening_line": 7.5,
  "sharp_book_action": "none"
}

## Instructions
Run the full six-step pipeline. Do not look at the market line before completing the projection. Produce the complete verdict template. Do not abbreviate any field.
```