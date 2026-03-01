"""
Canonical package namespace for Cheddar FPL Sage.

Exposes the higher-level entry points (collectors, analysis, utils) for downstream callers.
"""
from .analysis.enhanced_decision_framework import (
    EnhancedDecisionFramework,
)
from .analysis.fpl_sage_integration import (
    FPLSageIntegration,
)
from .collectors.enhanced_fpl_collector import (
    EnhancedFPLCollector,
)
from .utils import (
    ChipStatusManager,
)

__all__ = [
    "EnhancedDecisionFramework",
    "FPLSageIntegration",
    "EnhancedFPLCollector",
    "ChipStatusManager",
]
