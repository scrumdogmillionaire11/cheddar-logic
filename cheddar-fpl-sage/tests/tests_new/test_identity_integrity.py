import pytest

from cheddar_fpl_sage.validation.id_integrity import validate_player_identity


def test_identity_mismatch_raises():
    canonical_players = [
        {"player_id": 1, "team_id": 100},
        {"player_id": 2, "team_id": 200},
    ]
    rendered_sections = [
        [{"player_id": 1, "team_id": 100}],
        [{"player_id": 2, "team_id": 999}],  # conflicting team_id
    ]

    with pytest.raises(ValueError) as exc:
        validate_player_identity(canonical_players, rendered_sections)

    assert "DATA_INTEGRITY" in str(exc.value)


def test_identity_ok_no_raise():
    canonical_players = [
        {"player_id": 1, "team_id": 100},
        {"player_id": 2, "team_id": 200},
    ]
    rendered_sections = [
        [{"player_id": 1, "team_id": 100}],
        [{"player_id": 2, "team_id": 200}],
    ]

    # Should not raise
    validate_player_identity(canonical_players, rendered_sections)
