"""Player registry service with fuzzy name matching.

Provides an in-memory registry of FPL players keyed by player_id -> display_name.
Uses difflib.SequenceMatcher for fuzzy matching; no external API calls in MVP.
"""
import difflib
from dataclasses import dataclass, field
from typing import Optional


# Confidence thresholds
CONFIDENCE_THRESHOLD_HIGH = 0.95   # Treat as resolved (exact or near-exact)
CONFIDENCE_THRESHOLD_LOW = 0.5     # Below this → unresolved slot


@dataclass
class CandidateMatch:
    """A candidate player name match with associated confidence score."""
    player_id: int
    display_name: str
    confidence: float


@dataclass
class MatchResult:
    """Result of a registry name-match operation."""
    player_id: Optional[int]
    display_name: Optional[str]
    confidence: float
    candidates: list[CandidateMatch] = field(default_factory=list)


# Hardcoded sample covering common FPL assets.
# Sized to support both unit tests and the synthetic MVP scaffold in screenshot_parser.
# Production bootstrap loader can replace this singleton at startup.
_SAMPLE_PLAYERS: dict[int, str] = {
    1: "Mohamed Salah",
    2: "Erling Haaland",
    3: "Bukayo Saka",
    4: "Trent Alexander-Arnold",
    5: "Alisson",
    6: "Virgil van Dijk",
    7: "Kevin De Bruyne",
    8: "Bruno Fernandes",
    9: "Marcus Rashford",
    10: "Harry Kane",
    11: "Phil Foden",
    12: "Martin Odegaard",
    13: "Gabriel Magalhaes",
    14: "Pedro Porro",
    15: "Ollie Watkins",
    16: "Mark Flekken",
    17: "Matt Doherty",
    18: "Jacob Murphy",
    19: "Dominic Solanke",
}


class PlayerRegistry:
    """In-memory FPL player registry with fuzzy name matching.

    Parameters
    ----------
    players:
        Mapping of {player_id: display_name}.  Inject whatever dict you need
        for tests; the module-level singleton uses the hardcoded sample above.
    """

    def __init__(self, players: dict[int, str]) -> None:
        self._players: dict[int, str] = dict(players)
        # Pre-build lowercase index for case-insensitive lookup
        self._lower_index: dict[str, int] = {
            name.lower(): pid for pid, name in self._players.items()
        }

    def match(self, raw_name: str) -> MatchResult:
        """Match a raw OCR name string against the registry.

        Returns
        -------
        MatchResult
            - Exact match (case-insensitive): confidence=1.0, empty candidates
            - Fuzzy match (ratio >= 0.8): confidence=ratio, candidates=[top-3]
            - No match (ratio < 0.5): confidence=0.0, player_id=None, candidates=[]
        """
        if not raw_name or not self._players:
            return MatchResult(player_id=None, display_name=None, confidence=0.0)

        lower_raw = raw_name.lower().strip()

        # --- Exact match (case-insensitive) ---
        if lower_raw in self._lower_index:
            pid = self._lower_index[lower_raw]
            return MatchResult(
                player_id=pid,
                display_name=self._players[pid],
                confidence=1.0,
                candidates=[],
            )

        # --- Fuzzy match via SequenceMatcher ---
        # Match against full display name AND individual name tokens (last name, etc.)
        # so "Salaah" finds "Mohamed Salah" even without the first name.
        scored: list[tuple[float, int, str]] = []
        for pid, display_name in self._players.items():
            lower_name = display_name.lower()
            tokens = lower_name.split()

            # Score against full name and each individual token
            ratios = [difflib.SequenceMatcher(None, lower_raw, lower_name).ratio()]
            for token in tokens:
                ratios.append(difflib.SequenceMatcher(None, lower_raw, token).ratio())

            ratio = max(ratios)
            scored.append((ratio, pid, display_name))

        # Sort by confidence descending
        scored.sort(key=lambda x: x[0], reverse=True)
        best_ratio, best_pid, best_name = scored[0]

        if best_ratio < CONFIDENCE_THRESHOLD_LOW:
            return MatchResult(player_id=None, display_name=None, confidence=0.0)

        # Build top-3 candidates list (excluding the resolved match itself)
        candidates = [
            CandidateMatch(player_id=pid, display_name=name, confidence=ratio)
            for ratio, pid, name in scored[:3]
        ]

        if best_ratio >= CONFIDENCE_THRESHOLD_HIGH:
            # High-confidence resolution — treat as resolved, still expose candidates
            # when not exact (for transparency), but per spec exact match handled above.
            return MatchResult(
                player_id=best_pid,
                display_name=best_name,
                confidence=best_ratio,
                candidates=[c for c in candidates if c.player_id != best_pid],
            )

        # Mid-confidence fuzzy match
        return MatchResult(
            player_id=best_pid,
            display_name=best_name,
            confidence=best_ratio,
            candidates=candidates,
        )


# Module-level singleton — production bootstrap loader can replace _SAMPLE_PLAYERS
player_registry = PlayerRegistry(players=_SAMPLE_PLAYERS)
