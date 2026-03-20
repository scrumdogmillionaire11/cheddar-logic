"""
Integration tests for Phase 1 CLI stabilization.

Verifies the complete analysis flow works with:
- Manual players in squad
- Empty chip windows
- Missing projections
- Config round-tripping
"""
import pytest

from cheddar_fpl_sage.analysis.decision_framework import (
    ChipAnalyzer, TransferAdvisor, CaptainSelector, OutputFormatter,
    TeamConfig,
    is_manual_player, CHIP_NAMES, FALLBACK_PROJECTION_PTS
)


class TestFullAnalysisFlow:
    """Tests for complete analysis with edge cases."""

    @pytest.fixture
    def squad_with_manual_player(self):
        """Squad containing manual player Collins."""
        return [
            {'player_id': 100, 'name': 'Onana', 'position': 'GKP', 'team': 'AVL'},
            {'player_id': 101, 'name': 'Saliba', 'position': 'DEF', 'team': 'ARS'},
            {'player_id': 999999, 'name': 'Collins', 'position': 'DEF', 'team': 'CRY'},
            {'player_id': 103, 'name': 'Gabriel', 'position': 'DEF', 'team': 'ARS'},
            {'player_id': 104, 'name': 'Saka', 'position': 'MID', 'team': 'ARS'},
            {'player_id': 105, 'name': 'Salah', 'position': 'MID', 'team': 'LIV'},
        ]

    @pytest.fixture
    def projections_without_manual(self):
        """Projections missing the manual player."""
        return {
            100: {'name': 'Onana', 'nextGW_pts': 4.0},
            101: {'name': 'Saliba', 'nextGW_pts': 5.5},
            # 999999 MISSING - manual player
            103: {'name': 'Gabriel', 'nextGW_pts': 5.0},
            104: {'name': 'Saka', 'nextGW_pts': 7.5},
            105: {'name': 'Salah', 'nextGW_pts': 9.0},
        }

    def test_manual_player_gets_fallback_in_analysis(
        self, squad_with_manual_player, projections_without_manual
    ):
        """Manual player handled correctly in full analysis."""
        advisor = TransferAdvisor()

        # Process squad with missing projection
        processed = advisor._ensure_projections(
            squad_with_manual_player,
            projections_without_manual
        )

        # Find Collins
        collins = next(p for p in processed if p['player_id'] == 999999)

        # Should have name and fallback projection
        assert collins['name'] == 'Collins'
        assert collins['nextGW_pts'] == FALLBACK_PROJECTION_PTS

    def test_empty_windows_produces_valid_chip_rec(self):
        """Empty chip windows still produces valid chip recommendation."""
        analyzer = ChipAnalyzer()

        chip_rec = analyzer.analyze_chip_decision(
            squad_data={'current_squad': []},
            fixture_data={},
            projections={},
            chip_status={c: {'available': True} for c in CHIP_NAMES},
            current_gw=20,
            chip_policy={'chip_windows': []}
        )

        # Should be valid recommendation
        assert chip_rec.chip == "None"
        assert "UNAVAILABLE" not in chip_rec.reasoning

    def test_transfer_advisor_handles_empty_squad(self):
        """TransferAdvisor handles empty squad gracefully."""
        advisor = TransferAdvisor()

        # Empty squad should not crash
        processed = advisor._ensure_projections([], {})
        assert processed == []

    def test_transfer_advisor_handles_no_projections(self, squad_with_manual_player):
        """TransferAdvisor handles missing all projections."""
        advisor = TransferAdvisor()

        # No projections at all - manual player should get fallback
        processed = advisor._ensure_projections(squad_with_manual_player, {})

        # Manual player should have fallback
        collins = next(p for p in processed if p['player_id'] == 999999)
        assert collins['nextGW_pts'] == FALLBACK_PROJECTION_PTS

        # Regular players should still be in list (no projection data added)
        salah = next(p for p in processed if p['player_id'] == 105)
        assert salah['name'] == 'Salah'


