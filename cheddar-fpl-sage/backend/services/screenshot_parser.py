"""Screenshot parser service for FPL mobile screenshots.

Classifies layout (pitch_view / list_view / unknown) and extracts 15-player
slot data via a synthetic MVP scaffold.

OCR wiring is a future WI — this module provides the pipeline contract and
deterministic synthetic extraction so downstream features can be integrated
and tested without real computer-vision infrastructure.
"""
import io
import struct
from typing import Literal

from PIL import Image

from backend.models.screenshot_api_models import (
    CandidateMatch,
    ParsedSlot,
    ParsedSquad,
)
from backend.services.player_registry import (
    CONFIDENCE_THRESHOLD_LOW,
    player_registry,
)


# ---------------------------------------------------------------------------
# Position scaffold for a standard FPL 15-man squad
# Slots 0-10 = starters (1 GKP, 4 DEF, 4 MID, 2 FWD)
# Slots 11-14 = bench
# ---------------------------------------------------------------------------
_SLOT_SCAFFOLD: list[tuple[int, str]] = [
    (0, "GKP"),
    (1, "DEF"),
    (2, "DEF"),
    (3, "DEF"),
    (4, "DEF"),
    (5, "MID"),
    (6, "MID"),
    (7, "MID"),
    (8, "MID"),
    (9, "FWD"),
    (10, "FWD"),
    # Bench
    (11, "BENCH"),
    (12, "BENCH"),
    (13, "BENCH"),
    (14, "BENCH"),
]

# Synthetic player names for MVP scaffold — deterministic per slot index.
# Production OCR will replace these with real extracted names.
_SYNTHETIC_NAMES: list[str] = [
    "Alisson",
    "Trent Alexander-Arnold",
    "Virgil van Dijk",
    "Gabriel Magalhaes",
    "Pedro Porro",
    "Mohamed Salah",
    "Phil Foden",
    "Martin Odegaard",
    "Bukayo Saka",
    "Erling Haaland",
    "Ollie Watkins",
    # Bench
    "Mark Flekken",
    "Matt Doherty",
    "Jacob Murphy",
    "Dominic Solanke",
]


class ScreenshotParser:
    """Parses FPL mobile screenshot bytes into a structured squad.

    Methods
    -------
    detect_layout(image_bytes) -> "pitch_view" | "list_view" | "unknown"
    extract_slots(image_bytes, layout) -> list[dict]
    parse(images) -> (ParsedSquad, layout_str, warnings)
    """

    # -----------------------------------------------------------------------
    # Layout detection
    # -----------------------------------------------------------------------

    def detect_layout(self, image_bytes: bytes) -> Literal["pitch_view", "list_view", "unknown"]:
        """Classify the layout of an FPL screenshot from image dimensions.

        Heuristics (MVP — no ML):
        - pitch_view : portrait aspect ratio where height > width * 1.2
        - list_view  : roughly square or landscape where width >= height * 0.9
        - unknown    : neither heuristic fires
        """
        try:
            img = Image.open(io.BytesIO(image_bytes))
            width, height = img.size
        except Exception:
            return "unknown"

        if height > width * 1.2:
            return "pitch_view"
        if width >= height * 0.9:
            return "list_view"
        return "unknown"

    # -----------------------------------------------------------------------
    # Slot extraction (synthetic MVP scaffold)
    # -----------------------------------------------------------------------

    def extract_slots(
        self, image_bytes: bytes, layout: str
    ) -> list[dict]:
        """Extract player slot data from screenshot bytes.

        OCR wiring is a future WI — this is the synthetic MVP scaffold.
        Returns a deterministic 15-slot list based on _SLOT_SCAFFOLD.
        Returns [] with a warning for unknown layout.

        Each returned dict has keys:
          raw_name, position, slot_index, is_captain, is_vice_captain
        """
        if layout == "unknown":
            return []

        slots = []
        for slot_index, position in _SLOT_SCAFFOLD:
            raw_name = _SYNTHETIC_NAMES[slot_index]
            slots.append(
                {
                    "raw_name": raw_name,
                    "position": position,
                    "slot_index": slot_index,
                    "is_captain": slot_index == 5,       # Salah as captain
                    "is_vice_captain": slot_index == 9,  # Haaland as vc
                }
            )
        return slots

    # -----------------------------------------------------------------------
    # Full parse pipeline
    # -----------------------------------------------------------------------

    def parse(
        self, images: list[bytes]
    ) -> tuple[ParsedSquad, str, list[str]]:
        """Parse one or more screenshot images into a ParsedSquad.

        Parameters
        ----------
        images : list[bytes]
            Raw image bytes (decoded from base64 by the router).

        Returns
        -------
        tuple[ParsedSquad, str, list[str]]
            (squad, detected_layout, warnings)

        Raises
        ------
        ValueError
            If the images list is empty.
        """
        if not images:
            raise ValueError("at least one image required")

        warnings: list[str] = []
        merged_slots: dict[int, dict] = {}  # keyed by slot_index for dedup
        detected_layout: str = "unknown"

        for img_bytes in images:
            layout = self.detect_layout(img_bytes)
            if layout != "unknown":
                detected_layout = layout

            raw_slots = self.extract_slots(img_bytes, layout)

            if layout == "unknown":
                warnings.append(
                    "Could not determine layout for one image; slots skipped."
                )

            for slot in raw_slots:
                # First image wins on slot_index dedup
                if slot["slot_index"] not in merged_slots:
                    merged_slots[slot["slot_index"]] = slot

        # Resolve player names via registry
        starters: list[ParsedSlot] = []
        bench: list[ParsedSlot] = []
        unresolved: list[ParsedSlot] = []
        captain: ParsedSlot | None = None
        vice_captain: ParsedSlot | None = None

        for slot_index in sorted(merged_slots.keys()):
            raw = merged_slots[slot_index]
            match_result = player_registry.match(raw["raw_name"])

            # Build candidate list (convert dataclasses to Pydantic models)
            pydantic_candidates = [
                CandidateMatch(
                    player_id=c.player_id,
                    display_name=c.display_name,
                    confidence=c.confidence,
                )
                for c in match_result.candidates
            ]

            parsed = ParsedSlot(
                slot_index=raw["slot_index"],
                position=raw["position"],
                player_id=match_result.player_id,
                display_name=match_result.display_name,
                confidence=match_result.confidence,
                candidates=pydantic_candidates,
                is_captain=raw["is_captain"],
                is_vice_captain=raw["is_vice_captain"],
            )

            if match_result.confidence < CONFIDENCE_THRESHOLD_LOW:
                unresolved.append(parsed)
            elif raw["position"] == "BENCH":
                bench.append(parsed)
            else:
                starters.append(parsed)

            if raw["is_captain"] and match_result.confidence >= CONFIDENCE_THRESHOLD_LOW:
                captain = parsed
            if raw["is_vice_captain"] and match_result.confidence >= CONFIDENCE_THRESHOLD_LOW:
                vice_captain = parsed

        squad = ParsedSquad(
            starters=starters,
            bench=bench,
            captain=captain,
            vice_captain=vice_captain,
            unresolved_slots=unresolved,
        )

        return squad, detected_layout, warnings


# Module-level singleton
screenshot_parser = ScreenshotParser()
