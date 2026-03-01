"""
Sprint 3 — Implementation Modules

A) Injury enrichment for all 15 players
B) Season resolution determinism
C) Decision framework crash handling
D) Explicit failure codes

These are fixes applied to existing analysis pipeline.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Dict, Any, Optional, List, Tuple
import traceback
import sys
from pathlib import Path

# ============================================================================
# SECTION A: Injury Enrichment (All 15 Players)
# ============================================================================

class InjuryStatus(Enum):
    """FPL injury status mapping."""
    FIT = "a"           # available
    DOUBT = "d"         # doubt
    OUT = "i"           # injury
    UNKNOWN = "u"       # unknown


@dataclass
class PlayerInjuryInfo:
    """Enriched injury info for a player."""
    player_id: int
    name: str
    position: str
    status: InjuryStatus
    chance_of_playing_this_round: Optional[int]
    news: Optional[str] = None
    on_bench: bool = False
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "player_id": self.player_id,
            "name": self.name,
            "position": self.position,
            "status": self.status.value,
            "status_label": self.status.name,
            "chance_of_playing_this_round": self.chance_of_playing_this_round,
            "news": self.news,
            "on_bench": self.on_bench,
        }


class BenchInjuryEnricher:
    """
    Enriches all 15 squad players (XI + bench) with injury data from bootstrap.
    
    Previously: Only XI players got injury enrichment.
    Now: All players, including bench, are enriched consistently.
    """
    
    def __init__(self, bootstrap_data: Dict[str, Any]):
        """
        Args:
            bootstrap_data: Full bootstrap-static from FPL API
        """
        self.bootstrap_data = bootstrap_data
        self._build_elements_index()
    
    def _build_elements_index(self):
        """Build element_id → element dict for fast lookup."""
        self.elements_by_id = {}
        for element in self.bootstrap_data.get("elements", []):
            self.elements_by_id[element["id"]] = element
    
    def enrich_player(self, player_id: int, player_name: str, position: str, 
                     on_bench: bool = False) -> PlayerInjuryInfo:
        """
        Enrich a single player with injury data.
        
        Args:
            player_id: FPL player ID
            player_name: Player name
            position: Position code (DEF/MID/FWD)
            on_bench: Whether player is on bench
            
        Returns:
            PlayerInjuryInfo with enriched data
        """
        element = self.elements_by_id.get(player_id)
        
        if not element:
            return PlayerInjuryInfo(
                player_id=player_id,
                name=player_name,
                position=position,
                status=InjuryStatus.UNKNOWN,
                chance_of_playing_this_round=None,
                on_bench=on_bench,
            )
        
        # Map FPL status to internal enum
        fpl_status = element.get("status", "u")
        try:
            status = InjuryStatus(fpl_status)
        except ValueError:
            status = InjuryStatus.UNKNOWN
        
        return PlayerInjuryInfo(
            player_id=player_id,
            name=player_name,
            position=position,
            status=status,
            chance_of_playing_this_round=element.get("chance_of_playing_this_round"),
            news=element.get("news"),
            on_bench=on_bench,
        )
    
    def enrich_squad(self, xi_players: List[Tuple[int, str, str]], 
                    bench_players: List[Tuple[int, str, str]]) -> Dict[str, List[PlayerInjuryInfo]]:
        """
        Enrich all squad players (XI + bench).
        
        Args:
            xi_players: List of (player_id, name, position) for XI
            bench_players: List of (player_id, name, position) for bench
            
        Returns:
            Dict with "xi" and "bench" keys, each containing list of PlayerInjuryInfo
        """
        xi_enriched = [
            self.enrich_player(pid, name, pos, on_bench=False)
            for pid, name, pos in xi_players
        ]
        
        bench_enriched = [
            self.enrich_player(pid, name, pos, on_bench=True)
            for pid, name, pos in bench_players
        ]
        
        return {
            "xi": xi_enriched,
            "bench": bench_enriched,
        }
    
    def count_injuries(self, xi_info: List[PlayerInjuryInfo], 
                      bench_info: List[PlayerInjuryInfo]) -> Dict[str, int]:
        """Count injured players by section."""
        xi_injured = sum(1 for p in xi_info if p.status in (InjuryStatus.DOUBT, InjuryStatus.OUT))
        bench_injured = sum(1 for p in bench_info if p.status in (InjuryStatus.DOUBT, InjuryStatus.OUT))
        
        return {
            "xi_injured": xi_injured,
            "bench_injured": bench_injured,
            "total_injured": xi_injured + bench_injured,
        }


# ============================================================================
# SECTION B: Season Resolution Determinism
# ============================================================================

@dataclass
class SeasonResolutionResult:
    """Result of season resolution."""
    season: Optional[int]
    source: str  # "bootstrap" | "config" | "fallback" | "error"
    error_code: Optional[str] = None  # FAIL_CODE_* if error
    error_message: Optional[str] = None


class DeterministicSeasonResolver:
    """
    Resolves season deterministically from data, never guessing.
    
    Resolution order:
    1. Bootstrap events (most reliable)
    2. Config override (if provided)
    3. Date-based fallback (if available)
    4. Error code (FAIL_CODE_SEASON_RESOLUTION_UNKNOWN)
    """
    
    def resolve(self, bootstrap_data: Optional[Dict[str, Any]] = None,
               config_season: Optional[int] = None,
               run_date: Optional[str] = None) -> SeasonResolutionResult:
        """
        Resolve season using deterministic sources.
        
        Args:
            bootstrap_data: Bootstrap-static from API
            config_season: Explicitly configured season (optional override)
            run_date: Run date for fallback (ISO format)
            
        Returns:
            SeasonResolutionResult with season, source, and optional error
        """
        # Try: Bootstrap events
        if bootstrap_data:
            season = self._get_season_from_bootstrap(bootstrap_data)
            if season is not None:
                return SeasonResolutionResult(
                    season=season,
                    source="bootstrap",
                )
        
        # Try: Config override
        if config_season is not None:
            return SeasonResolutionResult(
                season=config_season,
                source="config",
            )
        
        # Try: Date-based fallback
        if run_date:
            season = self._get_season_from_date(run_date)
            if season is not None:
                return SeasonResolutionResult(
                    season=season,
                    source="fallback",
                )
        
        # Error: Season truly unknown
        return SeasonResolutionResult(
            season=None,
            source="error",
            error_code="FAIL_CODE_SEASON_RESOLUTION_UNKNOWN",
            error_message="Season could not be resolved from bootstrap, config, or fallback",
        )
    
    def _get_season_from_bootstrap(self, bootstrap_data: Dict[str, Any]) -> Optional[int]:
        """Extract season from bootstrap events."""
        events = bootstrap_data.get("events", [])
        if not events:
            return None
        
        # Current season is typically max event season
        seasons = set(evt.get("season") for evt in events if "season" in evt)
        return max(seasons) if seasons else None
    
    def _get_season_from_date(self, run_date: str) -> Optional[int]:
        """
        Compute season from run date.
        FPL seasons typically run Aug(N) -> May(N+1).
        """
        try:
            from datetime import datetime
            dt = datetime.fromisoformat(run_date.replace("Z", "+00:00"))
            year = dt.year
            month = dt.month
            
            # If Jan-May, season started last August
            if month < 8:
                return year - 1
            # If Aug-Dec, season started this August
            else:
                return year
        except (ValueError, AttributeError):
            return None


# ============================================================================
# SECTION C: Decision Framework Crash Handling
# ============================================================================

@dataclass
class CrashContext:
    """Context captured when a crash occurs."""
    exception_type: str
    exception_message: str
    file_name: str
    function_name: str
    line_number: int
    run_id: Optional[str] = None
    traceback_str: str = ""
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "exception_type": self.exception_type,
            "exception_message": self.exception_message,
            "location": {
                "file": self.file_name,
                "function": self.function_name,
                "line": self.line_number,
            },
            "run_id": self.run_id,
            "traceback": self.traceback_str,
        }


class DecisionFrameworkCrashHandler:
    """
    Wraps decision framework to catch crashes and provide context.
    
    Replaces: Silent failure + misleading "HOLD — projection failure"
    With: Explicit error code + full context
    """
    
    @staticmethod
    def capture_crash(exc: Exception, run_id: Optional[str] = None) -> CrashContext:
        """
        Capture crash context from an exception.
        
        Args:
            exc: The exception that occurred
            run_id: Optional run identifier
            
        Returns:
            CrashContext with full error information
        """
        exc_type = type(exc).__name__
        exc_msg = str(exc)
        
        # Get traceback info
        tb = traceback.extract_tb(sys.exc_info()[2])
        if tb:
            last_frame = tb[-1]
            file_name = Path(last_frame.filename).name
            function_name = last_frame.name
            line_number = last_frame.lineno
        else:
            file_name = "unknown"
            function_name = "unknown"
            line_number = 0
        
        return CrashContext(
            exception_type=exc_type,
            exception_message=exc_msg,
            file_name=file_name,
            function_name=function_name,
            line_number=line_number,
            run_id=run_id,
            traceback_str=traceback.format_exc(),
        )
    
    @staticmethod
    def safe_execute(func, *args, run_id: Optional[str] = None, **kwargs):
        """
        Execute a function with crash handling.
        
        Args:
            func: Function to execute
            *args, **kwargs: Arguments to pass
            run_id: Optional run identifier
            
        Returns:
            Tuple of (result, crash_context)
            If no crash: (result, None)
            If crash: (None, CrashContext)
        """
        try:
            result = func(*args, **kwargs)
            return result, None
        except Exception as exc:
            crash_ctx = DecisionFrameworkCrashHandler.capture_crash(exc, run_id)
            return None, crash_ctx


# ============================================================================
# SECTION D: Explicit Failure Codes
# ============================================================================

class DecisionOutputCode(Enum):
    """Explicit output codes replacing generic HOLD/FAIL labels."""
    
    # Data-related holds (system tried but data prevented decision)
    HOLD_DATA_MISSING_TEAM_PICKS = "HOLD_DATA_MISSING_TEAM_PICKS"
    HOLD_DATA_STALE_SNAPSHOT = "HOLD_DATA_STALE_SNAPSHOT"
    HOLD_DATA_INCOMPLETE_PROJECTIONS = "HOLD_DATA_INCOMPLETE_PROJECTIONS"
    
    # Code-related failures (system crashed or errored)
    FAIL_CODE_DECISION_FRAMEWORK_EXCEPTION = "FAIL_CODE_DECISION_FRAMEWORK_EXCEPTION"
    FAIL_CODE_RULESET_LOAD_SEASON_UNKNOWN = "FAIL_CODE_RULESET_LOAD_SEASON_UNKNOWN"
    FAIL_CODE_INVALID_DATA_FORMAT = "FAIL_CODE_INVALID_DATA_FORMAT"
    
    # Successful holds
    HOLD_SAFE_MODE_ACTIVE = "HOLD_SAFE_MODE_ACTIVE"


class ExplicitOutputCodegen:
    """
    Generates truthful, explicit output codes for decisions.
    
    Previously: Generic "HOLD — projection failure — STALE_SNAPSHOT"
    Now: Specific codes like HOLD_DATA_MISSING_TEAM_PICKS or FAIL_CODE_DECISION_FRAMEWORK_EXCEPTION
    """
    
    @staticmethod
    def code_for_missing_team_picks(authority_level: int) -> Dict[str, Any]:
        """Output code when team picks are unavailable."""
        return {
            "output_code": DecisionOutputCode.HOLD_DATA_MISSING_TEAM_PICKS.value,
            "authority_level": authority_level,
            "reason": "Team picks not available",
            "recommendation": "Provide team picks (manual override or fallback to previous GW)",
            "blocked_actions": ["hits", "chips", "aggressive_transfers"],
        }
    
    @staticmethod
    def code_for_stale_snapshot(authority_level: int, age_hours: int) -> Dict[str, Any]:
        """Output code when team state is stale."""
        return {
            "output_code": DecisionOutputCode.HOLD_DATA_STALE_SNAPSHOT.value,
            "authority_level": authority_level,
            "reason": f"Team state is {age_hours}+ hours old",
            "recommendation": "Refresh team state from API",
            "blocked_actions": ["hits", "chips"],
        }
    
    @staticmethod
    def code_for_decision_framework_crash(crash_ctx: CrashContext) -> Dict[str, Any]:
        """Output code when decision framework crashes."""
        return {
            "output_code": DecisionOutputCode.FAIL_CODE_DECISION_FRAMEWORK_EXCEPTION.value,
            "error_type": crash_ctx.exception_type,
            "error_message": crash_ctx.exception_message,
            "location": {
                "file": crash_ctx.file_name,
                "function": crash_ctx.function_name,
                "line": crash_ctx.line_number,
            },
            "run_id": crash_ctx.run_id,
            "recommendation": f"Fix {crash_ctx.exception_type} in {crash_ctx.function_name}",
        }
    
    @staticmethod
    def code_for_season_resolution_fail() -> Dict[str, Any]:
        """Output code when season cannot be resolved."""
        return {
            "output_code": DecisionOutputCode.FAIL_CODE_RULESET_LOAD_SEASON_UNKNOWN.value,
            "error": "Season could not be determined from bootstrap, config, or fallback",
            "recommendation": "Provide season in config or ensure bootstrap data is available",
        }
