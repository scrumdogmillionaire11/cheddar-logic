"""
Tests for chip window analysis edge cases.

Known bug: Chip window analysis returns "UNAVAILABLE (missing context)"
when chip_windows is empty or scoring fails.
"""
import pytest
from cheddar_fpl_sage.analysis.decision_framework import (
    ChipAnalyzer, ChipRecommendation, CHIP_NAMES
)


class TestEmptyChipWindows:
    """Tests for analysis with no defined chip windows."""

    @pytest.fixture
    def analyzer(self):
        return ChipAnalyzer(risk_posture="BALANCED")

    @pytest.fixture
    def minimal_context(self):
        """Minimal valid analysis context."""
        return {
            'squad_data': {'current_squad': []},
            'fixture_data': {},
            'projections': {},
            'chip_status': {chip: {'available': True} for chip in CHIP_NAMES},
            'current_gw': 20
        }

    def test_empty_windows_returns_recommendation(self, analyzer, minimal_context):
        """Empty chip windows should return valid recommendation, not 'UNAVAILABLE'."""
        minimal_context['chip_policy'] = {'chip_windows': []}

        result = analyzer.analyze_chip_decision(**minimal_context)

        # BUG: Currently returns None or "UNAVAILABLE"
        assert isinstance(result, ChipRecommendation)
        assert "UNAVAILABLE" not in result.reasoning

    def test_empty_windows_recommends_none(self, analyzer, minimal_context):
        """With no windows defined, recommend not using a chip."""
        minimal_context['chip_policy'] = {'chip_windows': []}

        result = analyzer.analyze_chip_decision(**minimal_context)

        assert result.chip == "None"
        assert result.use_this_gw == False

    def test_graceful_fallback_reasoning(self, analyzer, minimal_context):
        """Fallback provides useful reasoning, not error message."""
        minimal_context['chip_policy'] = {'chip_windows': []}

        result = analyzer.analyze_chip_decision(**minimal_context)

        assert "window" in result.reasoning.lower() or "defined" in result.reasoning.lower()
        assert result.confidence == "LOW"  # Low confidence without windows

    def test_none_chip_policy(self, analyzer, minimal_context):
        """None chip_policy handled gracefully."""
        minimal_context['chip_policy'] = None

        result = analyzer.analyze_chip_decision(**minimal_context)

        assert isinstance(result, ChipRecommendation)
        assert result.chip == "None"
        assert "UNAVAILABLE" not in result.reasoning


class TestChipWindowScoring:
    """Tests for chip window scoring edge cases."""

    @pytest.fixture
    def analyzer(self):
        return ChipAnalyzer()

    def test_missing_fixture_data_graceful(self, analyzer):
        """Missing fixture data doesn't crash scoring."""
        context = {
            'squad_data': {'current_squad': [{'player_id': 1}]},
            'fixture_data': {},  # Empty
            'projections': {1: {'nextGW_pts': 5}},
            'chip_status': {chip: {'available': True} for chip in CHIP_NAMES},
            'current_gw': 20,
            'chip_policy': {
                'chip_windows': [{'start_gw': 20, 'end_gw': 25, 'chip': 'Bench Boost'}]
            }
        }

        # Should not crash
        result = analyzer.analyze_chip_decision(**context)
        assert isinstance(result, ChipRecommendation)

    def test_window_outside_current_gw(self, analyzer):
        """Windows not containing current GW handled correctly."""
        context = {
            'squad_data': {'current_squad': []},
            'fixture_data': {},
            'projections': {},
            'chip_status': {chip: {'available': True} for chip in CHIP_NAMES},
            'current_gw': 10,
            'chip_policy': {
                'chip_windows': [{'start_gw': 30, 'end_gw': 35, 'chip': 'Wildcard'}]
            }
        }

        result = analyzer.analyze_chip_decision(**context)

        # Current GW not in any window
        assert result.use_this_gw == False
        assert result.optimal_window_gw == 30  # Suggests future window


class TestChipAvailability:
    """Tests for chip status handling."""

    @pytest.fixture
    def analyzer(self):
        return ChipAnalyzer()

    def test_unavailable_chip_not_recommended(self, analyzer):
        """Already-used chip not recommended."""
        context = {
            'squad_data': {'current_squad': []},
            'fixture_data': {},
            'projections': {},
            'chip_status': {
                'Wildcard': {'available': False, 'played_gw': 5},
                'Free Hit': {'available': True},
                'Bench Boost': {'available': True},
                'Triple Captain': {'available': True}
            },
            'current_gw': 20,
            'chip_policy': {
                'chip_windows': [{'start_gw': 20, 'end_gw': 20, 'chip': 'Wildcard'}]
            }
        }

        result = analyzer.analyze_chip_decision(**context)

        # Can't recommend Wildcard - already played
        if result.chip == "Wildcard":
            pytest.fail("Recommended unavailable chip")

    def test_all_chips_used_returns_none(self, analyzer):
        """When all chips used, returns None chip."""
        context = {
            'squad_data': {'current_squad': []},
            'fixture_data': {},
            'projections': {},
            'chip_status': {chip: {'available': False, 'played_gw': i}
                          for i, chip in enumerate(CHIP_NAMES)},
            'current_gw': 20,
            'chip_policy': {'chip_windows': []}
        }

        result = analyzer.analyze_chip_decision(**context)

        assert result.chip == "None"
        assert "no chips available" in result.reasoning.lower() or \
               "all chips" in result.reasoning.lower()


class TestChipAnalyzerInterface:
    """Tests for ChipAnalyzer public interface."""

    def test_analyze_chip_decision_method_exists(self):
        """ChipAnalyzer has analyze_chip_decision method."""
        analyzer = ChipAnalyzer()
        assert hasattr(analyzer, 'analyze_chip_decision')
        assert callable(analyzer.analyze_chip_decision)

    def test_returns_chip_recommendation_type(self):
        """Method returns ChipRecommendation model."""
        analyzer = ChipAnalyzer()
        result = analyzer.analyze_chip_decision(
            squad_data={'current_squad': []},
            fixture_data={},
            projections={},
            chip_status={chip: {'available': True} for chip in CHIP_NAMES},
            current_gw=20,
            chip_policy={'chip_windows': []}
        )

        assert isinstance(result, ChipRecommendation)
        # Verify all required fields are present
        assert hasattr(result, 'chip')
        assert hasattr(result, 'use_this_gw')
        assert hasattr(result, 'reasoning')
        assert hasattr(result, 'confidence')
