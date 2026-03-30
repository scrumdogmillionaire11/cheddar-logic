"""Tests for ScreenshotParser service and POST /api/v1/screenshot-parse endpoint."""
import base64
import io
import pytest

from PIL import Image

from backend.services.screenshot_parser import ScreenshotParser
from backend.models.screenshot_api_models import ParsedSquad


def make_png_bytes(width: int, height: int) -> bytes:
    """Create a minimal valid PNG image of given dimensions."""
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=(255, 255, 255)).save(buf, format="PNG")
    return buf.getvalue()


def make_portrait_png() -> bytes:
    """Portrait image (height > width * 1.2) — should detect as pitch_view."""
    return make_png_bytes(100, 180)


def make_landscape_png() -> bytes:
    """Landscape/square image (width >= height * 0.9) — should detect as list_view."""
    return make_png_bytes(200, 150)


def make_base64_portrait() -> str:
    return base64.b64encode(make_portrait_png()).decode()


def make_base64_landscape() -> str:
    return base64.b64encode(make_landscape_png()).decode()


# ---------------------------------------------------------------------------
# ScreenshotParser unit tests
# ---------------------------------------------------------------------------

class TestDetectLayout:
    """Layout detection from image bytes."""

    def setup_method(self):
        self.parser = ScreenshotParser()

    def test_portrait_detected_as_pitch_view(self):
        result = self.parser.detect_layout(make_portrait_png())
        assert result == "pitch_view"

    def test_landscape_detected_as_list_view(self):
        result = self.parser.detect_layout(make_landscape_png())
        assert result == "list_view"

    def test_square_image_detected_as_list_view(self):
        """Square (1:1) images fall under list_view heuristic."""
        result = self.parser.detect_layout(make_png_bytes(100, 100))
        assert result == "list_view"

    def test_ambiguous_aspect_returns_unknown_or_valid(self):
        """Slightly portrait but not past threshold — heuristic behaviour is deterministic."""
        result = self.parser.detect_layout(make_png_bytes(100, 115))
        assert result in ("pitch_view", "list_view", "unknown")


class TestExtractSlots:
    """Slot extraction returns expected structure."""

    def setup_method(self):
        self.parser = ScreenshotParser()

    def test_extract_returns_list(self):
        slots = self.parser.extract_slots(make_portrait_png(), "pitch_view")
        assert isinstance(slots, list)

    def test_extract_pitch_view_returns_15_slots(self):
        slots = self.parser.extract_slots(make_portrait_png(), "pitch_view")
        assert len(slots) == 15

    def test_slot_has_required_keys(self):
        slots = self.parser.extract_slots(make_portrait_png(), "pitch_view")
        required = {"raw_name", "position", "slot_index", "is_captain", "is_vice_captain"}
        for slot in slots:
            assert required.issubset(slot.keys()), f"Missing keys in slot: {slot}"

    def test_slot_positions_valid(self):
        valid_positions = {"GKP", "DEF", "MID", "FWD", "BENCH"}
        slots = self.parser.extract_slots(make_portrait_png(), "pitch_view")
        for slot in slots:
            assert slot["position"] in valid_positions, f"Invalid position: {slot['position']}"

    def test_slot_index_unique(self):
        slots = self.parser.extract_slots(make_portrait_png(), "pitch_view")
        indices = [s["slot_index"] for s in slots]
        assert len(indices) == len(set(indices))

    def test_unknown_layout_returns_empty(self):
        slots = self.parser.extract_slots(make_portrait_png(), "unknown")
        assert slots == []

    def test_exactly_one_captain(self):
        slots = self.parser.extract_slots(make_portrait_png(), "pitch_view")
        captains = [s for s in slots if s["is_captain"]]
        assert len(captains) == 1

    def test_exactly_one_vice_captain(self):
        slots = self.parser.extract_slots(make_portrait_png(), "pitch_view")
        vice_captains = [s for s in slots if s["is_vice_captain"]]
        assert len(vice_captains) == 1


