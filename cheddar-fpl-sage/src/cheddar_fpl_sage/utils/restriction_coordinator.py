#!/usr/bin/env python3
"""
Restriction Coordinator (Sprint 2)
Unified system for managing restrictions based on resolvable state tri-states.

This converts UNKNOWN/LOW confidence into explicit action restrictions,
replacing the need for prompts with safe degradation.
"""

from typing import Dict, List
from dataclasses import dataclass, field

from .resolvable_states import (
    FullRunStateResolution,
    ChipStateResolution,
    FreeTransferStateResolution,
    TeamStateResolution,
    ResolutionState,
)
from .chip_resolver_sprint2 import ChipRestrictionEnforcer
from .ft_resolver_sprint2 import FTRestrictionEnforcer


@dataclass
class ActionRestriction:
    """Represents one restricted action"""
    action: str                    # e.g., "bench_boost_suggestion"
    reason: str                    # Why restricted
    suggested_alternative: str = "" # What to do instead


@dataclass
class RunRestrictionSet:
    """
    Complete set of restrictions for a run.
    Actions not in this set are allowed.
    """
    
    blocked_actions: Dict[str, List[str]] = field(default_factory=dict)  # action → [reasons]
    warnings: List[str] = field(default_factory=list)
    suggestions: List[str] = field(default_factory=list)
    
    def is_action_blocked(self, action: str) -> bool:
        """Is this action blocked?"""
        return action in self.blocked_actions and len(self.blocked_actions[action]) > 0
    
    def block_reason(self, action: str) -> str:
        """Why is this action blocked?"""
        if not self.is_action_blocked(action):
            return ""
        return " | ".join(self.blocked_actions[action])
    
    def add_restriction(self, action: str, reason: str):
        """Add a restriction"""
        if action not in self.blocked_actions:
            self.blocked_actions[action] = []
        if reason not in self.blocked_actions[action]:
            self.blocked_actions[action].append(reason)
    
    def add_warning(self, warning: str):
        """Add a warning message"""
        if warning not in self.warnings:
            self.warnings.append(warning)
    
    def add_suggestion(self, suggestion: str):
        """Add a suggestion for user action"""
        if suggestion not in self.suggestions:
            self.suggestions.append(suggestion)
    
    def to_dict(self) -> Dict:
        """Convert to JSON-serializable format"""
        return {
            "blocked_actions": self.blocked_actions,
            "warnings": self.warnings,
            "suggestions": self.suggestions,
            "is_degraded": len(self.blocked_actions) > 0,
        }


