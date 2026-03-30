"""Pydantic models for screenshot parse API request/response."""
from typing import Literal, Optional
from pydantic import BaseModel, Field


class CandidateMatch(BaseModel):
    """A candidate player match with confidence score."""
    player_id: int
    display_name: str
    confidence: float


class ParsedSlot(BaseModel):
    """A single parsed player slot from a screenshot."""
    slot_index: int
    position: Literal["GKP", "DEF", "MID", "FWD", "BENCH"]
    player_id: Optional[int] = None
    display_name: Optional[str] = None
    confidence: float
    candidates: list[CandidateMatch] = Field(default_factory=list)
    is_captain: bool = False
    is_vice_captain: bool = False


class ParsedSquad(BaseModel):
    """A fully parsed 15-man squad."""
    starters: list[ParsedSlot]
    bench: list[ParsedSlot]
    captain: Optional[ParsedSlot] = None
    vice_captain: Optional[ParsedSlot] = None
    unresolved_slots: list[ParsedSlot] = Field(default_factory=list)


class ScreenshotParseRequest(BaseModel):
    """Request to parse 1-3 FPL mobile screenshots."""
    images: list[str] = Field(
        ...,
        min_length=1,
        max_length=3,
        description="Base64-encoded PNG/JPEG screenshots",
    )


class ScreenshotParseResponse(BaseModel):
    """Response from the screenshot parse endpoint."""
    squad: ParsedSquad
    layout_detected: Literal["pitch_view", "list_view", "unknown"]
    images_processed: int
    parse_warnings: list[str] = Field(default_factory=list)
