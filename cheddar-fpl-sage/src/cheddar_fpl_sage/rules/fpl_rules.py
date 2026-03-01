"""
Versioned FPL rules layer (single source of truth).
"""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Any


@dataclass
class Ruleset:
    season_id: str
    version: str
    chip_policy: Dict[str, Any]
    scoring_policy: Dict[str, Any]
    transfer_policy: Dict[str, Any]
    constraints: Dict[str, Any]
    source: str


def load_ruleset(season_id: str, base_dir: Path = Path("config/rulesets")) -> Ruleset:
    """Load a ruleset JSON by season_id."""
    rules_path = base_dir / f"{season_id}.json"
    if not rules_path.exists():
        raise FileNotFoundError(f"Ruleset not found for season {season_id}: {rules_path}")
    with rules_path.open() as f:
        data = json.load(f)
    return Ruleset(
        season_id=data.get("season_id", season_id),
        version=data.get("ruleset_version", "0.0.0"),
        chip_policy=data.get("chip_policy", {}),
        scoring_policy=data.get("scoring_policy", {}),
        transfer_policy=data.get("transfer_policy", {}),
        constraints=data.get("constraints", {}),
        source=str(rules_path),
    )


def get_chip_expiry_status(now_gw: int, ruleset: Ruleset) -> Dict[str, Any]:
    """
    Determine chip expiry urgency based on ruleset chip windows.
    Returns dict with expires_before_next_deadline, expires_at_gw, urgency_level.
    """
    chip_windows = ruleset.chip_policy.get("chip_windows", [])
    for window in chip_windows:
        start_ev = window.get("start_event")
        end_ev = window.get("end_event")
        chips = window.get("chips", [])
        if start_ev is not None and end_ev is not None and start_ev <= now_gw <= end_ev:
            expires = now_gw == end_ev
            urgency = "FORCE_THIS_GW" if expires else "NONE"
            return {
                "expires_before_next_deadline": expires,
                "expires_at_gw": end_ev,
                "urgency_level": urgency,
                "chips_in_window": chips,
            }
    return {
        "expires_before_next_deadline": False,
        "expires_at_gw": None,
        "urgency_level": "NONE",
        "chips_in_window": [],
    }
