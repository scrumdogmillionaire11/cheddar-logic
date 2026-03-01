#!/usr/bin/env python3
"""
Resolvable States Framework
Replaces prompts with explicit tri-state resolution: KNOWN_API | KNOWN_MANUAL | UNKNOWN

This module enables non-interactive automation without forcing bad guesses.
When data is UNKNOWN, the system restricts risky actions rather than asking.
"""

from enum import Enum
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any
from datetime import datetime


class ResolutionState(str, Enum):
    """How was this data resolved?"""
    KNOWN_API = "KNOWN_API"           # From FPL API (trusted source)
    KNOWN_MANUAL = "KNOWN_MANUAL"     # From user manual override
    UNKNOWN = "UNKNOWN"               # Data missing or stale


class ConfidenceLevel(str, Enum):
    """Confidence in data quality/freshness"""
    HIGH = "HIGH"     # Fresh, complete, consistent
    MED = "MED"       # Partial, slightly stale, or derived
    LOW = "LOW"       # Missing, very stale, or conflicted


@dataclass
class ChipStateResolution:
    """Tri-state resolution for chip status"""
    
    # The actual state
    wildcard_available: bool = False
    wildcard_played_gw: Optional[int] = None
    
    free_hit_available: bool = False
    free_hit_played_gw: Optional[int] = None
    
    bench_boost_available: bool = False
    bench_boost_played_gw: Optional[int] = None
    
    triple_captain_available: bool = False
    triple_captain_played_gw: Optional[int] = None
    
    # How was it resolved?
    resolution_state: ResolutionState = ResolutionState.UNKNOWN
    confidence: ConfidenceLevel = ConfidenceLevel.LOW
    
    # Metadata
    last_verified_gw: Optional[int] = None
    last_verified_timestamp: Optional[datetime] = None
    data_source: str = "unknown"
    notes: str = ""
    
    def available_chips(self) -> List[str]:
        """List of available chip names"""
        chips = []
        if self.wildcard_available:
            chips.append("Wildcard")
        if self.free_hit_available:
            chips.append("Free Hit")
        if self.bench_boost_available:
            chips.append("Bench Boost")
        if self.triple_captain_available:
            chips.append("Triple Captain")
        return chips
    
    def is_safe_to_use_chips(self) -> bool:
        """
        Can we safely use chip-based logic?
        False if UNKNOWN or LOW confidence
        """
        if self.resolution_state == ResolutionState.UNKNOWN:
            return False
        if self.confidence == ConfidenceLevel.LOW:
            return False
        return True
    
    def restriction_reasons(self) -> List[str]:
        """Why might chip logic be restricted?"""
        reasons = []
        
        if self.resolution_state == ResolutionState.UNKNOWN:
            reasons.append("chip_status_unknown")
        
        if self.confidence == ConfidenceLevel.LOW:
            reasons.append("chip_confidence_low")
        
        if self.last_verified_gw is not None and self.last_verified_gw < 10:
            # Very stale verification
            reasons.append("chip_data_very_stale")
        
        return reasons


@dataclass
class FreeTransferStateResolution:
    """Tri-state resolution for free transfer count"""
    
    # The actual state
    count: int = 0  # 0-4, how many FTs available
    
    # How was it resolved?
    resolution_state: ResolutionState = ResolutionState.UNKNOWN
    confidence: ConfidenceLevel = ConfidenceLevel.LOW
    
    # Metadata
    last_verified_gw: Optional[int] = None
    last_verified_timestamp: Optional[datetime] = None
    data_source: str = "unknown"
    notes: str = ""
    
    def is_safe_to_plan_transfers(self) -> bool:
        """
        Can we safely plan transfers based on FT count?
        False if UNKNOWN or LOW confidence
        """
        if self.resolution_state == ResolutionState.UNKNOWN:
            return False
        if self.confidence == ConfidenceLevel.LOW:
            return False
        return True
    
    def restriction_reasons(self) -> List[str]:
        """Why might transfer planning be restricted?"""
        reasons = []
        
        if self.resolution_state == ResolutionState.UNKNOWN:
            reasons.append("free_transfer_count_unknown")
        
        if self.confidence == ConfidenceLevel.LOW:
            reasons.append("free_transfer_confidence_low")
        
        return reasons
    
    def max_safe_transfers_when_unknown(self) -> int:
        """
        When FT count is UNKNOWN, what's the safest planning assumption?
        Returns 0-1 (very conservative)
        """
        if self.resolution_state == ResolutionState.KNOWN_API:
            return self.count
        elif self.resolution_state == ResolutionState.KNOWN_MANUAL:
            return self.count
        else:
            # UNKNOWN: plan for at most 1 transfer
            return 1