class TestParseMethod:
    """Full parse pipeline: images -> ParsedSquad."""

    def setup_method(self):
        self.parser = ScreenshotParser()

    def test_parse_empty_list_raises_value_error(self):
        with pytest.raises(ValueError, match="at least one image required"):
            self.parser.parse([])

    def test_parse_single_portrait_returns_tuple(self):
        result = self.parser.parse([make_portrait_png()])
        assert isinstance(result, tuple)
        assert len(result) == 3

    def test_parse_returns_squad_str_list(self):
        squad, layout, warnings = self.parser.parse([make_portrait_png()])
        assert isinstance(squad, ParsedSquad)
        assert isinstance(layout, str)
        assert isinstance(warnings, list)

    def test_parse_portrait_layout_is_pitch_view(self):
        _, layout, _ = self.parser.parse([make_portrait_png()])
        assert layout == "pitch_view"

    def test_parse_starters_count_11(self):
        squad, _, _ = self.parser.parse([make_portrait_png()])
        assert len(squad.starters) == 11

    def test_parse_bench_count_4(self):
        squad, _, _ = self.parser.parse([make_portrait_png()])
        assert len(squad.bench) == 4

    def test_parse_captain_set(self):
        squad, _, _ = self.parser.parse([make_portrait_png()])
        assert squad.captain is not None

    def test_parse_vice_captain_set(self):
        squad, _, _ = self.parser.parse([make_portrait_png()])
        assert squad.vice_captain is not None

    def test_low_confidence_slots_in_unresolved_not_starters(self):
        """Slots with confidence < 0.5 must appear in unresolved_slots, not starters or bench."""
        squad, _, _ = self.parser.parse([make_portrait_png()])
        all_starters_and_bench = squad.starters + squad.bench
        for slot in all_starters_and_bench:
            assert slot.confidence >= 0.5, (
                f"Low-confidence slot (confidence={slot.confidence}) "
                f"found in starters/bench — should be in unresolved_slots"
            )

    def test_unresolved_slots_all_low_confidence(self):
        """Anything in unresolved_slots must have confidence < 0.5."""
        squad, _, _ = self.parser.parse([make_portrait_png()])
        for slot in squad.unresolved_slots:
            assert slot.confidence < 0.5, (
                f"High-confidence slot (confidence={slot.confidence}) "
                f"found in unresolved_slots — should be resolved"
            )

    def test_multi_image_deduplicates_by_slot_index(self):
        """Parsing two identical images should not double-count slots."""
        img = make_portrait_png()
        squad, _, _ = self.parser.parse([img, img])
        total_slots = (
            len(squad.starters) + len(squad.bench) + len(squad.unresolved_slots)
        )
        assert total_slots <= 15


# ---------------------------------------------------------------------------
# Endpoint integration tests
# ---------------------------------------------------------------------------

class TestScreenshotParseEndpoint:
    """Integration tests via the FastAPI TestClient."""

    def test_post_returns_200_for_valid_base64(self, client):
        payload = {"images": [make_base64_portrait()]}
        response = client.post("/api/v1/screenshot-parse", json=payload)
        assert response.status_code == 200

    def test_response_has_squad_key(self, client):
        payload = {"images": [make_base64_portrait()]}
        response = client.post("/api/v1/screenshot-parse", json=payload)
        data = response.json()
        assert "squad" in data

    def test_response_squad_has_starters_bench_unresolved(self, client):
        payload = {"images": [make_base64_portrait()]}
        response = client.post("/api/v1/screenshot-parse", json=payload)
        squad = response.json()["squad"]
        assert "starters" in squad
        assert "bench" in squad
        assert "unresolved_slots" in squad

    def test_response_has_layout_detected(self, client):
        payload = {"images": [make_base64_portrait()]}
        response = client.post("/api/v1/screenshot-parse", json=payload)
        assert "layout_detected" in response.json()

    def test_response_has_parse_warnings(self, client):
        payload = {"images": [make_base64_portrait()]}
        response = client.post("/api/v1/screenshot-parse", json=payload)
        assert "parse_warnings" in response.json()

    def test_post_empty_images_returns_422(self, client):
        payload = {"images": []}
        response = client.post("/api/v1/screenshot-parse", json=payload)
        assert response.status_code == 422

    def test_post_more_than_3_images_returns_422(self, client):
        img = make_base64_portrait()
        payload = {"images": [img, img, img, img]}
        response = client.post("/api/v1/screenshot-parse", json=payload)
        assert response.status_code == 422

    def test_post_missing_images_field_returns_422(self, client):
        payload = {}
        response = client.post("/api/v1/screenshot-parse", json=payload)
        assert response.status_code == 422

    def test_images_processed_count_correct(self, client):
        img = make_base64_portrait()
        payload = {"images": [img, img]}
        response = client.post("/api/v1/screenshot-parse", json=payload)
        assert response.json()["images_processed"] == 2
