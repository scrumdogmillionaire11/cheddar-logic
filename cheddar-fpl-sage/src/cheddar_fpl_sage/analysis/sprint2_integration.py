#!/usr/bin/env python3
"""
Sprint 2 Integration Adapter for FPLSageIntegration
Injects tri-state resolution into the main analysis pipeline

This adapter:
1. Resolves chip state (API → Manual → UNKNOWN)
2. Resolves FT state (API → Manual → Conservative)
3. Coordinates restrictions
4. Injects results into run_context and output
"""

import logging
from typing import Dict, Any
from datetime import datetime

from utils import (
    NonInteractiveChipResolver,
    NonInteractiveFTResolver,
    TeamStateResolution,
    FullRunStateResolution,
    RestrictionCoordinator,
    ResolutionState,
    ConfidenceLevel,
    compute_authority_level,
    format_restrictions_for_display,
)

logger = logging.getLogger(__name__)


class Sprint2IntegrationAdapter:
    """
    Integrates Sprint 2 tri-state resolution into FPLSageIntegration
    """
    
    def __init__(self, config_file: str = "team_config.json"):
        self.config_file = config_file
        self.chip_resolver = NonInteractiveChipResolver(config_file)
        self.ft_resolver = NonInteractiveFTResolver(config_file)
        self.restriction_coordinator = RestrictionCoordinator()
    
    def resolve_and_restrict(
        self,
        team_data: Dict[str, Any],
        current_gw: int,
        api_available: bool = True
    ) -> Dict[str, Any]:
        """
        Resolve all state tri-states and compute restrictions
        
        Args:
            team_data: Team data from FPLSageIntegration
            current_gw: Current gameweek
            api_available: Whether API data collection was successful
        
        Returns:
            Dict containing:
                - chip_state: ChipStateResolution
                - ft_state: FreeTransferStateResolution
                - team_state: TeamStateResolution
                - restrictions: RunRestrictionSet
                - authority_level: int (1-3)
                - run_context: Dict for output
        """
        
        logger.info("Sprint 2: Resolving state tri-states...")
        
        # Extract data from team_data
        chip_data_from_api = None
        ft_count_from_api = None
        has_team_state = False
        
        if api_available and team_data and 'error' not in team_data:
            # Try to get chip data from API response
            chip_status = team_data.get('chip_status', {})
            if chip_status:
                chip_data_from_api = chip_status
            
            # Try to get FT count from API response
            team_info = team_data.get('team_info', {})
            ft_from_api = team_info.get('free_transfers')
            if ft_from_api is not None:
                ft_count_from_api = ft_from_api
            
            # Check if we have team state
            squad = team_data.get('current_squad', [])
            if squad:
                has_team_state = True
        
        # Step 1: Resolve chip state
        chip_state = self.chip_resolver.resolve_chip_state(
            api_chip_data=chip_data_from_api,
            current_gw=current_gw
        )
        
        logger.info(
            f"Chip state resolved: {chip_state.resolution_state.value} "
            f"(confidence: {chip_state.confidence.value})"
        )
        
        # Step 2: Resolve FT state
        ft_state = self.ft_resolver.resolve_ft_state(
            api_ft_count=ft_count_from_api,
            current_gw=current_gw
        )
        
        logger.info(
            f"FT state resolved: {ft_state.resolution_state.value} "
            f"(count: {ft_state.count}, confidence: {ft_state.confidence.value})"
        )
        
        # Step 3: Create team state
        team_state = TeamStateResolution(
            resolution_state=(
                ResolutionState.KNOWN_API if has_team_state 
                else ResolutionState.UNKNOWN
            ),
            confidence=(
                ConfidenceLevel.HIGH if has_team_state 
                else ConfidenceLevel.LOW
            ),
            data_source="fpl_api" if has_team_state else "unknown",
            last_verified_gw=current_gw,
            last_verified_timestamp=datetime.now(),
        )
        
        logger.info(
            f"Team state resolved: {team_state.resolution_state.value} "
            f"(confidence: {team_state.confidence.value})"
        )
        
        # Step 4: Create full state
        full_state = FullRunStateResolution(
            chip_state=chip_state,
            free_transfer_state=ft_state,
            team_state=team_state,
        )
        
        # Step 5: Coordinate restrictions
        restrictions = self.restriction_coordinator.coordinate_restrictions(full_state)
        
        # Step 6: Compute authority level
        authority_level = compute_authority_level(restrictions)
        
        logger.info(f"Authority Level: {authority_level}/3")
        
        # Step 7: Build run context
        run_context = {
            "sprint2": {
                "chip_state": {
                    "resolution": chip_state.resolution_state.value,
                    "confidence": chip_state.confidence.value,
                    "available_chips": chip_state.available_chips(),
                    "data_source": chip_state.data_source,
                },
                "ft_state": {
                    "resolution": ft_state.resolution_state.value,
                    "confidence": ft_state.confidence.value,
                    "count": ft_state.count,
                    "safe_to_plan": ft_state.is_safe_to_plan_transfers(),
                    "data_source": ft_state.data_source,
                },
                "team_state": {
                    "resolution": team_state.resolution_state.value,
                    "confidence": team_state.confidence.value,
                    "data_source": team_state.data_source,
                },
                "restrictions": restrictions.to_dict(),
                "authority_level": authority_level,
                "timestamp": datetime.now().isoformat(),
            }
        }
        
        return {
            "chip_state": chip_state,
            "ft_state": ft_state,
            "team_state": team_state,
            "restrictions": restrictions,
            "authority_level": authority_level,
            "run_context": run_context,
        }
    
    def check_action_allowed(
        self,
        action: str,
        restrictions: Any  # RunRestrictionSet
    ) -> bool:
        """
        Check if an action is allowed given restrictions
        
        Args:
            action: Action name (e.g., 'bench_boost_suggestion')
            restrictions: RunRestrictionSet from resolve_and_restrict()
        
        Returns:
            True if action is allowed, False if blocked
        """
        return not restrictions.is_action_blocked(action)
    
    def get_action_block_reason(
        self,
        action: str,
        restrictions: Any  # RunRestrictionSet
    ) -> str:
        """
        Get the reason why an action is blocked
        
        Args:
            action: Action name
            restrictions: RunRestrictionSet
        
        Returns:
            Block reason string, or empty string if not blocked
        """
        return restrictions.block_reason(action)
    
    def format_restrictions_output(self, restrictions: Any) -> str:
        """
        Format restrictions as human-readable text
        
        Args:
            restrictions: RunRestrictionSet
        
        Returns:
            Formatted string for display
        """
        return format_restrictions_for_display(restrictions)
    
    def inject_into_analysis(
        self,
        team_data: Dict[str, Any],
        sprint2_result: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Inject Sprint 2 restrictions into team_data for downstream use
        
        Args:
            team_data: Team data dict
            sprint2_result: Result from resolve_and_restrict()
        
        Returns:
            Modified team_data with Sprint 2 info
        """
        
        if team_data is None:
            team_data = {}
        
        team_data['_sprint2_restrictions'] = {
            'blocked_actions': sprint2_result['restrictions'].blocked_actions,
            'authority_level': sprint2_result['authority_level'],
            'warnings': sprint2_result['restrictions'].warnings,
            'suggestions': sprint2_result['restrictions'].suggestions,
        }
        
        team_data['_sprint2_ft_safe'] = (
            sprint2_result['ft_state'].is_safe_to_plan_transfers()
        )
        team_data['_sprint2_chip_safe'] = (
            sprint2_result['chip_state'].is_safe_to_use_chips()
        )
        team_data['_sprint2_team_safe'] = (
            sprint2_result['team_state'].is_safe_to_suggest_lineup()
        )
        
        return team_data


def should_skip_action(team_data: Dict[str, Any], action: str) -> bool:
    """
    Quick check if action should be skipped based on Sprint 2 restrictions
    
    Args:
        team_data: Team data (modified by inject_into_analysis)
        action: Action name
    
    Returns:
        True if action is blocked
    """
    restrictions = team_data.get('_sprint2_restrictions', {})
    blocked_actions = restrictions.get('blocked_actions', {})
    return action in blocked_actions


def get_authority_level(team_data: Dict[str, Any]) -> int:
    """
    Get current authority level from team data
    
    Args:
        team_data: Team data (modified by inject_into_analysis)
    
    Returns:
        Authority level 1-3 (1=Limited, 2=Normal, 3=Full)
    """
    return team_data.get('_sprint2_restrictions', {}).get('authority_level', 3)
