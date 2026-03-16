# system_b/nhl_projector.py
# System B projector for NHL props.
#
# Data source: NHL Stats API (free, official) — https://api-web.nhle.com
# Tier 1 targets (low variance): shots_on_goal, goalie_saves, time_on_ice
# Tier 2 targets (medium variance): pp_points, nhl_1p_total
#
# Key research basis:
#   - SOG props: players have remarkably consistent shooting patterns
#     (behavior bet, not outcome bet)
#   - Goalie saves: expected shots against = predictable from pace + matchup
#   - TOI: coaching deployment is the most stable NHL stat
#   - Goals/assists intentionally EXCLUDED — high variance, puck-luck driven

from __future__ import annotations
import requests
from typing import Optional

from shared.constants import PropType, Sport
from system_b.projection_engine import build_projection_play
from shared.play_schema import ProjectionPlay

NHL_API_BASE = "https://api-web.nhle.com/v1"


# ── NHL API fetch helpers ──────────────────────────────────────────────────────

def _fetch_player_game_log(player_id: int, season: str = "20242025") -> list[dict]:
    """
    Fetch a player's game log from the official NHL API.

    Args:
        player_id: NHL player ID (e.g. 8478402 for Auston Matthews)
        season:    Season string (e.g. "20242025")

    Returns:
        List of game log dicts (most recent last)
    """
    url = f"{NHL_API_BASE}/player/{player_id}/game-log/{season}/2"
    try:
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        return data.get("gameLog", [])
    except Exception as e:
        print(f"[nhl_projector] Failed to fetch game log for player {player_id}: {e}")
        return []


def _fetch_team_game_log(team_abbr: str, season: str = "20242025") -> list[dict]:
    """
    Fetch team schedule/results for 1P total projections.
    """
    url = f"{NHL_API_BASE}/club-schedule-season/{team_abbr}/{season}"
    try:
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        return resp.json().get("games", [])
    except Exception as e:
        print(f"[nhl_projector] Failed to fetch team log for {team_abbr}: {e}")
        return []


def _extract_stat(game_log: list[dict], stat_key: str) -> list[float]:
    """Extract a specific stat from game log entries."""
    values = []
    for game in game_log:
        val = game.get(stat_key)
        if val is not None:
            try:
                values.append(float(val))
            except (ValueError, TypeError):
                continue
    return values


def _toi_to_minutes(toi_str: str) -> float:
    """Convert 'MM:SS' TOI string to decimal minutes."""
    try:
        parts = toi_str.split(":")
        return int(parts[0]) + int(parts[1]) / 60.0
    except Exception:
        return 0.0


# ── Prop: Shots on Goal ────────────────────────────────────────────────────────

def project_shots_on_goal(
    player_id: int,
    player_name: str,
    game: str,
    opponent_rank: int,     # 1=best defense vs shots allowed, 32=worst
    prop_line: Optional[float] = None,
    season: str = "20242025",
) -> Optional[ProjectionPlay]:
    """
    Project shots on goal for a skater.
    Tier 1 — lowest variance NHL prop. Behavior bet, not outcome bet.

    Key factors:
      - Player's rolling SOG average (decay-weighted)
      - Opponent's rank in shots against per game
      - No adjustment for line combinations (captured in historical data)
    """
    game_log = _fetch_player_game_log(player_id, season)
    sog_values = _extract_stat(game_log, "shots")

    if len(sog_values) < 3:
        return None

    reasoning = [
        f"Rolling {min(10, len(sog_values))}-game SOG avg: "
        f"{sum(sog_values[-10:]) / min(10, len(sog_values)):.1f}",
        f"Opponent shots-against rank: {opponent_rank}/32 "
        f"({'favorable' if opponent_rank > 16 else 'tough'} matchup)",
        "SOG: behavior/volume stat — low variance, highly consistent",
    ]

    return build_projection_play(
        sport=Sport.NHL,
        game=game,
        player=player_name,
        prop_type=PropType.SHOTS_OG,
        game_log=sog_values,
        opponent_rank=opponent_rank,
        n_teams=32,
        reasoning=reasoning,
        prop_line=prop_line,
        line_available=prop_line is not None,
    )


# ── Prop: Goalie Saves ─────────────────────────────────────────────────────────

def project_goalie_saves(
    player_id: int,
    player_name: str,
    game: str,
    opponent_shots_pg: float,   # opponent's average shots per game
    team_sa_rank: int,          # team shots-against rank (1=fewest, 32=most)
    prop_line: Optional[float] = None,
    season: str = "20242025",
) -> Optional[ProjectionPlay]:
    """
    Project goalie saves.
    Tier 1 — expected shots against is predictable from pace + matchup.
    """
    game_log = _fetch_player_game_log(player_id, season)
    saves_values = _extract_stat(game_log, "saves")

    if len(saves_values) < 3:
        return None

    reasoning = [
        f"Opponent avg shots/game: {opponent_shots_pg:.1f}",
        f"Team shots-against rank: {team_sa_rank}/32",
        "Goalie saves: volume-driven, predictable from expected shots against",
    ]

    return build_projection_play(
        sport=Sport.NHL,
        game=game,
        player=player_name,
        prop_type=PropType.GK_SAVES,
        game_log=saves_values,
        opponent_rank=team_sa_rank,
        n_teams=32,
        reasoning=reasoning,
        prop_line=prop_line,
        line_available=prop_line is not None,
    )


# ── Prop: Time on Ice ──────────────────────────────────────────────────────────

