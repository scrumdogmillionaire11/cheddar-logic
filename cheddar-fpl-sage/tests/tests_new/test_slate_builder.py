
from cheddar_fpl_sage.transformers.slate_builder import build_slate


def test_blank_and_double_detection_and_ordering():
    fixtures = [
        {"id": 2, "event": 3, "team_h": 1, "team_a": 2, "kickoff_time": "2025-01-02T12:00:00Z"},
        {"id": 1, "event": 3, "team_h": 1, "team_a": 3, "kickoff_time": "2025-01-01T12:00:00Z"},
        {"id": 5, "event": 4, "team_h": 5, "team_a": 6, "kickoff_time": "2025-01-03T12:00:00Z"},  # different GW
    ]
    teams_map = {i: {} for i in range(1, 7)}

    slate = build_slate(fixtures, teams_map, target_gw=3)

    assert slate["fixture_count"] == 2
    # Ordered by kickoff_time then fixture_id
    assert [fx["fixture_id"] for fx in slate["fixtures"]] == [1, 2]
    # Team 1 plays twice → double
    assert slate["double_teams"] == [1]
    # Teams 4, 5 and 6 missing from GW3 fixtures → blanks
    assert slate["blank_teams"] == [4, 5, 6]
