"""Tests for PlayerRegistry service — exact match, fuzzy match, no-match, construction."""
import pytest

from backend.services.player_registry import PlayerRegistry


SAMPLE_PLAYERS = {
    1: "Mohamed Salah",
    2: "Erling Haaland",
    3: "Bukayo Saka",
    4: "Trent Alexander-Arnold",
    5: "Alisson",
    6: "Virgil van Dijk",
}


class TestPlayerRegistryConstruction:
    """Registry loads players at construction."""

    def setup_method(self):
        self.registry = PlayerRegistry(players=SAMPLE_PLAYERS)

    def test_registry_loads_all_players(self):
        """All provided players are searchable after construction."""
        result = self.registry.match("Mohamed Salah")
        assert result.player_id == 1

    def test_registry_with_single_player(self):
        """Registry works with minimal player dict."""
        reg = PlayerRegistry(players={99: "Test Player"})
        result = reg.match("Test Player")
        assert result.player_id == 99

    def test_registry_with_empty_players(self):
        """Registry handles empty player dict without crashing."""
        reg = PlayerRegistry(players={})
        result = reg.match("Salah")
        assert result.player_id is None
        assert result.confidence == 0.0


class TestExactMatch:
    """Exact match returns confidence 1.0 with empty candidates."""

    def setup_method(self):
        self.registry = PlayerRegistry(players=SAMPLE_PLAYERS)

    def test_exact_match_confidence_is_1(self):
        result = self.registry.match("Mohamed Salah")
        assert result.confidence == 1.0

    def test_exact_match_returns_correct_player_id(self):
        result = self.registry.match("Mohamed Salah")
        assert result.player_id == 1

    def test_exact_match_has_empty_candidates(self):
        result = self.registry.match("Mohamed Salah")
        assert result.candidates == []

    def test_exact_match_haaland(self):
        result = self.registry.match("Erling Haaland")
        assert result.player_id == 2
        assert result.confidence == 1.0

    def test_exact_match_display_name_returned(self):
        result = self.registry.match("Bukayo Saka")
        assert result.display_name == "Bukayo Saka"


class TestFuzzyMatch:
    """Fuzzy match (ratio >= 0.8) returns confidence=ratio with top-3 candidates."""

    def setup_method(self):
        self.registry = PlayerRegistry(players=SAMPLE_PLAYERS)

    def test_fuzzy_match_misspelled_salah(self):
        result = self.registry.match("Salaah")
        assert result.confidence >= 0.8
        assert result.player_id is not None

    def test_fuzzy_match_salah_in_candidates(self):
        result = self.registry.match("Salaah")
        # Either resolved as Salah or Salah appears in candidates
        resolved_or_candidate = (
            result.display_name == "Mohamed Salah"
            or any(c.display_name == "Mohamed Salah" for c in result.candidates)
        )
        assert resolved_or_candidate

    def test_fuzzy_match_candidates_non_empty(self):
        result = self.registry.match("Salaah")
        # Should have candidates when confidence < 1.0
        assert len(result.candidates) > 0

    def test_fuzzy_match_haaland_typo(self):
        result = self.registry.match("Haaland")
        assert result.confidence >= 0.8

    def test_fuzzy_match_candidates_at_most_3(self):
        result = self.registry.match("Salaah")
        assert len(result.candidates) <= 3

    def test_fuzzy_match_candidates_sorted_by_confidence_desc(self):
        result = self.registry.match("Salaah")
        if len(result.candidates) > 1:
            confidences = [c.confidence for c in result.candidates]
            assert confidences == sorted(confidences, reverse=True)


class TestNoMatch:
    """No match (ratio < 0.5) returns confidence 0.0 and player_id None."""

    def setup_method(self):
        self.registry = PlayerRegistry(players=SAMPLE_PLAYERS)

    def test_garbage_input_zero_confidence(self):
        result = self.registry.match("XXXXXX")
        assert result.confidence == 0.0

    def test_garbage_input_no_player_id(self):
        result = self.registry.match("XXXXXX")
        assert result.player_id is None

    def test_garbage_input_empty_candidates(self):
        result = self.registry.match("XXXXXX")
        assert result.candidates == []

    def test_completely_unrelated_string(self):
        result = self.registry.match("zzzzzzzzzzzzzz")
        assert result.player_id is None
        assert result.confidence == 0.0

    def test_empty_string_no_match(self):
        result = self.registry.match("")
        assert result.confidence == 0.0
        assert result.player_id is None