def project_time_on_ice(
    player_id: int,
    player_name: str,
    game: str,
    is_top_pair_dman: bool = False,   # top-pair D log extra minutes when team is short
    game_is_competitive: bool = True,  # blowouts reduce star TOI
    prop_line: Optional[float] = None,
    season: str = "20242025",
) -> Optional[ProjectionPlay]:
    """
    Project time on ice (minutes).
    Tier 1 — coaching deployment is the most stable NHL stat.
    """
    game_log = _fetch_player_game_log(player_id, season)
    toi_raw = [g.get("toi", "") for g in game_log]
    toi_values = [_toi_to_minutes(t) for t in toi_raw if t]

    if len(toi_values) < 3:
        return None

    reasoning = [
        f"Rolling avg TOI: {sum(toi_values[-10:]) / min(10, len(toi_values)):.1f} min",
        "TOI: coaching deployment — most stable NHL metric",
    ]
    if is_top_pair_dman:
        reasoning.append("Top-pair D: minutes spike when team lacks defensive depth")
    if not game_is_competitive:
        reasoning.append("⚠️ Potential blowout: star TOI may be capped — LOW confidence")

    return build_projection_play(
        sport=Sport.NHL,
        game=game,
        player=player_name,
        prop_type=PropType.TOI,
        game_log=toi_values,
        opponent_rank=16,   # TOI is coaching-driven, not opponent-driven
        n_teams=32,
        reasoning=reasoning,
        prop_line=prop_line,
        line_available=prop_line is not None,
    )


# ── Prop: Power Play Points ────────────────────────────────────────────────────

def project_pp_points(
    player_id: int,
    player_name: str,
    game: str,
    is_pp1_unit: bool,          # on the #1 power play unit
    team_pp_pct: float,         # team power play percentage (e.g. 0.245)
    opponent_pk_rank: int,      # opponent penalty kill rank (1=best PK, 32=worst)
    prop_line: Optional[float] = None,
    season: str = "20242025",
) -> Optional[ProjectionPlay]:
    """
    Project power play points.
    Tier 2 — unit deployment is stable; penalty rate and matchup vary.
    """
    game_log = _fetch_player_game_log(player_id, season)
    pp_values = _extract_stat(game_log, "powerPlayPoints")

    if len(pp_values) < 5:
        return None

    reasoning = [
        f"PP1 unit: {'Yes' if is_pp1_unit else 'No (PP2)'}",
        f"Team PP%: {team_pp_pct*100:.1f}%",
        f"Opponent PK rank: {opponent_pk_rank}/32 "
        f"({'weak PK — favorable' if opponent_pk_rank > 20 else 'strong PK'})",
    ]

    if not is_pp1_unit:
        reasoning.append("⚠️ PP2 unit: lower opportunity volume")

    return build_projection_play(
        sport=Sport.NHL,
        game=game,
        player=player_name,
        prop_type=PropType.PP_POINTS,
        game_log=pp_values,
        opponent_rank=opponent_pk_rank,
        n_teams=32,
        reasoning=reasoning,
        prop_line=prop_line,
        line_available=prop_line is not None,
    )


# ── Prop: NHL 1st Period Total ─────────────────────────────────────────────────

def project_nhl_1p_total(
    home_team: str,
    away_team: str,
    game: str,
    home_1p_goals_log: list[float],   # home team's 1P goals scored, recent games
    away_1p_goals_log: list[float],   # away team's 1P goals scored
    home_1p_allowed_log: list[float], # home team's 1P goals allowed
    away_1p_allowed_log: list[float], # away team's 1P goals allowed
    prop_line: Optional[float] = None,
) -> Optional[ProjectionPlay]:
    """
    Project combined 1st period goal total.
    Tier 2 — period-level scoring has higher variance than full-game,
    but period pace data is modelable. Backed by Sportradar: NHL 3rd period
    is the highest-bet period; 1P lines are softer/less sharp.
    """
    if not home_1p_goals_log or not away_1p_goals_log:
        return None

    home_off_avg  = sum(home_1p_goals_log[-10:]) / min(10, len(home_1p_goals_log))
    away_off_avg  = sum(away_1p_goals_log[-10:]) / min(10, len(away_1p_goals_log))
    home_def_avg  = sum(home_1p_allowed_log[-10:]) / min(10, len(home_1p_allowed_log))
    away_def_avg  = sum(away_1p_allowed_log[-10:]) / min(10, len(away_1p_allowed_log))

    # Simple projection: average of offensive output expectations
    proj = (home_off_avg + away_off_avg + home_def_avg + away_def_avg) / 4.0

    # Build a synthetic game log for the engine (combined goals per game)
    combined_log = [h + a for h, a in zip(
        home_1p_goals_log[-10:], away_1p_goals_log[-10:]
    )]

    reasoning = [
        f"{home_team} 1P avg goals scored: {home_off_avg:.2f}",
        f"{away_team} 1P avg goals scored: {away_off_avg:.2f}",
        f"{home_team} 1P avg goals allowed: {home_def_avg:.2f}",
        f"{away_team} 1P avg goals allowed: {away_def_avg:.2f}",
        "1P lines are softer than full-game — less sharp action",
    ]

    return build_projection_play(
        sport=Sport.NHL,
        game=game,
        player="",   # team prop, no player
        prop_type=PropType.NHL_1P_TOT,
        game_log=combined_log,
        opponent_rank=16,
        n_teams=32,
        reasoning=reasoning,
        prop_line=prop_line,
        line_available=prop_line is not None,
    )
