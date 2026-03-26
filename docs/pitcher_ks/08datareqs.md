# 08 — Data requirements

## Rule

A play cannot be evaluated unless all required data is present and confirmed. Missing required data halts evaluation. Estimated or projected data is not a substitute for confirmed data. The engine does not guess.

---

## Required data — pitcher

All pitcher inputs must be confirmed before Step 1 begins.

| Field | Definition | Source | Missing = |
|-------|-----------|--------|-----------|
| `season_k9` | Full-season K/9 | Baseball Savant, FanGraphs | Halt |
| `season_starts` | Number of starts this season | Baseball Reference | Halt |
| `rolling_4start_k9` | K/9 over last 4 starts | Game log compilation | Halt if ≥4 starts exist |
| `last_three_pitch_counts` | Pitches thrown in each of last 3 starts | Baseball Reference game logs | Halt |
| `current_swstr_pct` | Season swinging-strike rate | Baseball Savant | BvP overlay blocked |
| `k_pct_last_4_starts` | K% over last 4 starts | Game log | Trend overlay blocked |
| `k_pct_prior_4_starts` | K% over prior 4 starts | Game log | Trend overlay blocked |
| `il_status` | Active IL designation or return status | MLB transaction wire | Halt if active |
| `days_since_last_start` | Calendar days since most recent start | Game log | Halt if ≥10 |
| `role` | Starter / opener / bulk / tandem | Beat reporter / rotation depth chart | Halt if opener/bulk |
| `org_pitch_limit` | Stated organizational pitch limit if known | Manager quotes / beat reports | Optional — use if present |
| `handedness` | Left / right | Baseball Reference | Required for opp splits |

---

## Required data — opponent / matchup

| Field | Definition | Source | Missing = |
|-------|-----------|--------|-----------|
| `confirmed_lineup` | Official starting lineup in batting order | MLB Gameday / Twitter beat reporters | BvP blocked; vet for lineup context gap trap |
| `opp_k_pct_vs_handedness_L30` | Opp K% vs. pitcher handedness, last 30 days | FanGraphs team splits | Use season split if <100 PA |
| `opp_k_pct_vs_handedness_season` | Season-long opp K% vs. handedness | FanGraphs team splits | Fallback for L30 thin sample |
| `opp_chase_rate_L30` | Opp chase rate (O-Swing%) last 30 days | FanGraphs team splits | Contact cap check blocked if missing |
| `bvp_data` | Historical matchup PA/K for each confirmed batter | Baseball Reference splits | BvP overlay blocked |

---

## Required data — market

| Field | Definition | Source | Missing = |
|-------|-----------|--------|-----------|
| `opening_line` | Line at market open | Pinnacle / Circa / OddsJam historical | Block 4 defaults to 0 if missing |
| `current_line` | Current market line at time of evaluation | OddsJam / book directly | Halt — no line = no margin |
| `current_juice` | Vig on the side being evaluated | OddsJam / book directly | Halt |
| `best_available_line` | Best line for play direction across all available books | OddsJam / Unabated odds screen | Recommended — use for margin calc |
| `alt_lines_available` | Alt line options and their juice | Book prop pages | Optional — check if standard margin fails |

---

## Required data — umpire

| Field | Definition | Source | Missing = |
|-------|-----------|--------|-----------|
| `ump_name` | Assigned home plate umpire | Baseball Reference umpire assignments / Rotowire | Ump overlay blocked |
| `ump_k_rate_diff` | Ump K rate vs. league average | UmpScorecards.com | Ump overlay blocked |
| `ump_games_behind_plate` | Games behind plate current season | UmpScorecards.com | Ump overlay blocked if <30 |

---

## Required data — environment

| Field | Definition | Source | Missing = |
|-------|-----------|--------|-----------|
| `park_k_factor` | Park factor K column, current season | FanGraphs park factors | Use 1.00 neutral — flag as missing |
| `weather_temp_at_first_pitch` | Forecast temp at game time (outdoor parks only) | Weather.com / Weatherball | Use historical average if unavailable — flag |
| `weather_wind_speed` | Wind speed forecast at game time | Weather.com | Note if unavailable |
| `weather_wind_direction` | Wind direction at game time | Weather.com | Note if unavailable |
| `is_dome` | Whether the park is a dome/retractable roof closed | Static reference | Required for weather bypass |

---

## Data freshness requirements

| Data type | Maximum age at time of evaluation |
|-----------|----------------------------------|
| Confirmed lineup | Must be official — not projected |
| Pitch count data | Through most recent start |
| Ump assignment | Confirmed same-day |
| Market line | Within 30 minutes of play submission |
| Weather | Within 2 hours of first pitch |
| K/9, K%, SwStr% | Current season, updated through prior day |

---

## Data source priority

For each data type, use sources in this order:

**Pitcher stats:**
1. Baseball Savant (Statcast — most granular)
2. FanGraphs (K%, SwStr%, K/9 calculations)
3. Baseball Reference (game logs, pitch counts)

**Opponent splits:**
1. FanGraphs team splits page (handedness splits, chase rate)
2. Baseball Savant team batting filters

**Market lines:**
1. OddsJam (multi-book comparison, CLV tracking)
2. Unabated odds screen (sharp book focus)
3. Direct book pull (DraftKings, FanDuel, BetMGM, Pinnacle)

**Umpire data:**
1. UmpScorecards.com (primary — K rate, called strike rate)
2. Baseball Reference umpire index (assignment confirmation)

**BvP data:**
1. Baseball Reference player splits vs. specific pitchers
2. FanGraphs batter vs. pitcher tool

**Weather:**
1. Weather.com (hourly forecast at park location)
2. Weatherball (baseball-specific weather tool)

---

## Pre-evaluation checklist

Run this checklist before beginning Step 1. If any required field is missing or stale, halt and note the missing field.

```
PITCHER
[ ] Season K/9 confirmed
[ ] Season starts count confirmed
[ ] Rolling 4-start K/9 confirmed (if ≥4 starts)
[ ] Last 3 pitch counts confirmed
[ ] Current SwStr% confirmed
[ ] IL status checked — no active IL
[ ] Days since last start checked — not ≥10
[ ] Role confirmed — not opener/bulk
[ ] Handedness confirmed

OPPONENT
[ ] Confirmed lineup posted — not projected
[ ] Opp K% vs. handedness L30 confirmed (or season fallback noted)
[ ] Chase rate confirmed (or missing — contact cap check blocked)
[ ] BvP data pulled for confirmed lineup batters

MARKET
[ ] Current line confirmed at active book
[ ] Opening line confirmed (or Block 4 defaults to 0)
[ ] Current juice confirmed
[ ] Best available line checked across books

UMPIRE
[ ] HP umpire assignment confirmed
[ ] UmpScorecards K rate pulled
[ ] Games behind plate confirmed ≥30 (or overlay blocked)

ENVIRONMENT
[ ] Park K factor confirmed
[ ] Outdoor park: weather temp / wind confirmed
[ ] Dome status confirmed if applicable
```