@dataclass
class TeamStateResolution:
    """Tri-state resolution for team composition state"""
    
    # The actual state
    players: List[Dict] = field(default_factory=list)
    bench: List[Dict] = field(default_factory=list)
    captain_id: Optional[int] = None
    vice_captain_id: Optional[int] = None
    
    # How was it resolved?
    resolution_state: ResolutionState = ResolutionState.UNKNOWN
    confidence: ConfidenceLevel = ConfidenceLevel.LOW
    
    # Metadata
    last_verified_gw: Optional[int] = None
    last_verified_timestamp: Optional[datetime] = None
    data_source: str = "unknown"
    notes: str = ""
    
    def is_safe_to_suggest_lineup(self) -> bool:
        """
        Can we safely suggest captain/lineup changes?
        False if UNKNOWN or LOW confidence
        """
        if self.resolution_state == ResolutionState.UNKNOWN:
            return False
        if self.confidence == ConfidenceLevel.LOW:
            return False
        return True
    
    def restriction_reasons(self) -> List[str]:
        """Why might lineup suggestions be restricted?"""
        reasons = []
        
        if self.resolution_state == ResolutionState.UNKNOWN:
            reasons.append("team_state_unknown")
        
        if self.confidence == ConfidenceLevel.LOW:
            reasons.append("team_state_confidence_low")
        
        return reasons


@dataclass
class FullRunStateResolution:
    """
    Complete state resolution for a run.
    Each component is independently tri-stated.
    """
    
    chip_state: ChipStateResolution = field(default_factory=ChipStateResolution)
    free_transfer_state: FreeTransferStateResolution = field(default_factory=FreeTransferStateResolution)
    team_state: TeamStateResolution = field(default_factory=TeamStateResolution)
    
    # Can add more as needed:
    # - projection_state
    # - fixture_state
    # - injury_state
    
    def all_restriction_reasons(self) -> List[str]:
        """Aggregate all restriction reasons"""
        reasons = []
        reasons.extend(self.chip_state.restriction_reasons())
        reasons.extend(self.free_transfer_state.restriction_reasons())
        reasons.extend(self.team_state.restriction_reasons())
        
        # Deduplicate
        return list(set(reasons))
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to JSON-serializable dict"""
        return {
            "chip_state": {
                "available_chips": self.chip_state.available_chips(),
                "resolution_state": self.chip_state.resolution_state.value,
                "confidence": self.chip_state.confidence.value,
                "is_safe": self.chip_state.is_safe_to_use_chips(),
            },
            "free_transfer_state": {
                "count": self.free_transfer_state.count,
                "resolution_state": self.free_transfer_state.resolution_state.value,
                "confidence": self.free_transfer_state.confidence.value,
                "is_safe": self.free_transfer_state.is_safe_to_plan_transfers(),
            },
            "team_state": {
                "resolution_state": self.team_state.resolution_state.value,
                "confidence": self.team_state.confidence.value,
                "is_safe": self.team_state.is_safe_to_suggest_lineup(),
            },
            "restrictions": self.all_restriction_reasons(),
        }


# Helper functions for creating states from various sources

def chip_state_from_api(chip_data: Dict, confidence: ConfidenceLevel = ConfidenceLevel.HIGH) -> ChipStateResolution:
    """Create chip state from FPL API response"""
    state = ChipStateResolution(
        resolution_state=ResolutionState.KNOWN_API,
        confidence=confidence,
        data_source="fpl_api",
    )
    
    # Parse chip data from API format
    for chip_name, chip_info in chip_data.items():
        if chip_name.lower() == "wildcard":
            state.wildcard_available = chip_info.get("available", False)
            state.wildcard_played_gw = chip_info.get("played_gw")
        elif chip_name.lower() == "free hit":
            state.free_hit_available = chip_info.get("available", False)
            state.free_hit_played_gw = chip_info.get("played_gw")
        elif chip_name.lower() == "bench boost":
            state.bench_boost_available = chip_info.get("available", False)
            state.bench_boost_played_gw = chip_info.get("played_gw")
        elif chip_name.lower() == "triple captain":
            state.triple_captain_available = chip_info.get("available", False)
            state.triple_captain_played_gw = chip_info.get("played_gw")
    
    return state


def chip_state_from_manual(chip_data: Dict, confidence: ConfidenceLevel = ConfidenceLevel.MED) -> ChipStateResolution:
    """Create chip state from manual user input"""
    state = ChipStateResolution(
        resolution_state=ResolutionState.KNOWN_MANUAL,
        confidence=confidence,
        data_source="manual_override",
    )
    
    # Parse chip data (same format as API)
    return chip_state_from_api(chip_data, confidence)


def chip_state_unknown() -> ChipStateResolution:
    """Explicitly mark chips as unknown - safe default"""
    return ChipStateResolution(
        resolution_state=ResolutionState.UNKNOWN,
        confidence=ConfidenceLevel.LOW,
        data_source="unknown",
        notes="No chip data available. System will restrict chip-based actions.",
    )