class TestConfigRoundTrip:
    """Tests for config serialization stability."""

    def test_config_survives_save_reload(self, tmp_path):
        """Config identical after write/read cycle."""
        config_file = tmp_path / "test_config.json"

        original = TeamConfig(
            manager_id=12345,
            manager_name="Test Manager",
            risk_posture="AGGRESSIVE",  # Will be normalized from CHASE
            manual_free_transfers=2
        )

        # Write
        config_file.write_text(original.model_dump_json(indent=2))

        # Read
        reloaded = TeamConfig.model_validate_json(config_file.read_text())

        assert reloaded.manager_id == original.manager_id
        assert reloaded.manager_name == original.manager_name
        assert reloaded.risk_posture == original.risk_posture
        assert reloaded.manual_free_transfers == original.manual_free_transfers

    def test_config_normalizes_legacy_risk_posture(self):
        """Config normalizes legacy CHASE/DEFEND to canonical values."""
        # CHASE -> AGGRESSIVE
        config_chase = TeamConfig(risk_posture="CHASE")
        assert config_chase.risk_posture == "AGGRESSIVE"

        # DEFEND -> CONSERVATIVE
        config_defend = TeamConfig(risk_posture="DEFEND")
        assert config_defend.risk_posture == "CONSERVATIVE"

        # BALANCED stays BALANCED
        config_balanced = TeamConfig(risk_posture="BALANCED")
        assert config_balanced.risk_posture == "BALANCED"

    def test_config_handles_empty_chip_status(self):
        """Config handles empty chip status gracefully."""
        config = TeamConfig(manual_chip_status={})

        # Should have all chips available by default
        assert "Wildcard" in config.manual_chip_status
        # ChipStatus is a Pydantic model, use attribute access
        assert config.manual_chip_status["Wildcard"].available == True

    def test_config_handles_none_values(self):
        """Config handles None for optional fields."""
        config = TeamConfig(
            manager_id=123,
            manual_overrides=None,
            chip_policy=None
        )

        assert config.manual_overrides is None
        assert config.chip_policy is not None  # Should have default


class TestExceptionHandling:
    """Tests for proper exception handling."""

    def test_invalid_input_raises_specific_error(self):
        """Invalid inputs raise domain-specific errors, not generic Exception."""
        advisor = TransferAdvisor()

        # Calling fallback on non-manual player should raise ValueError
        with pytest.raises(ValueError, match="manual"):
            advisor._create_fallback_projection({'player_id': 100})

    def test_manual_player_boundary(self):
        """Test exact boundary of manual player detection."""
        # Just below boundary - not manual
        assert is_manual_player(899999) == False

        # Exactly at boundary - is manual
        assert is_manual_player(900000) == True

        # Above boundary - is manual
        assert is_manual_player(900001) == True


class TestModuleExports:
    """Tests that all expected exports are available from decision_framework."""

    def test_all_classes_exported(self):
        """Key classes are exported from decision_framework package."""
        from cheddar_fpl_sage.analysis.decision_framework import (
            ChipAnalyzer,
            TransferAdvisor,
            TeamConfig,
        )
        # Just checking imports work
        assert ChipAnalyzer is not None
        assert TransferAdvisor is not None
        assert CaptainSelector is not None
        assert OutputFormatter is not None
        assert TeamConfig is not None

    def test_all_constants_exported(self):
        """Key constants are exported from decision_framework package."""
        from cheddar_fpl_sage.analysis.decision_framework import (
            CHIP_NAMES,
            FALLBACK_PROJECTION_PTS,
            MANUAL_PLAYER_ID_START,
            is_manual_player,
        )
        assert CHIP_NAMES is not None
        assert FALLBACK_PROJECTION_PTS == 5.0
        assert MANUAL_PLAYER_ID_START == 900000
        assert callable(is_manual_player)


class TestChipAnalyzerIntegration:
    """Integration tests for ChipAnalyzer with realistic scenarios."""

    def test_chip_recommendation_with_valid_window(self):
        """ChipAnalyzer recommends chip when in valid window."""
        analyzer = ChipAnalyzer()

        result = analyzer.analyze_chip_decision(
            squad_data={'current_squad': []},
            fixture_data={},
            projections={},
            chip_status={c: {'available': True} for c in CHIP_NAMES},
            current_gw=20,
            chip_policy={
                'chip_windows': [
                    {'start_gw': 18, 'end_gw': 22, 'chip': 'Bench Boost'}
                ]
            }
        )

        # Should recommend Bench Boost
        assert result.chip == 'Bench Boost'
        assert result.use_this_gw == True
        assert result.confidence == "HIGH"

    def test_chip_recommendation_respects_availability(self):
        """ChipAnalyzer respects chip availability status."""
        analyzer = ChipAnalyzer()

        # Bench Boost already used
        result = analyzer.analyze_chip_decision(
            squad_data={'current_squad': []},
            fixture_data={},
            projections={},
            chip_status={
                'Bench Boost': {'available': False, 'played_gw': 10},
                'Triple Captain': {'available': True},
                'Free Hit': {'available': True},
                'Wildcard': {'available': True},
            },
            current_gw=20,
            chip_policy={
                'chip_windows': [
                    {'start_gw': 18, 'end_gw': 22, 'chip': 'Bench Boost'}
                ]
            }
        )

        # Should NOT recommend Bench Boost - it's unavailable
        assert result.chip != 'Bench Boost'
