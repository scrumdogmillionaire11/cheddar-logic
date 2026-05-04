# 08 — Data requirements & confidence cap enforcement

## Rule

Current runtime can emit degraded/synthetic PASS rows when some inputs are missing, but it must not emit actionable plays without verified market data. Missing fields must be recorded in `missing_inputs` and `reason_codes`.

**WI-1255 extension:** Missing trap prerequisites trigger confidence caps in Step 6.5, which may downgrade posture, mark cards non-actionable, or suppress output entirely. See "Confidence cap enforcement" section below.

---

## Required data — pitcher

All pitcher inputs must be confirmed before Step 1 begins.

| Field | Definition | Source | Missing = |
|-------|-----------|--------|-----------|
| `season_k_pct` | Full-season K% | Baseball Savant, FanGraphs | PASS fallback / HALT if insufficient starts |
| `season_starts` | Number of starts this season | Baseball Reference | Halt |
| `rolling_4start_k_pct` | K% over last 4 starts | Game log compilation | Degrade if unavailable |
| `last_three_pitch_counts` | Pitches thrown in each of last 3 starts | Baseball Reference game logs | Degrade if `recent_ip` / `avg_ip` also unavailable |
| `current_swstr_pct` | Season swinging-strike rate | Baseball Savant | Degrade with whiff proxy |
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
| `opp_obp` | Opp OBP vs pitcher handedness | FanGraphs team splits | Use neutral fallback and flag |
| `opp_xwoba` | Opp xwOBA vs pitcher handedness | FanGraphs / Savant | Use neutral fallback and flag |
| `opp_hard_hit_pct` | Opp hard-hit% vs pitcher handedness | FanGraphs / Savant | Use neutral fallback and flag |
| `bvp_data` | Historical matchup PA/K for each confirmed batter | Baseball Reference splits | BvP overlay blocked |

---

## Confidence cap enforcement (WI-1255)

**Applied in Step 6.5 — after scoring completes, before final verdict emission.**

When critical trap prerequisites are missing or stale, confidence is hard-capped to prevent false signals. See `docs/pitcher_ks/scoring.md` for full rule table.

### Freshness gates

| Field | Acceptable values | Missing → | Cap rule |
|-------|-------------------|-----------|----------|
| `opp_profile_staleness` | FRESH, STALE, STATIC_FALLBACK | (diagnostic provided by trap scan) | Rule 3 or 2 |
| `leash_bucket` | LONG, STANDARD, SHORT, UNKNOWN | (diagnostic provided by trap scan) | Rule 4 or 5 |
| `opp_k_bucket` | HIGH_K, MID_K, LOW_K | (diagnostic provided by trap scan) | Rule 6 |

**When BOTH `opp_profile_staleness ∈ {STALE, STATIC_FALLBACK}` AND `leash_bucket = UNKNOWN`:** Output marked for exclusion; card does not appear in candidate list.

### Impact on card payload

| Field | Updated value | Condition |
|-------|----------------|-----------|
| `posture` | Capped to allowed value | One of rules 1–6 applies |
| `confidence_cap_reason` | Reason code string | Cap rule triggered; null if no cap |
| Card excluded from output | Yes | Rule 6 suppression (both conditions met) |

---

## Market data — currently deferred

There is no current live line requirement for MLB pitcher-K cards. Runtime cards must set `basis='PROJECTION_ONLY'`, `prediction='PASS'`, `line=null`, and `pass_reason_code='PASS_PROJECTION_ONLY_NO_MARKET'`.

A separate follow-up WI must evaluate free DraftKings/FanDuel scraping first, then OddsTrader/OddsJam as fallback candidates, and define a standard + alt-line schema before any market comparison path is re-enabled.

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
| Market line | Not used in current runtime |
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

**Market lines (future work only):**
1. Direct book pull/scrape from DraftKings or FanDuel
2. OddsTrader UI scrape
3. OddsJam limited free access

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
[ ] Season K% confirmed
[ ] Season starts count confirmed
[ ] Rolling 4-start K% confirmed (if ≥4 starts)
[ ] Last 3 pitch counts confirmed
[ ] Current SwStr% confirmed
[ ] IL status checked — no active IL
[ ] Days since last start checked — not ≥10
[ ] Role confirmed — not opener/bulk
[ ] Handedness confirmed

OPPONENT
[ ] Confirmed lineup posted — not projected
[ ] Opp K% vs. handedness L30 confirmed (or season fallback noted)
[ ] Opp OBP / xwOBA / hard-hit profile confirmed or neutral fallback flagged
[ ] BvP data pulled for confirmed lineup batters

MARKET
[ ] Current runtime remains projection-only PASS with no live line
[ ] If restoring lines, use a separate WI/ADR and verify standard + alt-line parser quality first

UMPIRE
[ ] HP umpire assignment confirmed
[ ] UmpScorecards K rate pulled
[ ] Games behind plate confirmed ≥30 (or overlay blocked)

ENVIRONMENT
[ ] Park K factor confirmed
[ ] Outdoor park: weather temp / wind confirmed
[ ] Dome status confirmed if applicable
```
