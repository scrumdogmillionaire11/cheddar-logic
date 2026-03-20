"""
Tests for manual player fallback behavior.

Known bug: Manual players (ID >= 900000) display as "Player 999999 - $0.0m"
instead of their actual name. This test documents expected behavior.
"""
import pytest
from cheddar_fpl_sage.analysis.decision_framework import (
    TransferAdvisor, is_manual_player, MANUAL_PLAYER_ID_START,
    FALLBACK_PROJECTION_PTS
)


class TestIsManualPlayer:
    """Tests for manual player identification."""

    def test_fpl_player_not_manual(self):
        """Regular FPL player IDs are not manual."""
        assert is_manual_player(1) == False
        assert is_manual_player(100) == False
        assert is_manual_player(500000) == False

    def test_manual_player_id_range(self):
        """IDs >= MANUAL_PLAYER_ID_START are manual."""
        assert is_manual_player(MANUAL_PLAYER_ID_START) == True
        assert is_manual_player(999999) == True
        assert is_manual_player(900001) == True

    def test_boundary_id(self):
        """Boundary at MANUAL_PLAYER_ID_START."""
        assert is_manual_player(MANUAL_PLAYER_ID_START - 1) == False
        assert is_manual_player(MANUAL_PLAYER_ID_START) == True


class TestManualPlayerFallback:
    """Tests for manual player projection fallback."""

    @pytest.fixture
    def transfer_advisor(self):
        return TransferAdvisor()

    def test_fallback_projection_has_correct_name(self, transfer_advisor):
        """Manual player fallback uses actual name, not 'Player XXXXX'."""
        manual_player = {
            'player_id': 999999,
            'name': 'Collins',
            'position': 'DEF',
            'team': 'CRY'
        }
        fallback = transfer_advisor._create_fallback_projection(manual_player)

        # BUG: Currently shows "Player 999999" - should show "Collins"
        assert fallback['name'] == 'Collins'
        assert 'Player 999999' not in fallback['name']

    def test_fallback_projection_uses_constants(self, transfer_advisor):
        """Fallback projection uses centralized constant values."""
        manual_player = {
            'player_id': 900001,
            'name': 'Manual Test',
            'position': 'MID'
        }
        fallback = transfer_advisor._create_fallback_projection(manual_player)

        assert fallback['nextGW_pts'] == FALLBACK_PROJECTION_PTS

    def test_fallback_rejects_non_manual_player(self, transfer_advisor):
        """Calling fallback on regular player raises error."""
        regular_player = {'player_id': 100, 'name': 'Salah'}

        with pytest.raises(ValueError, match="manual"):
            transfer_advisor._create_fallback_projection(regular_player)

    def test_fallback_handles_missing_fields(self, transfer_advisor):
        """Fallback works with minimal player data."""
        minimal = {'player_id': 999999}  # Only ID, no name
        fallback = transfer_advisor._create_fallback_projection(minimal)

        assert fallback['name'] == 'Manual Player'  # Default name
        assert fallback['position'] == 'DEF'  # Default position

    def test_fallback_preserves_team(self, transfer_advisor):
        """Fallback preserves team if provided."""
        manual_player = {
            'player_id': 999999,
            'name': 'Test Player',
            'team': 'BRE'
        }
        fallback = transfer_advisor._create_fallback_projection(manual_player)

        assert fallback['team'] == 'BRE'

    def test_fallback_sets_is_manual_flag(self, transfer_advisor):
        """Fallback projection includes is_manual flag."""
        manual_player = {'player_id': 999999, 'name': 'Test'}
        fallback = transfer_advisor._create_fallback_projection(manual_player)

        assert fallback.get('is_manual') == True


class TestManualPlayerInSquad:
    """Tests for manual players in full squad context."""

    @pytest.fixture
    def advisor_with_squad(self):
        """Advisor with squad containing manual player."""
        return TransferAdvisor(), [
            {'player_id': 1, 'name': 'Salah', 'position': 'MID'},
            {'player_id': 999999, 'name': 'Collins', 'position': 'DEF', 'team': 'CRY'},
            {'player_id': 2, 'name': 'Haaland', 'position': 'FWD'},
        ]

    def test_manual_player_included_in_recommendations(self, advisor_with_squad):
        """Manual player appears correctly in squad analysis."""
        advisor, squad = advisor_with_squad
        projections = {
            1: {'nextGW_pts': 10.0, 'name': 'Salah'},
            2: {'nextGW_pts': 12.0, 'name': 'Haaland'},
            # 999999 NOT in projections - triggers fallback
        }

        # Process squad - manual player should get fallback, not crash
        processed = advisor._ensure_projections(squad, projections)
        collins = next(p for p in processed if p['player_id'] == 999999)

        assert collins['name'] == 'Collins'
        assert collins['nextGW_pts'] == FALLBACK_PROJECTION_PTS

    def test_ensure_projections_merges_data_correctly(self, advisor_with_squad):
        """Ensure projections merges player data with projection data."""
        advisor, squad = advisor_with_squad
        projections = {
            1: {'nextGW_pts': 10.0, 'ceiling': 15.0},
            2: {'nextGW_pts': 12.0, 'ceiling': 18.0},
        }

        processed = advisor._ensure_projections(squad, projections)
        salah = next(p for p in processed if p['player_id'] == 1)

        # Should have both original player data and projection data
        assert salah['name'] == 'Salah'
        assert salah['position'] == 'MID'
        assert salah['nextGW_pts'] == 10.0
        assert salah['ceiling'] == 15.0
