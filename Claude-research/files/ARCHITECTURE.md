# Cheddar Board — Full Engine Architecture
# Two-system design: Market Edge Finder (A) + Projection Engine (B)
# These systems NEVER mix outputs. Tagged at schema level.

## RULE #1: system_a outputs never contain proj_value
## RULE #2: system_b outputs never contain edge_pct
## RULE #3: When Odds API has a prop line AND system_b has a projection → discard edge, show projection only

---

## SHARED LAYER (shared/)

| File | Purpose | Key Inputs | Key Outputs |
|------|---------|-----------|------------|
| play_schema.py | Canonical output object for both systems | raw model dict | typed PlayResult dataclass |
| sigma_config.py | Sport+market sigma values for edge math | sport, market_type | sigma float |
| kelly.py | Partial Kelly (0.5x) stake sizing | edge_pct, bankroll | units float |
| constants.py | Tiers, thresholds, market type strings | — | HOT/WATCH/PASS cutoffs |

---

## SYSTEM A — Market Edge Finder (system_a/)

| File | Purpose | Data Source | Markets Covered |
|------|---------|------------|----------------|
| odds_api_client.py | Fetch + normalize lines, remove vig | The Odds API | All game markets |
| market_router.py | Route sport+market_type to correct model | odds_api_client | All sports |
| nfl_model.py | NFL edge computation | Odds API | situational_total, div_dog_spread, rlm_spread, alt_spread |
| mlb_model.py | MLB edge computation | Odds API | f5_moneyline, underdog_ml, total, runline_dog |
| nba_model.py | NBA edge computation | Odds API | total_pace, alt_spread_rest, moneyline |
| nhl_model.py | NHL edge computation | Odds API | total_over, moneyline_incl_ot |
| epl_model.py | EPL edge computation | Odds API | home_win_xg, asian_handicap |
| ncaam_model.py | NCAAM edge computation | Odds API | mid_major_spread, total_pace, slight_dog_ml |
| mls_model.py | MLS edge computation | Odds API | home_win_xg, asian_handicap, total |
| ucl_model.py | UCL edge computation | Odds API | asian_handicap, home_win_xg, btts |
| edge_engine.py | computeEdgePct() — market-aware, sport-aware | model outputs + sigma_config | edge_pct float |

---

## SYSTEM B — Projection Engine (system_b/)

| File | Purpose | Data Source | Props Covered |
|------|---------|------------|--------------|
| stats_client.py | Unified fetch layer for all stat APIs | nba_api / pybaseball / nhl_api / fbref | Raw player/team stats |
| projection_router.py | Route sport+prop_type to correct projector | stats_client | All props |
| nfl_projector.py | NFL prop projections | pybaseball/nfl data | rush_yds, rec_yds, rec, pass_yds |
| mlb_projector.py | MLB prop projections | pybaseball | pitcher_k, outs_recorded, batter_k, hits |
| nba_projector.py | NBA prop projections | nba_api | points, rebounds, assists, pra |
| nhl_projector.py | NHL prop projections | nhl_api | shots_on_goal, saves, toi, pp_points, 1p_total |
| epl_projector.py | EPL prop projections | fbref/statsbomb | shots_on_target, gk_saves, passes |
| ncaam_projector.py | NCAAM prop projections | sports-reference | points, rebounds, assists |
| mls_projector.py | MLS prop projections | fbref | shots_on_target, gk_saves |
| ucl_projector.py | UCL prop projections | fbref/statsbomb | shots_on_target, gk_saves, btts |
| projection_engine.py | Core projection math: rolling avg + matchup adj + confidence band | projector outputs | proj_value, floor, ceiling, confidence, recommended_side |

---

## TRACKING LAYER (tracking/)

| File | Purpose | Inputs | Outputs |
|------|---------|--------|--------|
| win_rate_tracker.py | Log recommended side + actual result, compute rolling win rate per prop type | play_id, recommended_side, actual_result | win_rate by sport/prop_type, recalibration flags |
| recalibration_flag.py | Flag System B models when rolling win rate drops below threshold | win_rate_tracker | alert: model needs recalibration |
| play_log.db | SQLite store for all plays from both systems | play_schema outputs | queryable history |

---

## OUTPUT SCHEMA (play_schema.py)

### System A Play
```python
{
  "system": "edge",
  "play_id": "uuid",
  "sport": "NFL",
  "game": "BUF @ NYJ",
  "market_type": "situational_total",
  "pick": "UNDER 44.5",
  "edge_pct": 6.2,
  "tier": "HOT",          # HOT >5% | WATCH 3-5% | PASS <3%
  "kelly_stake": 2.1,
  "reasoning": ["cold weather", "two defensive teams", "pace mismatch"],
  "generated_at": "2025-03-15T10:00:00Z"
}
```

### System B Play
```python
{
  "system": "projection",
  "play_id": "uuid",
  "sport": "NBA",
  "player": "Nikola Jokic",
  "prop_type": "pra",
  "proj_value": 54.2,
  "floor": 48.0,
  "ceiling": 61.0,
  "recommended_side": "OVER",
  "confidence": "HIGH",   # HIGH σ<3 | MEDIUM σ3-6 | LOW σ>6
  "reasoning": ["elite matchup vs weak interior", "pace advantage", "usage 34%"],
  "generated_at": "2025-03-15T10:00:00Z"
  # NOTE: edge_pct intentionally absent
  # NOTE: kelly_stake intentionally absent
}
```

---

## BUILD ORDER
1. shared/constants.py
2. shared/sigma_config.py
3. shared/kelly.py
4. shared/play_schema.py
5. system_a/odds_api_client.py
6. system_a/edge_engine.py
7. system_a/market_router.py
8. system_a/[sport]_model.py x8
9. system_b/stats_client.py
10. system_b/projection_engine.py
11. system_b/projection_router.py
12. system_b/[sport]_projector.py x8
13. tracking/play_log.db (schema)
14. tracking/win_rate_tracker.py
15. tracking/recalibration_flag.py

## TOTAL FILES: 33
