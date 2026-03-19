#!/usr/bin/env python3
"""
fetch_fbref_xg.py — Pull rolling xG data from FBref via soccerdata library.

Outputs a JSON array to stdout. Each row:
  {
    "league": "EPL",          // EPL | MLS | UCL
    "team_name": "Arsenal",
    "home_xg_l6": 1.83,       // weighted rolling average (last 6 home games)
    "away_xg_l6": 1.42        // weighted rolling average (last 6 away games)
  }

Exit codes:
  0 = success (JSON written to stdout)
  1 = FBref unavailable or soccerdata not installed (error to stderr, empty JSON [])

Called from pull_soccer_xg_stats.js via child_process.spawn.

Recency weighting:
  Game weights (oldest → newest): 1, 1, 1, 1, 1.5, 2
  Most recent game = 2x weight. Second-most recent = 1.5x.
  This matches the spec §2.2.1: "most recent game = 2x weight".
"""

import json
import sys

# League mapping: internal key → soccerdata league ID
LEAGUE_MAP = {
    "EPL": "ENG-Premier League",
    "MLS": "USA-Major League Soccer",
    "UCL": "EUR-UEFA Champions League",
}

# Recency weights for last 6 games (oldest first)
RECENCY_WEIGHTS = [1, 1, 1, 1, 1.5, 2]


def weighted_avg(values, weights):
    """Compute weighted average of values with given weights."""
    if not values:
        return None
    pairs = list(zip(values[-len(weights):], weights[-len(values):]))
    total_weight = sum(w for _, w in pairs)
    if total_weight == 0:
        return None
    return sum(v * w for v, w in pairs) / total_weight


def fetch_league_xg(league_key, soccerdata_league):
    """Fetch rolling xG for all teams in a league. Returns list of dicts."""
    try:
        import soccerdata as sd  # noqa: PLC0415
    except ImportError:
        raise RuntimeError("soccerdata not installed")

    try:
        fbref = sd.FBref(leagues=[soccerdata_league], seasons="2024-2025")
        schedule = fbref.read_schedule()
    except Exception as exc:
        raise RuntimeError(f"FBref unavailable for {league_key}: {exc}") from exc

    # Build rolling xG per team, splitting home vs away
    home_games = {}   # team_name -> list of (matchweek, xg)
    away_games = {}   # team_name -> list of (matchweek, xg)

    xg_col_home = None
    xg_col_away = None

    # Probe column names (soccerdata versions use different names)
    sample_cols = list(schedule.columns) if hasattr(schedule, "columns") else []
    for col in sample_cols:
        col_lower = str(col).lower()
        if "xg" in col_lower and "home" in col_lower:
            xg_col_home = col
        if "xg" in col_lower and "away" in col_lower:
            xg_col_away = col

    # Fallback column names used by soccerdata ≥0.3
    if xg_col_home is None:
        for candidate in ("home_xg", "xg_home", "xG_home"):
            if candidate in sample_cols:
                xg_col_home = candidate
                break
    if xg_col_away is None:
        for candidate in ("away_xg", "xg_away", "xG_away"):
            if candidate in sample_cols:
                xg_col_away = candidate
                break

    if xg_col_home is None or xg_col_away is None:
        raise RuntimeError(
            f"Could not locate xG columns in FBref schedule for {league_key}. "
            f"Available: {sample_cols}"
        )

    for _, row in schedule.iterrows():
        home_team = str(row.get("home_team", row.get("home", ""))).strip()
        away_team = str(row.get("away_team", row.get("away", ""))).strip()
        try:
            h_xg = float(row[xg_col_home])
            a_xg = float(row[xg_col_away])
        except (TypeError, ValueError):
            continue  # Skip unplayed / NaN rows

        if not home_team or not away_team:
            continue

        home_games.setdefault(home_team, []).append(h_xg)
        away_games.setdefault(away_team, []).append(a_xg)

    # Compute rolling weighted averages for each team
    all_teams = set(home_games.keys()) | set(away_games.keys())
    results = []
    for team in sorted(all_teams):
        home_vals = home_games.get(team, [])[-6:]
        away_vals = away_games.get(team, [])[-6:]

        home_xg_l6 = weighted_avg(home_vals, RECENCY_WEIGHTS) if home_vals else None
        away_xg_l6 = weighted_avg(away_vals, RECENCY_WEIGHTS) if away_vals else None

        # Round to 4dp for clean storage
        results.append(
            {
                "league": league_key,
                "team_name": team,
                "home_xg_l6": round(home_xg_l6, 4) if home_xg_l6 is not None else None,
                "away_xg_l6": round(away_xg_l6, 4) if away_xg_l6 is not None else None,
            }
        )

    return results


def main():
    all_results = []
    errors = []

    for league_key, soccerdata_league in LEAGUE_MAP.items():
        try:
            rows = fetch_league_xg(league_key, soccerdata_league)
            all_results.extend(rows)
            print(f"[fetch_fbref_xg] {league_key}: {len(rows)} teams", file=sys.stderr)
        except RuntimeError as exc:
            errors.append(str(exc))
            print(f"[fetch_fbref_xg] WARNING: {league_key} failed: {exc}", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001
            errors.append(str(exc))
            print(
                f"[fetch_fbref_xg] WARNING: {league_key} unexpected error: {exc}",
                file=sys.stderr,
            )

    # Always write JSON to stdout (even if partial / empty — caller is fail-open)
    print(json.dumps(all_results))

    # Exit 1 only if ALL leagues failed with no data at all
    if not all_results and errors:
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
