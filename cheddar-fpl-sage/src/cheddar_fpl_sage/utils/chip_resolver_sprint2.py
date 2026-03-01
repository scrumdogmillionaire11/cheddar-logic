#!/usr/bin/env python3
"""
Non-Interactive Chip Status Resolver (Sprint 2)
Replaces prompts with tri-state logic: KNOWN_API | KNOWN_MANUAL | UNKNOWN

No input() calls. Instead:
- Load from API first (KNOWN_API, HIGH confidence)
- Fall back to config file (KNOWN_MANUAL, MED confidence)
- Default to UNKNOWN with safe behavior restrictions

Sprint 3.5: Updated to use centralized config manager with proper cache invalidation
"""

from typing import Dict, Optional
from datetime import datetime

from .resolvable_states import (
    ChipStateResolution,
    ResolutionState,
    ConfidenceLevel,
    chip_state_from_api,
    chip_state_from_manual,
    chip_state_unknown,
)
from .sprint3_5_config_manager import Sprint35ConfigManager


class NonInteractiveChipResolver:
    """
    Resolve chip status without prompts.
    
    Priority:
    1. FPL API response (KNOWN_API, HIGH confidence)
    2. Config file override (KNOWN_MANUAL, MED confidence)
    3. Default to UNKNOWN (safe mode)
    
    Sprint 3.5: Uses centralized config manager with cache invalidation
    """
    
    def __init__(self, config_file: str = "team_config.json"):
        self.config_file = config_file
        self.config_manager = Sprint35ConfigManager(config_file)
    
    def load_manual_override(self) -> Optional[Dict]:
        """Load chip status from config file (fresh read via config manager)"""
        config = self.config_manager.get_config(force_reload=True)
        return config.get('manual_chip_status')
    
    def resolve_chip_state(
        self,
        api_chip_data: Optional[Dict] = None,
        current_gw: Optional[int] = None
    ) -> ChipStateResolution:
        """
        Resolve chip state without asking the user.
        
        Args:
            api_chip_data: Chip data from FPL API (if available)
            current_gw: Current gameweek for metadata
        
        Returns:
            ChipStateResolution with explicit tri-state
        
        Logic:
        - If API data available and fresh → KNOWN_API
        - Else if manual override exists → KNOWN_MANUAL
        - Else → UNKNOWN (safe default)
        """
        
        # Try API first
        if api_chip_data:
            state = chip_state_from_api(api_chip_data, confidence=ConfidenceLevel.HIGH)
            state.last_verified_gw = current_gw
            state.last_verified_timestamp = datetime.now()
            return state
        
        # Try manual override
        manual_override = self.load_manual_override()
        if manual_override:
            state = chip_state_from_manual(manual_override, confidence=ConfidenceLevel.MED)
            state.last_verified_gw = current_gw
            state.last_verified_timestamp = datetime.now()
            return state
        
        # Default: UNKNOWN (safe)
        return chip_state_unknown()
    
    def save_manual_override(self, chip_state: ChipStateResolution):
        """
        Save current chip state as manual override for future runs.
        Called when user explicitly sets chips (e.g., via config file).
        
        Sprint 3.5: Uses centralized config manager with atomic writes
        """
        # Convert state back to dict format
        chip_dict = {
            "Wildcard": {
                "available": chip_state.wildcard_available,
                "played_gw": chip_state.wildcard_played_gw,
            },
            "Free Hit": {
                "available": chip_state.free_hit_available,
                "played_gw": chip_state.free_hit_played_gw,
            },
            "Bench Boost": {
                "available": chip_state.bench_boost_available,
                "played_gw": chip_state.bench_boost_played_gw,
            },
            "Triple Captain": {
                "available": chip_state.triple_captain_available,
                "played_gw": chip_state.triple_captain_played_gw,
            },
        }
        
        self.config_manager.update_manual_chips(chip_dict)


class ChipRestrictionEnforcer:
    """
    Enforce restrictions based on chip state resolution.
    
    When chip_state is UNKNOWN or LOW confidence:
    - Disable chip-based decisions (Bench Boost, Free Hit, Wildcard logic)
    - Restrict Triple Captain to only if margin > threshold
    - Log all restrictions explicitly
    """
    
    @staticmethod
    def get_blocked_actions(chip_state: ChipStateResolution) -> Dict[str, str]:
        """
        What actions should be blocked given this chip state?
        
        Returns:
            Dict mapping action → reason
        """
        blocked = {}
        
        if not chip_state.is_safe_to_use_chips():
            reasons = chip_state.restriction_reasons()
            
            for reason in reasons:
                if "unknown" in reason.lower() or "low" in reason.lower():
                    blocked["bench_boost_suggestion"] = reason
                    blocked["free_hit_suggestion"] = reason
                    blocked["wildcard_suggestion"] = reason
                    blocked["aggressive_triple_captain"] = reason
        
        return blocked
    
    @staticmethod
    def suggest_action_when_unknown(chip_state: ChipStateResolution) -> str:
        """
        Suggest an action for the user when chip state is uncertain.
        
        Returns:
            Human-readable suggestion
        """
        if chip_state.is_safe_to_use_chips():
            return ""
        
        if chip_state.resolution_state == ResolutionState.UNKNOWN:
            return (
                "⚠️ Chip status unknown. To enable chip-based suggestions, "
                "either:\n"
                "  1. Update team_config.json manually with your chips\n"
                "  2. Wait for API data to sync\n"
                "Until then, chip logic is disabled for safety."
            )
        
        if chip_state.confidence == ConfidenceLevel.LOW:
            return (
                "⚠️ Chip data confidence is LOW. "
                "Chip-based suggestions are restricted. "
                "Verify your chip status in team_config.json."
            )
        
        return ""
