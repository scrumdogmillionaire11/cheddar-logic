"""
FPL Sage Utilities
Helper functions and tools
"""

from .chip_status_manager import ChipStatusManager
from .manual_transfer_manager import ManualTransferManager
from .output_manager import OutputBundleManager, generate_run_id, write_json_atomic, write_text_atomic

# Sprint 2: Resolvable States Framework
from .resolvable_states import (
    ResolutionState,
    ConfidenceLevel,
    ChipStateResolution,
    FreeTransferStateResolution,
    TeamStateResolution,
    FullRunStateResolution,
)

# Sprint 2: Non-Interactive Resolvers
from .chip_resolver_sprint2 import NonInteractiveChipResolver, ChipRestrictionEnforcer
from .ft_resolver_sprint2 import NonInteractiveFTResolver, FTRestrictionEnforcer
from .restriction_coordinator import (
    RestrictionCoordinator,
    RunRestrictionSet,
    compute_authority_level,
    format_restrictions_for_display,
)

__all__ = [
    # Legacy
    'ChipStatusManager',
    'ManualTransferManager',
    'OutputBundleManager',
    'generate_run_id',
    'write_json_atomic',
    'write_text_atomic',
    # Sprint 2
    'ResolutionState',
    'ConfidenceLevel',
    'ChipStateResolution',
    'FreeTransferStateResolution',
    'TeamStateResolution',
    'FullRunStateResolution',
    'NonInteractiveChipResolver',
    'ChipRestrictionEnforcer',
    'NonInteractiveFTResolver',
    'FTRestrictionEnforcer',
    'RestrictionCoordinator',
    'RunRestrictionSet',
    'compute_authority_level',
    'format_restrictions_for_display',
]
