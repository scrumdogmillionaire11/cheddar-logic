import json
from pathlib import Path


def _extract_transfer_names(transfer: dict) -> tuple[str, str]:
    """Support both legacy and current manual transfer field names."""
    player_out = transfer.get("out_name") or transfer.get("player_out", "")
    player_in = transfer.get("in_name") or transfer.get("player_in", "")
    return player_out, player_in


def test_team_config_manual_overrides_is_safe_to_read() -> None:
    config_path = Path("config/team_config.json")
    with config_path.open() as f:
        config = json.load(f)

    manual_overrides = config.get("manual_overrides") or {}
    planned_transfers = manual_overrides.get("planned_transfers", [])

    assert isinstance(planned_transfers, list)


def test_manual_transfer_field_name_compatibility() -> None:
    legacy = {"out_name": "Salah", "in_name": "Palmer"}
    current = {"player_out": "Haaland", "player_in": "Watkins"}

    assert _extract_transfer_names(legacy) == ("Salah", "Palmer")
    assert _extract_transfer_names(current) == ("Haaland", "Watkins")
