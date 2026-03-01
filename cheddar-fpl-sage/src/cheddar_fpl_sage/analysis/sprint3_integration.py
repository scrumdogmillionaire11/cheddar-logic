"""
Sprint 3 — Integration Adapter

Integrates Sprint 3 fixes into FPLSageIntegration analysis pipeline.

Minimal, non-intrusive injection:
- Enriches team state with bench injuries (A)
- Resolves season deterministically before ruleset load (B)
- Wraps decision framework with crash handling (C)
- Replaces generic output codes with explicit codes (D)
"""

from dataclasses import dataclass
from typing import Dict, Any, Optional, List, Tuple

from cheddar_fpl_sage.utils.sprint3_fixes import (
    BenchInjuryEnricher,
    DeterministicSeasonResolver,
    DecisionFrameworkCrashHandler,
    ExplicitOutputCodegen,
    CrashContext,
)


@dataclass
class Sprint3Context:
    """Context for Sprint 3 fixes during a run."""
    season: Optional[int] = None
    season_source: str = "unknown"
    season_error: Optional[str] = None
    
    injury_counts: Dict[str, int] = None
    bench_injuries: List[Dict[str, Any]] = None
    
    framework_crash: Optional[CrashContext] = None
    output_code: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Serialize to dict for run_context."""
        return {
            "season": self.season,
            "season_source": self.season_source,
            "season_error": self.season_error,
            "injury_counts": self.injury_counts or {},
            "bench_injuries_count": len(self.bench_injuries) if self.bench_injuries else 0,
            "framework_crash": self.framework_crash.to_dict() if self.framework_crash else None,
            "output_code": self.output_code,
        }


class Sprint3IntegrationAdapter:
    """
    Non-intrusive adapter that injects Sprint 3 fixes into analysis pipeline.
    
    Called at specific points:
    1. After bootstrap data collected → enrich injuries (A)
    2. Before ruleset load → resolve season (B)
    3. Around decision framework → wrap with crash handling (C)
    4. When generating output → use explicit codes (D)
    """
    
    def __init__(self):
        self.context = Sprint3Context()
        self.season_resolver = DeterministicSeasonResolver()
    
    def enrich_team_state_with_bench_injuries(
        self,
        bootstrap_data: Dict[str, Any],
        team_state: Dict[str, Any],
        run_id: Optional[str] = None,
    ) -> Tuple[Dict[str, Any], Dict[str, int]]:
        """
        A) Enrich team state with bench injury info.
        
        Args:
            bootstrap_data: FPL bootstrap-static
            team_state: Existing team state (has XI)
            run_id: Run identifier for logging
            
        Returns:
            (enriched_team_state, injury_counts)
        """
        enricher = BenchInjuryEnricher(bootstrap_data)
        
        # Extract XI and bench from team_state
        xi_players = team_state.get("xi", [])
        bench_players = team_state.get("bench", [])
        
        # Convert to format needed by enricher
        xi_tuples = [
            (p.get("id"), p.get("name"), p.get("position"))
            for p in xi_players
        ]
        bench_tuples = [
            (p.get("id"), p.get("name"), p.get("position"))
            for p in bench_players
        ]
        
        # Enrich
        enriched = enricher.enrich_squad(xi_tuples, bench_tuples)
        
        # Count injuries
        injury_counts = enricher.count_injuries(enriched["xi"], enriched["bench"])
        
        # Add enrichment to team_state
        enriched_team_state = dict(team_state)
        enriched_team_state["injury_enrichment"] = {
            "xi": [p.to_dict() for p in enriched["xi"]],
            "bench": [p.to_dict() for p in enriched["bench"]],
            "counts": injury_counts,
        }
        
        # Store in context
        self.context.injury_counts = injury_counts
        self.context.bench_injuries = enriched["bench"]
        
        return enriched_team_state, injury_counts
    
    def resolve_season_deterministically(
        self,
        bootstrap_data: Optional[Dict[str, Any]] = None,
        config: Optional[Dict[str, Any]] = None,
        run_date: Optional[str] = None,
    ) -> Tuple[Optional[int], str, Optional[str]]:
        """
        B) Resolve season deterministically before ruleset load.
        
        Args:
            bootstrap_data: FPL bootstrap-static
            config: Configuration dict with optional "season" field
            run_date: Run date for fallback
            
        Returns:
            (season, source, error_code)
            If error: (None, "error", error_code)
        """
        config_season = None
        if config:
            config_season = config.get("fpl", {}).get("season")
        
        result = self.season_resolver.resolve(
            bootstrap_data=bootstrap_data,
            config_season=config_season,
            run_date=run_date,
        )
        
        # Store in context
        self.context.season = result.season
        self.context.season_source = result.source
        self.context.season_error = result.error_code
        
        return result.season, result.source, result.error_code
    
    def wrap_decision_framework_execution(
        self,
        decision_func,
        *args,
        run_id: Optional[str] = None,
        **kwargs,
    ) -> Tuple[Any, Optional[CrashContext]]:
        """
        C) Wrap decision framework execution with crash handling.
        
        Args:
            decision_func: Function to execute (typically decision framework)
            *args, **kwargs: Arguments to pass to function
            run_id: Run identifier for crash context
            
        Returns:
            (result, crash_context)
            If no crash: (result, None)
            If crash: (None, CrashContext)
        """
        result, crash_ctx = DecisionFrameworkCrashHandler.safe_execute(
            decision_func,
            *args,
            run_id=run_id,
            **kwargs,
        )
        
        # Store in context
        if crash_ctx:
            self.context.framework_crash = crash_ctx
        
        return result, crash_ctx
    
    def generate_explicit_output_code(
        self,
        situation: str,  # "missing_picks" | "stale_snapshot" | "framework_crash" | "season_error"
        authority_level: int = 1,
        **kwargs,
    ) -> Dict[str, Any]:
        """
        D) Generate explicit output code for the situation.
        
        Args:
            situation: Type of situation
            authority_level: Current authority level
            **kwargs: Additional context (age_hours, crash_ctx, etc.)
            
        Returns:
            Explicit output code dict
        """
        if situation == "missing_picks":
            code_dict = ExplicitOutputCodegen.code_for_missing_team_picks(authority_level)
        elif situation == "stale_snapshot":
            age_hours = kwargs.get("age_hours", 24)
            code_dict = ExplicitOutputCodegen.code_for_stale_snapshot(authority_level, age_hours)
        elif situation == "framework_crash":
            crash_ctx = kwargs.get("crash_ctx")
            code_dict = ExplicitOutputCodegen.code_for_decision_framework_crash(crash_ctx)
        elif situation == "season_error":
            code_dict = ExplicitOutputCodegen.code_for_season_resolution_fail()
        else:
            code_dict = {
                "output_code": "UNKNOWN",
                "error": f"Unknown situation: {situation}",
            }
        
        # Store in context
        self.context.output_code = code_dict.get("output_code")
        
        return code_dict
    
    def get_run_context_metadata(self) -> Dict[str, Any]:
        """Get all Sprint 3 metadata for run_context.json."""
        return {
            "sprint3": self.context.to_dict()
        }


# ============================================================================
# Integration Entry Points (To be called from FPLSageIntegration)
# ============================================================================

def inject_sprint3_into_analysis(
    bootstrap_data: Dict[str, Any],
    team_state: Dict[str, Any],
    config: Dict[str, Any],
    run_id: Optional[str] = None,
) -> Tuple[Dict[str, Any], Sprint3Context]:
    """
    Inject all Sprint 3 fixes into analysis in sequence.
    
    Args:
        bootstrap_data: FPL bootstrap-static
        team_state: Current team state
        config: Configuration
        run_id: Run identifier
        
    Returns:
        (modified_team_state, sprint3_context)
    """
    adapter = Sprint3IntegrationAdapter()
    
    # A) Enrich injuries
    enriched_team_state, injury_counts = adapter.enrich_team_state_with_bench_injuries(
        bootstrap_data, team_state, run_id
    )
    
    # B) Resolve season (does NOT modify state, just validates/logs)
    season, season_source, season_error = adapter.resolve_season_deterministically(
        bootstrap_data, config, run_id
    )
    
    if season_error:
        # Log error but continue (will be reflected in output code)
        print(f"⚠️  Season resolution error: {season_error}")
    
    return enriched_team_state, adapter.context