class RestrictionCoordinator:
    """
    Main coordinator for handling all restrictions.
    
    Takes a FullRunStateResolution and produces RunRestrictionSet.
    """
    
    def coordinate_restrictions(
        self,
        run_state: FullRunStateResolution
    ) -> RunRestrictionSet:
        """
        Analyze all state resolutions and produce unified restriction set.
        
        Args:
            run_state: Complete state resolution from all sources
        
        Returns:
            RunRestrictionSet with all blocked actions and suggestions
        """
        
        restrictions = RunRestrictionSet()
        
        # Coordinate chip restrictions
        self._apply_chip_restrictions(run_state.chip_state, restrictions)
        
        # Coordinate FT restrictions
        self._apply_ft_restrictions(run_state.free_transfer_state, restrictions)
        
        # Coordinate team state restrictions
        self._apply_team_restrictions(run_state.team_state, restrictions)
        
        # Cross-check: some combos are risky
        self._apply_combo_restrictions(run_state, restrictions)
        
        # Generate suggestions
        self._generate_suggestions(run_state, restrictions)
        
        return restrictions
    
    def _apply_chip_restrictions(
        self,
        chip_state: ChipStateResolution,
        restrictions: RunRestrictionSet
    ):
        """Apply restrictions based on chip state"""
        
        blocked = ChipRestrictionEnforcer.get_blocked_actions(chip_state)
        for action, reason in blocked.items():
            restrictions.add_restriction(action, reason)
        
        if not chip_state.is_safe_to_use_chips():
            msg = ChipRestrictionEnforcer.suggest_action_when_unknown(chip_state)
            if msg:
                restrictions.add_warning(msg)
    
    def _apply_ft_restrictions(
        self,
        ft_state: FreeTransferStateResolution,
        restrictions: RunRestrictionSet
    ):
        """Apply restrictions based on free transfer state"""
        
        blocked = FTRestrictionEnforcer.get_blocked_actions(ft_state)
        for action, reason in blocked.items():
            restrictions.add_restriction(action, reason)
        
        if not ft_state.is_safe_to_plan_transfers():
            msg = FTRestrictionEnforcer.suggest_action_when_unknown(ft_state)
            if msg:
                restrictions.add_warning(msg)
    
    def _apply_team_restrictions(
        self,
        team_state: TeamStateResolution,
        restrictions: RunRestrictionSet
    ):
        """Apply restrictions based on team state"""
        
        if not team_state.is_safe_to_suggest_lineup():
            reasons = team_state.restriction_reasons()
            for reason in reasons:
                restrictions.add_restriction("lineup_suggestion", reason)
                restrictions.add_restriction("captain_suggestion", reason)
            
            if "unknown" in [r.lower() for r in reasons]:
                restrictions.add_warning(
                    "⚠️ Team state unknown. Lineup and captain suggestions disabled."
                )
    
    def _apply_combo_restrictions(
        self,
        run_state: FullRunStateResolution,
        restrictions: RunRestrictionSet
    ):
        """Apply restrictions for risky action combinations"""
        
        # Risky: unknown FT + aggressive transfer planning
        if not run_state.free_transfer_state.is_safe_to_plan_transfers():
            if run_state.chip_state.available_chips():
                # Also have chips but unknown FT = risky combo
                restrictions.add_restriction(
                    "aggressive_chip_transfer_combo",
                    "ft_unknown_with_available_chips"
                )
        
        # Risky: unknown chip + unknown team state
        if (not run_state.chip_state.is_safe_to_use_chips() and
            not run_state.team_state.is_safe_to_suggest_lineup()):
            restrictions.add_warning(
                "⚠️ Both chip and team state uncertain. "
                "System in safe mode (no aggressive actions)."
            )
    
    def _generate_suggestions(
        self,
        run_state: FullRunStateResolution,
        restrictions: RunRestrictionSet
    ):
        """Generate suggestions for improving data state"""
        
        if run_state.chip_state.resolution_state == ResolutionState.UNKNOWN:
            restrictions.add_suggestion(
                "📝 Update team_config.json with your chip status to enable chip decisions"
            )
        
        if run_state.free_transfer_state.resolution_state == ResolutionState.UNKNOWN:
            restrictions.add_suggestion(
                "📝 Update team_config.json with manual_free_transfers to enable transfer planning"
            )
        
        if run_state.team_state.resolution_state == ResolutionState.UNKNOWN:
            restrictions.add_suggestion(
                "📝 Provide your FPL team ID to sync team state for lineup suggestions"
            )


# Authority levels (simplified version of DAL)
def compute_authority_level(restrictions: RunRestrictionSet) -> int:
    """
    Compute authority level based on restrictions.
    
    Returns:
        1 = Limited (many restrictions)
        2 = Normal (few restrictions)
        3 = Full (no restrictions)
    """
    num_blocked = len(restrictions.blocked_actions)
    
    if num_blocked >= 5:
        return 1  # Limited authority
    elif num_blocked >= 2:
        return 2  # Normal authority
    else:
        return 3  # Full authority


def format_restrictions_for_display(restrictions: RunRestrictionSet) -> str:
    """
    Format restrictions as human-readable text.
    
    Returns:
        Markdown-formatted string
    """
    lines = []
    
    if not restrictions.blocked_actions and not restrictions.warnings:
        lines.append("✅ No restrictions. System running at full authority.")
        return "\n".join(lines)
    
    if restrictions.warnings:
        lines.append("⚠️  WARNINGS")
        for warning in restrictions.warnings:
            lines.append(f"  • {warning}")
    
    if restrictions.blocked_actions:
        lines.append("\n🚫 BLOCKED ACTIONS")
        for action, reasons in restrictions.blocked_actions.items():
            reason_str = " | ".join(reasons)
            lines.append(f"  • {action}: {reason_str}")
    
    if restrictions.suggestions:
        lines.append("\n💡 SUGGESTIONS TO UNLOCK")
        for suggestion in restrictions.suggestions:
            lines.append(f"  • {suggestion}")
    
    return "\n".join(lines)
