"""
Identity consistency validation: ensures player_id -> team_id mapping is stable.
"""

from typing import List, Dict


def validate_player_identity(canonical_players: List[Dict], rendered_sections: List[List[Dict]]) -> None:
    """
    Validate that player_id -> team_id is consistent across rendered sections.
    Raises ValueError with block_reason DATA_INTEGRITY on mismatch.
    """
    id_to_team = {}
    for player in canonical_players or []:
        pid = player.get("player_id") or player.get("id")
        team_id = player.get("team_id") or player.get("team_code") or player.get("team")
        if pid is None:
            continue
        id_to_team[pid] = team_id

    for section in rendered_sections or []:
        for item in section or []:
            pid = None
            team_id = None
            if isinstance(item, dict):
                pid = item.get("player_id") or item.get("id")
                team_id = item.get("team_id") or item.get("team_code") or item.get("team")
            if pid is None:
                continue
            canonical_team = id_to_team.get(pid)
            if canonical_team is None or team_id is None:
                # If we can't validate, skip silently to avoid false positives
                continue
            if str(canonical_team) != str(team_id):
                raise ValueError(f"DATA_INTEGRITY: player_id {pid} has conflicting team_id {team_id} vs {canonical_team}")
