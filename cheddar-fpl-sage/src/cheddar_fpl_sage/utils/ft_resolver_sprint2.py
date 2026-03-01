#!/usr/bin/env python3
"""
Non-Interactive Free Transfer Resolver (Sprint 2)
Replaces prompts with tri-state logic: KNOWN_API | KNOWN_MANUAL | UNKNOWN

No input() calls. Instead:
- Load from API first (KNOWN_API, HIGH confidence)
- Fall back to config file (KNOWN_MANUAL, MED confidence)
- Default to conservative estimate (1 FT, UNKNOWN)

Sprint 3.5: Updated to use centralized config manager with proper cache invalidation
"""

from typing import Optional, Dict
from datetime import datetime

from .resolvable_states import (
    FreeTransferStateResolution,
    ResolutionState,
    ConfidenceLevel,
)
from .sprint3_5_config_manager import Sprint35ConfigManager


class NonInteractiveFTResolver:
    """
    Resolve free transfer count without prompts.
    
    Priority:
    1. FPL API response (KNOWN_API, HIGH confidence)
    2. Config file override (KNOWN_MANUAL, MED confidence)
    3. Default to conservative (1 FT, UNKNOWN)
    
    Sprint 3.5: Uses centralized config manager with cache invalidation
    """
    
    def __init__(self, config_file: str = "team_config.json"):
        self.config_file = config_file
        self.config_manager = Sprint35ConfigManager(config_file)
    
    def load_manual_override(self) -> Optional[int]:
        """Load manual free transfer count from config (fresh read via config manager)"""
        config = self.config_manager.get_config(force_reload=True)
        manual_ft = config.get('manual_free_transfers')
        if manual_ft is not None and isinstance(manual_ft, int):
            return max(0, min(4, manual_ft))  # Clamp to 0-4
        return None
    
    def resolve_ft_state(
        self,
        api_ft_count: Optional[int] = None,
        current_gw: Optional[int] = None
    ) -> FreeTransferStateResolution:
        """
        Resolve free transfer state without asking the user.
        
        Args:
            api_ft_count: Free transfer count from FPL API (if available)
            current_gw: Current gameweek for metadata
        
        Returns:
            FreeTransferStateResolution with explicit tri-state
        
        Logic:
        - If API data available → KNOWN_API, HIGH confidence
        - Else if manual override exists → KNOWN_MANUAL, MED confidence
        - Else → UNKNOWN, assume 1 FT for planning (conservative)
        """
        
        # Try API first
        if api_ft_count is not None:
            state = FreeTransferStateResolution(
                count=max(0, min(4, api_ft_count)),  # Clamp to 0-4
                resolution_state=ResolutionState.KNOWN_API,
                confidence=ConfidenceLevel.HIGH,
                data_source="fpl_api",
                last_verified_gw=current_gw,
                last_verified_timestamp=datetime.now(),
            )
            return state
        
        # Try manual override
        manual_override = self.load_manual_override()
        if manual_override is not None:
            state = FreeTransferStateResolution(
                count=manual_override,
                resolution_state=ResolutionState.KNOWN_MANUAL,
                confidence=ConfidenceLevel.MED,
                data_source="manual_override",
                last_verified_gw=current_gw,
                last_verified_timestamp=datetime.now(),
            )
            return state
        
        # Default: UNKNOWN, conservative (1 FT for planning)
        state = FreeTransferStateResolution(
            count=1,
            resolution_state=ResolutionState.UNKNOWN,
            confidence=ConfidenceLevel.LOW,
            data_source="unknown",
            notes="No FT data available. Planning for 1 FT conservatively.",
            last_verified_gw=current_gw,
            last_verified_timestamp=datetime.now(),
        )
        return state
    
    def save_manual_override(self, ft_count: int):
        """
        Save manual free transfer count for future runs.
        
        Sprint 3.5: Uses centralized config manager with atomic writes
        """
        ft_count = max(0, min(4, ft_count))  # Clamp to 0-4
        self.config_manager.update_manual_free_transfers(ft_count)


class FTRestrictionEnforcer:
    """
    Enforce restrictions based on free transfer state resolution.
    
    When FT state is UNKNOWN or LOW confidence:
    - Suggest only 0-1 transfer plans
    - Disable multi-transfer scenarios
    - Disable complex chip + transfer combos
    - Log restrictions explicitly
    """
    
    @staticmethod
    def get_blocked_actions(ft_state: FreeTransferStateResolution) -> Dict[str, str]:
        """
        What actions should be blocked given this FT state?
        
        Returns:
            Dict mapping action → reason
        """
        blocked = {}
        
        if not ft_state.is_safe_to_plan_transfers():
            reasons = ft_state.restriction_reasons()
            
            for reason in reasons:
                if "unknown" in reason.lower() or "low" in reason.lower():
                    # Restrict multi-transfer scenarios
                    blocked["multi_transfer_plan"] = reason
                    blocked["aggressive_transfer_plan"] = reason
        
        return blocked
    
    @staticmethod
    def max_safe_transfers(ft_state: FreeTransferStateResolution) -> int:
        """
        Maximum number of transfers to suggest given this FT state.
        
        Returns:
            0-4 (number of transfers)
        """
        if not ft_state.is_safe_to_plan_transfers():
            # UNKNOWN or LOW: very conservative
            return ft_state.max_safe_transfers_when_unknown()
        
        # Known and high confidence: use actual count
        return ft_state.count
    
    @staticmethod
    def suggest_action_when_unknown(ft_state: FreeTransferStateResolution) -> str:
        """
        Suggest an action for the user when FT state is uncertain.
        
        Returns:
            Human-readable suggestion
        """
        if ft_state.is_safe_to_plan_transfers():
            return ""
        
        if ft_state.resolution_state == ResolutionState.UNKNOWN:
            return (
                "⚠️ Free transfer count unknown. To enable full transfer planning:\n"
                "  1. Update team_config.json with manual_free_transfers value\n"
                "  2. Or provide your team ID for API sync\n"
                "Until then, planning is limited to 1 transfer maximum."
            )
        
        if ft_state.confidence == ConfidenceLevel.LOW:
            return (
                "⚠️ Free transfer data confidence is LOW. "
                "Transfer planning is restricted to 1 transfer. "
                "Verify the count in team_config.json."
            )
        
        return ""
