#!/usr/bin/env python3
"""
Enhanced FPL Decision Framework
Implementation of feedback improvements for sharper analysis output
"""

import logging
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)

from cheddar_fpl_sage.models.canonical_projections import (
    CanonicalProjectionSet,
    OptimizedXI,
    validate_projection_set,
)
from cheddar_fpl_sage.models.injury_report import (
    InjuryReport,
    InjuryStatus,
)
from .decision_framework import (
    ChipAnalyzer,
    TransferAdvisor,
    CaptainSelector,
    OutputFormatter
)


class ChipType(Enum):
    BENCH_BOOST = "BB"
    TRIPLE_CAPTAIN = "TC"
    FREE_HIT = "FH"
    WILDCARD = "WC"
    NONE = "NONE"


class RiskLevel(Enum):
    ACCEPTABLE = "acceptable"
    UNACCEPTABLE = "unacceptable"
    CRITICAL = "critical"


@dataclass
class RiskScenario:
    """Explicit downside scenario quantification"""
    condition: str
    expected_loss_range: Tuple[int, int]  # (min_loss, max_loss) 
    risk_level: RiskLevel
    probability_estimate: Optional[float] = None
    mitigation_action: Optional[str] = None


@dataclass
class ChipDecisionContext:
    """Context for chip timing decisions"""
    current_gw: int
    chip_type: ChipType
    available_chips: List[ChipType]
    fixture_conflicts: List[str] = None
    pivot_conditions: List[str] = None
    next_optimal_window: Optional[int] = None
    selected_chip: Optional[ChipType] = None
    reason_codes: List[str] = None
    current_window_score: Optional[float] = None
    best_future_window_score: Optional[float] = None
    window_rank: Optional[int] = None
    current_window_name: Optional[str] = None
    best_future_window_name: Optional[str] = None


@dataclass
class DecisionOutput:
    """Enhanced decision output with explicit risk scenarios"""
    primary_decision: str
    reasoning: str
    risk_scenarios: List[RiskScenario]
    risk_posture: str = "BALANCED"  # Manager risk tolerance
    
    # Decision quality metrics
    decision_status: str = "PASS"  # "PASS" | "HOLD" | "BLOCKED" 
    confidence_score: float = 1.0  # 0-1, higher = more confident
    block_reason: Optional[str] = None  # When status != "OK"
    
    tilt_armor_threshold: int = 0  # "Decision still correct if X fewer points"
    chip_guidance: Optional[ChipDecisionContext] = None
    lineup_focus: str = "full_optimization"  # or "captaincy_only"
    next_gw_prep: Dict = None
    variance_expectations: Dict = None
    captaincy: Dict = None
    transfer_recommendations: List[Dict] = None
    free_hit_context: Optional[Dict] = None
    free_hit_plan: Optional[Dict] = None
    post_free_hit_plan: Optional[Dict] = None


class EnhancedDecisionFramework:
    """
    Enhanced decision framework implementing GPT feedback.
    
    NOTE: This orchestrator delegates to domain modules for:
    - ChipAnalyzer: Chip timing decisions
    - TransferAdvisor: Transfer recommendations
    - CaptainSelector: Captain/vice-captain picks
    - OutputFormatter: Summary generation
    """
    
    def __init__(self, risk_posture: str = "BALANCED"):
        """
        Initialize orchestrator with domain module delegation.
        
        Args:
            risk_posture: Manager risk tolerance (CONSERVATIVE|BALANCED|AGGRESSIVE)
        """
        from .decision_framework.constants import normalize_risk_posture
        
        # Validate and normalize risk_posture
        self.risk_posture = normalize_risk_posture(risk_posture)
        
        # Delegate to domain modules
        self._chip_analyzer = ChipAnalyzer(risk_posture=self.risk_posture)
        self._transfer_advisor = TransferAdvisor(risk_posture=self.risk_posture)
        self._captain_selector = CaptainSelector(risk_posture=self.risk_posture)
        self._output_formatter = OutputFormatter()
        
        # Legacy orchestrator state
        self.risk_thresholds = {
            "acceptable_loss": 4,
            "unacceptable_loss": 8,
            "critical_loss": 12
        }
        self.chip_optimization_rules = {
            "bb_focus_captaincy_only": True,
            "tc_setup_gameweeks_ahead": 2
        }
        self._window_context: Dict[str, Any] = {}
    
    def _load_injury_reports(self, team_data: Dict) -> Optional[Dict[int, InjuryReport]]:
        """Load injury reports from resolved data if available"""
        try:
            raw_reports = team_data.get('injury_reports')
            if not raw_reports:
                logger.debug("No injury reports found in team_data")
                return None

            def _normalize_key(value: Any) -> Optional[int]:
                try:
                    return int(value)
                except (TypeError, ValueError):
                    return None

            parsed_reports: Dict[int, InjuryReport] = {}
            entries = []
            if isinstance(raw_reports, dict):
                entries.extend(raw_reports.values())
            elif isinstance(raw_reports, list):
                entries.extend(raw_reports)
            else:
                logger.warning("Unexpected injury_reports format: %s", type(raw_reports).__name__)
                return None

            for entry in entries:
                report = None
                if isinstance(entry, InjuryReport):
                    report = entry
                elif isinstance(entry, dict):
                    try:
                        report = InjuryReport.from_dict(entry)
                    except (KeyError, ValueError, TypeError) as exc:
                        logger.warning("Failed to parse injury report entry: %s", exc)
                        continue
                if not report:
                    continue
                player_id = _normalize_key(report.player_id)
                if player_id is None or player_id < 0:
                    continue
                parsed_reports[player_id] = report

            if parsed_reports:
                logger.info(f"Loaded {len(parsed_reports)} injury reports from team_data")
                return parsed_reports

            logger.debug("Injury reports present but none could be parsed")
            return None

        except (KeyError, ValueError, TypeError) as e:
            logger.warning(f"Failed to load injury reports: {e}")
            return None
    
    def _optimize_starting_xi(self, team_data: Dict, projections: CanonicalProjectionSet, 
                             injury_reports: Optional[Dict[int, InjuryReport]] = None) -> OptimizedXI:
        """MANDATORY XI optimization with formation validation and injury status filtering"""
        squad = team_data.get('current_squad', [])

        def _pos_counts_from_collection(collection):
            counts = {'GK': 0, 'DEF': 0, 'MID': 0, 'FWD': 0, 'UNK': 0}
            for item in collection:
                pos = getattr(item, "position", None) if not isinstance(item, dict) else item.get("position")
                pos = pos or (item.get("element_type") if isinstance(item, dict) else None)
                if isinstance(pos, int):
                    pos = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}.get(pos, "UNK")
                pos = pos if pos in counts else "UNK"
                counts[pos] = counts.get(pos, 0) + 1
            return counts
        
        # Get projections for all squad players
        def _resolve_player_id(record: Dict[str, Any]) -> Optional[int]:
            candidate = record.get('player_id') or record.get('id') or record.get('element')
            try:
                return int(candidate)
            except (TypeError, ValueError):
                return None

        squad_projections = []
        missing_proj = []
        injury_status_by_id = {}
        name_by_id = {}
        out_players = []
        
        for player in squad:
            player_id = _resolve_player_id(player)
            if player_id is None:
                continue
            name_by_id[player_id] = player.get('name') or player.get('web_name') or f"Player {player_id}"

            # Use injury resolution data if available, otherwise fall back to squad status
            injury_status = InjuryStatus.FIT  # Default
            if injury_reports and player_id in injury_reports:
                injury_status = injury_reports[player_id].status
            else:
                # Fall back to legacy status_flag from squad data
                legacy_status = (player.get('status_flag') or 'FIT').upper()
                if legacy_status == 'OUT':
                    injury_status = InjuryStatus.OUT
                elif legacy_status in ['DOUBT', 'DOUBTFUL']:
                    injury_status = InjuryStatus.DOUBT
                    
            injury_status_by_id[player_id] = injury_status
            
            if injury_status == InjuryStatus.OUT:
                out_players.append(name_by_id[player_id])
            
            proj = projections.get_by_id(player_id)
            if proj:
                squad_projections.append(proj)
            elif player_id == 999999:  # Manually added player (Collins)
                # Create fallback projection for manually added players
                from cheddar_fpl_sage.models.canonical_projections import CanonicalPlayerProjection
                fallback_proj = CanonicalPlayerProjection(
                    player_id=player_id,
                    name=player.get('name', 'Manual Player'),
                    position=player.get('position', 'DEF'),
                    team=player.get('team', 'CRY'),
                    current_price=player.get('current_price', 5.0),
                    nextGW_pts=5.0,  # Conservative estimate for Collins
                    next6_pts=30.0,  # Conservative estimate
                    xMins_next=80.0,  # Assume likely to play
                    volatility_score=0.3,  # Moderate volatility
                    ceiling=8.0,
                    floor=2.0,
                    tags=[],
                    confidence=0.7,  # Lower confidence for manual player
                    ownership_pct=5.0,  # Low ownership estimate
                    captaincy_rate=0.0
                )
                squad_projections.append(fallback_proj)
                logger.info(f"Created fallback projection for manual player: {fallback_proj.name} ({fallback_proj.nextGW_pts} pts)")
            else:
                missing_proj.append(player_id)
                
        if len(squad_projections) < 15:
            logger.warning(
                "XI feasibility: missing projections",
                extra={
                    "squad_pos_counts": _pos_counts_from_collection(squad),
                    "projection_pos_counts": _pos_counts_from_collection(squad_projections),
                    "missing_proj_ids": missing_proj,
                },
            )
            raise ValueError(f"Insufficient squad projections: {len(squad_projections)}/15")
            
        # Filter OUT players from XI optimization
        healthy_projections = [
            proj for proj in squad_projections
            if injury_status_by_id.get(proj.player_id, InjuryStatus.FIT) != InjuryStatus.OUT
        ]
        if len(healthy_projections) < 11:
            logger.warning("Not enough healthy players to fill XI: %s", ", ".join(out_players) or "unknown")
            raise ValueError("XI infeasible due to OUT players")

        sorted_by_points = sorted(healthy_projections, key=lambda x: x.nextGW_pts, reverse=True)
        
        # Try to form valid XI with best 11 players
        attempts = []
        for i in range(4):  # Try different GK combinations
            try:
                # Take GK with highest points from available
                gks = [p for p in sorted_by_points if p.position == 'GK']
                if len(gks) <= i:
                    continue
                    
                selected_gk = gks[i]
                remaining = [p for p in sorted_by_points if p != selected_gk]
                
                # Greedy selection maintaining formation constraints
                xi = [selected_gk]
                positions_needed = {'DEF': 3, 'MID': 3, 'FWD': 1}  # Start with 3-3-1, expand as needed
                
                for player in remaining:
                    pos = player.position
                    if pos in positions_needed and positions_needed[pos] > 0:
                        xi.append(player)
                        positions_needed[pos] -= 1
                        
                # Fill remaining slots optimally
                while len(xi) < 11 and remaining:
                    best_remaining = None
                    for player in remaining:
                        if player not in xi:
                            pos = player.position
                            current_pos_count = len([p for p in xi if p.position == pos])
                            
                            # Check if we can add this position
                            max_limits = {'GK': 1, 'DEF': 5, 'MID': 5, 'FWD': 3}
                            min_limits = {'GK': 1, 'DEF': 3, 'MID': 3, 'FWD': 1}
                            
                            if current_pos_count < max_limits[pos]:
                                if not best_remaining or player.nextGW_pts > best_remaining.nextGW_pts:
                                    best_remaining = player
                                    
                    if best_remaining:
                        xi.append(best_remaining)
                        remaining.remove(best_remaining)
                    else:
                        break
                        
                if len(xi) == 11:
                    bench = [p for p in squad_projections if p not in xi]
                    captain_pool = sorted(xi, key=lambda x: x.nextGW_pts, reverse=True)[:5]
                    
                    # Calculate formation string
                    pos_counts = {'DEF': 0, 'MID': 0, 'FWD': 0}
                    for player in xi:
                        if player.position in pos_counts:
                            pos_counts[player.position] += 1
                    formation = f"{pos_counts['DEF']}-{pos_counts['MID']}-{pos_counts['FWD']}"
                    
                    total_pts = sum(p.nextGW_pts for p in xi)
                    attempts.append({"formation": formation, "status": "PASS"})
                    return OptimizedXI(
                        starting_xi=xi,
                        bench=bench[:4],
                        formation=formation,
                        captain_pool=captain_pool,
                        total_expected_pts=total_pts,
                        formation_valid=True
                    )

            except (ValueError, IndexError, KeyError, AttributeError) as exc:
                attempts.append({"attempt": i, "status": "FAIL", "reason": str(exc)})
                continue
                
        logger.error(
            "XI feasibility failed",
            extra={
                "squad_pos_counts": _pos_counts_from_collection(squad),
                "projection_pos_counts": _pos_counts_from_collection(squad_projections),
                "attempts": attempts,
            },
        )
        raise ValueError("Cannot form valid XI from current squad")
    
    def _recommend_captaincy_from_xi(self, optimized_xi: OptimizedXI, fixture_data: Dict, 
                                   projections: CanonicalProjectionSet = None,
                                   injury_reports: Optional[Dict[int, InjuryReport]] = None) -> Dict:
        """Delegate to CaptainSelector for captain recommendation."""
        return self._captain_selector.recommend_captaincy_from_xi(
            optimized_xi, fixture_data, projections, injury_reports
        )

    def _apply_manual_transfers(self, team_data: Dict) -> Dict:
        """Delegate to TransferAdvisor for manual transfer application."""
        return self._transfer_advisor.apply_manual_transfers(team_data)

    def analyze_chip_decision(self, team_data: Dict, fixture_data: Dict,
                            projections: CanonicalProjectionSet, current_gw: int) -> DecisionOutput:
        """
        Enhanced chip analysis with forward-looking preparation
        ENFORCES canonical projection contract - no ad-hoc calculations
        """
        logger.info("=== ANALYZE_CHIP_DECISION START ===")
        
        # CRITICAL A1: Validate risk_posture is single source of truth
        team_risk_posture = team_data.get('team_info', {}).get('risk_posture')
        if team_risk_posture and team_risk_posture != self.risk_posture:
            error_msg = (
                f"CRITICAL: Risk posture mismatch detected!\n"
                f"  Framework initialized with: {self.risk_posture}\n"
                f"  Team data contains: {team_risk_posture}\n"
                f"  Analysis BLOCKED to prevent inconsistent decisions.\n"
                f"  Fix: Ensure risk_posture is set once at initialization."
            )
            logger.error(error_msg)
            return DecisionOutput(
                primary_decision="BLOCKED",
                reasoning="Risk posture mismatch - analysis blocked for safety",
                decision_status="BLOCKED",
                block_reason=f"risk_posture mismatch: framework={self.risk_posture}, data={team_risk_posture}",
                confidence_score=0.0,
                risk_scenarios=[],
                risk_posture=self.risk_posture
            )
        
        logger.info(f"Risk posture validated: {self.risk_posture}")
        
        # CRITICAL FIX: Apply manual transfers FIRST before any analysis
        original_squad_size = len(team_data.get('current_squad', []))
        team_data = self._apply_manual_transfers(team_data)
        new_squad_size = len(team_data.get('current_squad', []))
        logger.info(f"Squad size: {original_squad_size} -> {new_squad_size} after applying manual transfers")
        
        # Debug: Show final squad composition after manual transfers
        final_squad = team_data.get('current_squad', [])
        final_squad_names = [f"{p.get('name', 'Unknown')} ({p.get('position', '?')})" for p in final_squad]
        logger.info(f"Final squad after manual transfers: {', '.join(final_squad_names)}")
        
        # Check team counts after manual transfers (using 'team' field)
        team_counts = {}
        for p in final_squad:
            team = p.get('team', 'UNK')
            team_counts[team] = team_counts.get(team, 0) + 1
        
        logger.info(f"Team counts after manual transfers: {team_counts}")
        mci_players = [p for p in final_squad if p.get('team') == 'MCI']
        mci_names = [p.get('name', 'Unknown') for p in mci_players]
        logger.info(f"MCI players after manual transfers ({len(mci_players)}): {', '.join(mci_names)}")
        
        # Cache projections for later use in candidate generation
        self._cached_projections = projections
        
        # Contract enforcement - validate projections first
        validation_result = validate_projection_set(projections)
        if not validation_result['valid']:
            return DecisionOutput(
                primary_decision="HOLD", 
                reasoning=f"Invalid projections: {validation_result['errors']}",
                decision_status="BLOCKED",
                block_reason="Projection validation failed",
                confidence_score=0.0,
                risk_scenarios=[RiskScenario(
                    condition="Data quality failure",
                    expected_loss_range=(0, 0),
                    risk_level=RiskLevel.CRITICAL,
                    mitigation_action="Fix projection data and retry"
                )]
            )
        
        # Load injury reports for OUT player filtering
        injury_reports = self._load_injury_reports(team_data)
        
        # CRITICAL: Check squad rule compliance FIRST - violations need URGENT transfer
        squad_violations = self._validate_squad_composition(team_data)
        if squad_violations:
            return self._create_squad_violation_decision(squad_violations, team_data, projections, injury_reports)
            
        # MANDATORY: Optimize XI before any decisions with injury filtering
        try:
            optimized_xi = self._optimize_starting_xi(team_data, projections, injury_reports)
            # Store in team_data for later retrieval by API
            team_data['_optimized_xi'] = optimized_xi
        except ValueError as e:
            return DecisionOutput(
                primary_decision="HOLD",
                reasoning=f"Cannot optimize valid XI: {str(e)}",
                decision_status="BLOCKED", 
                block_reason="Formation constraints violated",
                confidence_score=0.0,
                risk_scenarios=[RiskScenario(
                    condition="Formation optimization failure",
                    expected_loss_range=(0, 0),
                    risk_level=RiskLevel.CRITICAL,
                    mitigation_action="Fix squad composition to allow valid formations"
                )]
            )
            
        available_chips = self._get_available_chips(team_data.get('chip_status', {}))
        free_transfers = team_data.get('team_info', {}).get('free_transfers', 0)
        window_context = self._build_chip_window_context(team_data, fixture_data, current_gw)
        window_context['available_chips'] = available_chips
        window_context['current_gw'] = current_gw
        self._window_context = window_context
        
        # Determine primary decision based on dynamic chip prioritization
        decision = self._decide_optimal_chip_strategy(
            team_data, fixture_data, projections, optimized_xi, current_gw, available_chips, free_transfers, window_context
        )

        # Add captaincy using optimized XI captain pool only, excluding OUT players
        decision.captaincy = self._recommend_captaincy_from_xi(optimized_xi, fixture_data, projections, injury_reports)
        decision.transfer_recommendations = self._recommend_transfers(team_data, free_transfers, projections)
        decision.optimized_xi = optimized_xi
        return decision
    
    def _decide_optimal_chip_strategy(self, team_data: Dict, fixture_data: Dict, 
                                      projections: CanonicalProjectionSet, optimized_xi: OptimizedXI, 
                                      current_gw: int, available_chips: List[ChipType], free_transfers: int,
                                      window_context: Dict[str, Any]) -> DecisionOutput:
        """
        Dynamic chip strategy that considers team state, transfers available, and chip options.
        """
        squad = team_data.get('current_squad', [])
        flagged_players = [p for p in squad if p.get('status_flag') in ['OUT', 'DOUBT']]
        bench_players = [p for p in squad if not p.get('is_starter', True)]

        critical_transfer_needs = self._assess_critical_transfer_needs(squad)
        bench_strength = self._assess_bench_strength(bench_players, projections)

        window_context = window_context or {}
        window_context.setdefault('reason_codes', [])
        window_context['available_chips'] = available_chips
        window_context['current_gw'] = current_gw
        self._window_context = window_context

        def _record_reason(code: str):
            codes = window_context.setdefault('reason_codes', [])
            if code not in codes:
                codes.append(code)

        def _finalize(decision_obj: DecisionOutput, chip_type: ChipType):
            return self._finalize_decision(decision_obj, chip_type, available_chips)

        # Ensure window_context is a dict before using .get()
        if not isinstance(window_context, dict):
            window_context = {}
        
        if available_chips and window_context.get('window_rank', 1) > 1:
            _record_reason("window_future_better")
            reason_text = (
                f"Current window score {window_context.get('current_window_score', 0)} "
                f"is below the best future window score {window_context.get('best_future_window_score', 0)}."
            )
            return self._return_no_chip_action(window_context, available_chips, reason_text, reason_code="window_future_better")

        tc_allowed, tc_reason_codes, tc_target = self._can_activate_triple_captain(
            team_data, fixture_data, window_context, available_chips, projections
        )
        window_context['reason_codes'] = list(dict.fromkeys(window_context.get('reason_codes', []) + tc_reason_codes))

        if critical_transfer_needs == 0 and available_chips:
            best_chip = self._choose_best_chip_option(optimized_xi, bench_strength, available_chips)
            if best_chip == ChipType.TRIPLE_CAPTAIN and tc_allowed:
                return _finalize(
                    self._analyze_triple_captain_decision(team_data, fixture_data, current_gw, primary_target=tc_target),
                    ChipType.TRIPLE_CAPTAIN
                )
            if best_chip == ChipType.BENCH_BOOST:
                return _finalize(
                    self._analyze_bench_boost_decision(team_data, fixture_data, current_gw),
                    ChipType.BENCH_BOOST
                )

        if free_transfers == 0:
            if self._should_use_free_hit(team_data, fixture_data, current_gw, critical_transfer_needs, free_transfers, available_chips):
                return _finalize(
                    self._analyze_free_hit_decision(team_data, fixture_data, current_gw, critical_transfer_needs, free_transfers),
                    ChipType.FREE_HIT
                )
            if tc_allowed:
                return _finalize(
                    self._analyze_triple_captain_decision(team_data, fixture_data, current_gw, primary_target=tc_target),
                    ChipType.TRIPLE_CAPTAIN
                )
            if bench_strength >= 12 and ChipType.BENCH_BOOST in available_chips:
                return _finalize(
                    self._analyze_bench_boost_decision(team_data, fixture_data, current_gw),
                    ChipType.BENCH_BOOST
                )
            hold_reason = "No free transfers and no chip passes the strategic windows/risk gates."
            return self._return_no_chip_action(window_context, available_chips, hold_reason, reason_code="ft_zero_hold")

        elif free_transfers >= 3:
            multi_decision = self._analyze_multi_transfer_optimization(team_data, fixture_data, current_gw, free_transfers, available_chips)
            if critical_transfer_needs > 0:
                return _finalize(multi_decision, ChipType.NONE)
            if free_transfers >= 4:
                return _finalize(multi_decision, ChipType.NONE)
            if tc_allowed:
                return _finalize(
                    self._analyze_triple_captain_decision(team_data, fixture_data, current_gw, primary_target=tc_target),
                    ChipType.TRIPLE_CAPTAIN
                )
            if bench_strength >= 15 and ChipType.BENCH_BOOST in available_chips:
                return _finalize(
                    self._analyze_bench_boost_decision(team_data, fixture_data, current_gw),
                    ChipType.BENCH_BOOST
                )
            return _finalize(multi_decision, ChipType.NONE)

        elif critical_transfer_needs > free_transfers:
            if self._should_use_free_hit(team_data, fixture_data, current_gw, critical_transfer_needs, free_transfers, available_chips):
                return _finalize(
                    self._analyze_free_hit_decision(team_data, fixture_data, current_gw, critical_transfer_needs, free_transfers),
                    ChipType.FREE_HIT
                )
            if ChipType.WILDCARD in available_chips:
                return _finalize(
                    self._analyze_wildcard_decision(team_data, fixture_data, current_gw, critical_transfer_needs),
                    ChipType.WILDCARD
                )
            return _finalize(
                self._analyze_difficult_transfer_situation(team_data, fixture_data, current_gw, free_transfers),
                ChipType.NONE
            )

        elif bench_strength >= 12 and ChipType.BENCH_BOOST in available_chips:
            critical_flagged = [p for p in flagged_players if p.get('is_starter') and p.get('status_flag') == 'OUT']
            if len(critical_flagged) <= 1:
                if tc_allowed:
                    return _finalize(
                        self._compare_bb_vs_tc_decision(team_data, fixture_data, current_gw, bench_strength),
                        ChipType.TRIPLE_CAPTAIN
                    )
                return _finalize(
                    self._analyze_bench_boost_decision(team_data, fixture_data, current_gw),
                    ChipType.BENCH_BOOST
                )

        if self._has_strong_captain_candidate(squad, fixture_data) and ChipType.TRIPLE_CAPTAIN in available_chips and tc_allowed:
            return _finalize(
                self._analyze_triple_captain_decision(team_data, fixture_data, current_gw, primary_target=tc_target),
                ChipType.TRIPLE_CAPTAIN
            )

        if available_chips:
            wait_reason = "Available chips still favor a later window once risk gates are satisfied."
            return self._return_no_chip_action(window_context, available_chips, wait_reason, reason_code="chips_wait")

        return _finalize(
            self._analyze_no_chip_decision(team_data, fixture_data, current_gw, free_transfers, critical_transfer_needs),
            ChipType.NONE
        )

    def _should_use_free_hit(self, team_data: Dict, fixture_data: Dict, current_gw: int,
                             critical_needs: int, free_transfers: int, available_chips: List[ChipType]) -> bool:
        """Determine if Free Hit is defensible based on needs and upcoming windows."""
        if ChipType.FREE_HIT not in available_chips:
            return False
        if critical_needs >= 3:
            return True
        if free_transfers == 0 and self._has_upcoming_special_window(team_data, fixture_data, current_gw):
            return True
        return False

    def _has_upcoming_special_window(self, team_data: Dict, fixture_data: Dict, current_gw: int, lookahead: int = 3) -> bool:
        """Check whether a blank/DGW window exists within the next few GWs."""
        team_id = team_data.get('team_info', {}).get('team_id')
        if not team_id:
            return False
        fixtures = fixture_data.get('fixtures', [])
        target_range = range(current_gw, current_gw + lookahead + 1)
        for fixture in fixtures:
            event = fixture.get('event')
            if event is None or event not in target_range:
                continue
            if fixture.get('team_h') != team_id and fixture.get('team_a') != team_id:
                continue
            if fixture.get('is_blank') or fixture.get('is_dgw_leg') or fixture.get('dgw_count') or fixture.get('is_double'):
                return True
        return False

    def _choose_best_chip_option(self, optimized_xi: OptimizedXI, bench_strength: float, available_chips: List[ChipType]) -> Optional[ChipType]:
        """Compare simple expected gains for TC vs BB vs no chip; return best chip or None."""
        gains = {}
        if ChipType.TRIPLE_CAPTAIN in available_chips:
            best_captain = optimized_xi.get_captain_options()[0]
            gains[ChipType.TRIPLE_CAPTAIN] = max(0, best_captain.nextGW_pts)
        if ChipType.BENCH_BOOST in available_chips:
            gains[ChipType.BENCH_BOOST] = max(0, bench_strength)
        gains[ChipType.NONE] = 0
        best_chip = max(gains, key=gains.get)
        if gains[best_chip] <= 0:
            return None
        # If TC and bench boost are close, prefer TC only if clearly higher
        if ChipType.TRIPLE_CAPTAIN in gains and ChipType.BENCH_BOOST in gains:
            if abs(gains[ChipType.TRIPLE_CAPTAIN] - gains[ChipType.BENCH_BOOST]) < 1.5:
                return None
        return best_chip
    
    def _analyze_bench_boost_decision(self, team_data: Dict, fixture_data: Dict, 
                                    current_gw: int) -> DecisionOutput:
        """Bench Boost specific analysis with risk scenarios"""
        
        # Extract squad data
        squad = team_data.get('current_squad', [])
        bench_players = [p for p in squad if not p.get('is_starter', True)]
        
        # Calculate risk scenarios
        risk_scenarios = []
        
        # Analyze each bench player for minutes risk
        for player in bench_players:
            if self._is_high_minutes_risk(player):
                risk_scenarios.append(RiskScenario(
                    condition=f"If {player['name']} doesn't start",
                    expected_loss_range=(2, 4),
                    risk_level=RiskLevel.ACCEPTABLE,
                    probability_estimate=0.3,
                    mitigation_action="Consider transfer if multiple bench risks"
                ))
        
        # Check for critical risks (expensive bench players with high rotation risk)
        expensive_bench = [p for p in bench_players if p.get('current_price', 0) > 8.0]
        for player in expensive_bench:
            if self._is_rotation_risk(player):
                risk_scenarios.append(RiskScenario(
                    condition=f"If {player['name']} is rotated",
                    expected_loss_range=(8, 12),
                    risk_level=RiskLevel.UNACCEPTABLE,
                    probability_estimate=0.25,
                    mitigation_action=f"Transfer {player['name']} before BB"
                ))
        
        # Determine decision
        unacceptable_risks = [r for r in risk_scenarios if r.risk_level == RiskLevel.UNACCEPTABLE]
        
        if unacceptable_risks:
            decision = "Transfer first, BB next GW"
            reasoning = f"Unacceptable rotation risk detected. Expected loss: {unacceptable_risks[0].expected_loss_range[1]} points."
            tilt_armor = 6  # Even if BB underperforms by 6pts, avoiding the rotation risk was correct
        else:
            decision = "Activate Bench Boost"
            reasoning = "Acceptable risk profile. Focus on captaincy selection only."
            tilt_armor = 8  # BB can underperform expectation by 8pts and still be right call
        
        # Forward-looking TC setup
        next_gw_prep = {
            "tc_target_gw": current_gw + 2,
            "tc_fixture_watch": ["City rotation news", "Haaland minutes cap"],
            "tc_pivot_conditions": [
                "Confirmed Haaland minutes restriction",
                "Saka penalty duties + home fixture mismatch", 
                "City rotation escalation"
            ]
        }
        
        return DecisionOutput(
            primary_decision=decision,
            reasoning=reasoning,
            risk_scenarios=risk_scenarios,
            risk_posture=self.risk_posture,
            tilt_armor_threshold=tilt_armor,
            chip_guidance=ChipDecisionContext(
                current_gw=current_gw,
                chip_type=ChipType.BENCH_BOOST,
                available_chips=[ChipType.BENCH_BOOST, ChipType.TRIPLE_CAPTAIN],
                next_optimal_window=current_gw + 2
            ),
            lineup_focus="captaincy_only" if "BB" in decision else "full_optimization",
            next_gw_prep=next_gw_prep,
            variance_expectations=self._generate_variance_expectations(risk_scenarios, "bench_boost")
        )
    
    def _analyze_triple_captain_decision(self, team_data: Dict, fixture_data: Dict, 
                                       current_gw: int, primary_target: Optional[Dict] = None) -> DecisionOutput:
        """Triple Captain analysis with pivot conditions"""
        
        # Identify TC targets
        squad = team_data.get('current_squad', [])
        premium_attackers = [p for p in squad if p.get('current_price', 0) > 11.0 
                           and p.get('position') in ['MID', 'FWD']]
        
        risk_scenarios = []
        if not primary_target:
            primary_target = self._identify_tc_target(premium_attackers, fixture_data)
        
        if not primary_target:
            return DecisionOutput(
                primary_decision="NO_CHIP_ACTION",
                reasoning="Triple Captain target unknown; hold chips until clarity.",
                risk_scenarios=[],
                risk_posture=self.risk_posture,
                tilt_armor_threshold=0,
                chip_guidance=None,
                lineup_focus="full_optimization",
                decision_status="HOLD",
                confidence_score=0.5,
                block_reason="tc_target_missing"
            )
        
        decision = f"Activate Triple Captain on {primary_target['name']}"
        reasoning = "Minutes and activity profile meet the strong TC gate."
        tilt_armor = 12
        
        return DecisionOutput(
            primary_decision=decision,
            reasoning=reasoning,
            risk_scenarios=risk_scenarios,
            risk_posture=self.risk_posture,
            tilt_armor_threshold=tilt_armor,
            chip_guidance=ChipDecisionContext(
                current_gw=current_gw,
                chip_type=ChipType.TRIPLE_CAPTAIN,
                available_chips=[ChipType.TRIPLE_CAPTAIN],
                pivot_conditions=[
                    "Minutes confidence locked in",
                    "Manager context allows risk",
                    "Window rank is highest"
                ]
            ),
            lineup_focus="full_optimization",
            variance_expectations=self._generate_variance_expectations(risk_scenarios, "triple_captain")
        )
    
    def _analyze_no_chip_decision(self, team_data: Dict, fixture_data: Dict, 
                                current_gw: int, free_transfers: int = 1, critical_needs: int = 0) -> DecisionOutput:
        """Regular gameweek analysis when no chips are active"""
        
        if critical_needs > 0:
            decision = f"No chip - focus on {critical_needs} urgent transfer(s)"
            reasoning = f"With {free_transfers} transfer(s) available, prioritize fixing critical issues."
        else:
            decision = "No chip - optimize transfers and captaincy"
            reasoning = "Focus on strategic improvements and captain selection."
        
        return DecisionOutput(
            primary_decision=decision,
            reasoning=reasoning,
            risk_scenarios=[],
            tilt_armor_threshold=0,
            lineup_focus="full_optimization"
        )
    
    def _get_available_chips(self, chip_status: Dict) -> List[ChipType]:
        """Extract available chips from team data"""
        available = []
        
        chip_mapping = {
            'Bench Boost': ChipType.BENCH_BOOST,
            'Triple Captain': ChipType.TRIPLE_CAPTAIN,
            'Free Hit': ChipType.FREE_HIT,
            'Wildcard': ChipType.WILDCARD
        }
        
        for chip_name, chip_type in chip_mapping.items():
            if chip_status.get(chip_name, {}).get('available', False):
                available.append(chip_type)
        
        return available

    @staticmethod
    def chip_expires_before_next_deadline(chip_name: str, now_gw: int, chip_policy: Dict) -> bool:
        """Return True if the chip expires before the next deadline based on policy."""
        if not chip_policy:
            return False
        # Prefer chip_windows if present
        chip_windows = chip_policy.get("chip_windows")
        if chip_windows:
            for window in chip_windows:
                start_ev = window.get("start_event")
                end_ev = window.get("end_event")
                if start_ev is None or end_ev is None:
                    continue
                if start_ev <= now_gw <= end_ev:
                    return now_gw == end_ev
        expiration = chip_policy.get("expiration", {})
        expire_gw = expiration.get("chips_expire_after_gw")
        expiry_type = expiration.get("type") or "gw_deadline"
        if expiry_type == "gw_deadline" and expire_gw is not None:
            return now_gw == expire_gw
        return False
    
    def _is_high_minutes_risk(self, player: Dict) -> bool:
        """Determine if player has high minutes risk"""
        # Simple heuristic - can be enhanced with more data
        return (player.get('current_price', 0) > 6.0 and 
                player.get('team') in ['CHE', 'MUN', 'TOT'])  # High rotation teams
    
    def _is_rotation_risk(self, player: Dict) -> bool:
        """Determine if expensive player has rotation risk"""
        return (player.get('current_price', 0) > 8.0 and 
                player.get('position') in ['MID', 'FWD'])
    
    def _assess_critical_transfer_needs(self, squad: List[Dict]) -> int:
        """Count players that critically need transferring out"""
        critical_count = 0
        for player in squad:
            if not player.get('is_starter'):
                continue  # Only check starters
            
            status_flag = player.get('status_flag', 'FIT')
            price = player.get('current_price', 0)
            news = player.get('news', '')
            chance_this_round = player.get('chance_of_playing_this_round')
            chance_next_round = player.get('chance_of_playing_next_round')
            
            # Critical status flags - definite transfers needed
            if status_flag == 'OUT':
                critical_count += 1
            elif status_flag == 'DOUBT':
                # Expensive doubts are critical, cheap ones may be tolerable
                if price > 8.0:
                    critical_count += 1
                elif chance_next_round is not None and chance_next_round == 0:
                    # 0% chance next round is critical regardless of price
                    critical_count += 1
                else:
                    critical_count += 0.5  # Moderate priority
            
            # Additional analysis for players with news but no clear status
            elif news and 'injury' in news.lower():
                # News mentions injury but status isn't OUT/DOUBT
                if price > 10.0:  # Expensive player with injury news
                    critical_count += 0.5
                    
            # Check for long-term unavailability based on chance of playing
            elif chance_this_round == 0 and chance_next_round == 0:
                # 0% chance for both rounds indicates serious issue
                critical_count += 1
            elif chance_next_round == 0 and price > 8.0:
                # No chance next round for expensive player
                critical_count += 0.5
                
            # Performance-based assessment (fallback when no status info)
            elif status_flag == 'FIT' and not news:
                total_points = player.get('total_points', 0)
                # Very expensive underperformers might need replacing
                if price > 10.0 and total_points < (price * 8):  # Rule of thumb: 8pts per £1m
                    critical_count += 0.5  # Half weight since no injury flag
                    
        return int(critical_count)
    
    def _assess_bench_strength(self, bench_players: List[Dict], projections: CanonicalProjectionSet) -> float:
        """Assess bench strength for BB potential using canonical projections"""
        total_expected = 0
        for player in bench_players:
            player_proj = projections.get_by_id(player.get('id', 0))
            if player_proj:
                # Use canonical projection for expected points
                total_expected += max(0, player_proj.nextGW_pts)
            else:
                # Fallback for missing projections (should be rare with proper validation)
                total_expected += 2  # Conservative estimate for bench player
                
        return total_expected
    
    def _has_strong_captain_candidate(self, squad: List[Dict], fixture_data: Dict) -> bool:
        """Check if there's a strong TC candidate available"""
        premium_players = [p for p in squad if p.get('current_price', 0) > 11.0 
                          and p.get('is_starter', False) and p.get('status_flag') not in ['OUT', 'DOUBT']]
        return len(premium_players) > 0
    
    def _analyze_free_hit_decision(self, team_data: Dict, fixture_data: Dict, 
                                 current_gw: int, critical_needs: int, free_transfers: int) -> DecisionOutput:
        """Analyze Free Hit chip decision"""
        decision = f"Activate Free Hit - {critical_needs} critical issues to fix"
        reasoning = f"Team has {critical_needs} critical problems but limited transfers. FH provides optimal solution."
        
        risk_scenarios = [
            RiskScenario(
                condition="If FH team construction is poor",
                expected_loss_range=(10, 20),
                risk_level=RiskLevel.ACCEPTABLE,
                probability_estimate=0.2,
                mitigation_action="Research optimal FH template carefully"
            )
        ]
        
        return DecisionOutput(
            primary_decision=decision,
            reasoning=reasoning,
            risk_scenarios=risk_scenarios,
            tilt_armor_threshold=15,
            chip_guidance=ChipDecisionContext(
                current_gw=current_gw,
                chip_type=ChipType.FREE_HIT,
                available_chips=[ChipType.FREE_HIT],
                pivot_conditions=[
                    f"{critical_needs} critical issues vs {free_transfers} transfer(s)",
                    "Insufficient transfer currency to fix all flagged starters"
                ],
                reason_codes=["critical_needs_high", "free_transfers_exhausted"],
                next_optimal_window=current_gw,
                selected_chip=ChipType.FREE_HIT
            ),
            lineup_focus="complete_overhaul"
        )
    
    def _analyze_wildcard_decision(self, team_data: Dict, fixture_data: Dict, 
                                 current_gw: int, critical_needs: int) -> DecisionOutput:
        """Analyze Wildcard chip decision"""
        decision = f"Activate Wildcard - {critical_needs} critical issues plus structure reset"
        reasoning = "Team needs major surgery. WC allows unlimited transfers to fix all issues."
        
        return DecisionOutput(
            primary_decision=decision,
            reasoning=reasoning,
            risk_scenarios=[],
            tilt_armor_threshold=20,
            chip_guidance=ChipDecisionContext(
                current_gw=current_gw,
                chip_type=ChipType.WILDCARD,
                available_chips=[ChipType.WILDCARD],
                next_optimal_window=None  # WC is consumed
            ),
            lineup_focus="complete_rebuild"
        )
    
    def _analyze_difficult_transfer_situation(self, team_data: Dict, fixture_data: Dict, 
                                            current_gw: int, free_transfers: int) -> DecisionOutput:
        """Handle situations with more problems than transfers and no good chip options"""
        squad = team_data.get('current_squad', [])
        critical_needs = self._assess_critical_transfer_needs(squad)
        
        decision = f"Difficult GW - {critical_needs} issues, {free_transfers} transfer(s) available"
        reasoning = "Must prioritize most critical fixes. Consider taking -4 hit or planning multi-GW solution."
        
        risk_scenarios = [
            RiskScenario(
                condition="If unfixed problems persist",
                expected_loss_range=(4, 12),
                risk_level=RiskLevel.UNACCEPTABLE if critical_needs - free_transfers > 1 else RiskLevel.ACCEPTABLE,
                probability_estimate=0.7,
                mitigation_action="Consider -4 hit for second most critical fix"
            )
        ]
        
        return DecisionOutput(
            primary_decision=decision,
            reasoning=reasoning,
            risk_scenarios=risk_scenarios,
            tilt_armor_threshold=8,
            lineup_focus="damage_limitation"
        )
    
    def _analyze_multi_transfer_optimization(self, team_data: Dict, fixture_data: Dict, 
                                           current_gw: int, free_transfers: int, available_chips: List[ChipType]) -> DecisionOutput:
        """Handle scenarios with multiple free transfers available"""
        squad = team_data.get('current_squad', [])
        
        decision = f"Optimize team structure - {free_transfers} free transfers available"
        reasoning = "Multiple transfers provide excellent opportunity for strategic upgrades and team improvement."
        
        # Suggest holding off on chips to focus on transfers
        risk_scenarios = [
            RiskScenario(
                condition="If transfers are used sub-optimally",
                expected_loss_range=(5, 15),
                risk_level=RiskLevel.ACCEPTABLE,
                probability_estimate=0.3,
                mitigation_action="Research form players and plan upgrade pathway carefully"
            )
        ]
        
        # Determine if any chips make sense with multiple transfers
        chip_type = ChipType.NONE
        chip_guidance = None
        
        if self._has_strong_captain_candidate(squad, fixture_data) and ChipType.TRIPLE_CAPTAIN in available_chips:
            chip_type = ChipType.TRIPLE_CAPTAIN
            decision = "Optimize team structure + consider Triple Captain"
            reasoning += " Strong captain option available makes TC attractive alongside transfers."
            
        chip_guidance = ChipDecisionContext(
            current_gw=current_gw,
            chip_type=chip_type,
            available_chips=available_chips,
            next_optimal_window=current_gw + 1 if chip_type == ChipType.NONE else None
        )
        
        return DecisionOutput(
            primary_decision=decision,
            reasoning=reasoning,
            risk_scenarios=risk_scenarios,
            tilt_armor_threshold=10,
            chip_guidance=chip_guidance,
            lineup_focus="transfer_optimization"
        )
    
    def _identify_tc_target(self, premium_players: List[Dict], fixture_data: Dict, 
                          projections: 'CanonicalProjectionSet' = None,
                          manager_context: Dict = None) -> Optional[Dict]:
        """Identify TC target using risk-aware selection based on manager posture
        
        Args:
            premium_players: List of player dicts from current_squad
            fixture_data: Fixture information
            projections: CanonicalProjectionSet to get expected points
            manager_context: Manager context with risk_posture (CHASE/BALANCED/DEFEND)
            
        Returns:
            Player dict optimized for manager's situation
        """
        import logging
        logger = logging.getLogger(__name__)
        
        if not premium_players:
            return None
        
        # Filter to available players only
        available_premiums = [
            p for p in premium_players 
            if p.get('status_flag') not in ['OUT', 'DOUBT']
        ]
        
        if not available_premiums:
            available_premiums = premium_players
        
        # CRITICAL: Projections are required for TC decisions
        if not projections or not hasattr(projections, 'get_by_id'):
            logger.warning("⚠️ TC Target Selection: No projections available - cannot make informed TC decision")
            return None
        
        # Use orchestrator's risk_posture (authoritative source)
        risk_posture = self.risk_posture
        logger.info(f"🎯 TC Target Selection (Risk Mode: {risk_posture})")
        logger.info(f"🔍 Candidates: {[p.get('name') for p in available_premiums]}")
        
        # Build candidate list with projection data
        candidates = []
        for player in available_premiums:
            player_id = player.get('player_id') or player.get('id')
            if not player_id:
                logger.info(f"  ⚠️  Player {player.get('name')} has no player_id or id field")
                continue
                
            proj = projections.get_by_id(player_id)
            if not proj:
                logger.info(f"  ⚠️  No projection found for {player.get('name')} (ID: {player_id})")
                continue
            
            # Calculate risk-adjusted score based on posture
            # Canonical values: AGGRESSIVE, BALANCED, CONSERVATIVE
            if risk_posture == 'AGGRESSIVE':
                # AGGRESSIVE: Favor ceiling over floor, prefer differentials
                score = (
                    proj.ceiling * 0.6 +           # High ceiling matters most
                    proj.nextGW_pts * 0.3 +        # Expected points matter
                    (100 - proj.ownership_pct) * 0.1  # Differential bonus
                )
                metric = f"ceiling={proj.ceiling:.1f}, diff={100-proj.ownership_pct:.0f}%"
            elif risk_posture == 'CONSERVATIVE':
                # CONSERVATIVE: Favor floor over ceiling, template picks OK
                score = (
                    proj.floor * 0.4 +             # High floor prevents disasters
                    proj.nextGW_pts * 0.5 +        # Expected points primary
                    proj.ownership_pct * 0.1       # Template pick bonus
                )
                metric = f"floor={proj.floor:.1f}, template={proj.ownership_pct:.0f}%"
            else:  # BALANCED
                # BALANCED: Pure expected points
                score = proj.nextGW_pts
                metric = f"expected={proj.nextGW_pts:.1f}"
            
            candidates.append({
                'player': player,
                'proj': proj,
                'score': score,
                'metric': metric
            })
            
            logger.info(f"  • {player.get('name')}: {metric}, score={score:.1f}")
        
        if not candidates:
            logger.warning("⚠️ No candidates with projections found")
            return None
        
        # Select best based on risk-adjusted score
        best = max(candidates, key=lambda c: c['score'])
        logger.info(f"✅ TC Target ({risk_posture}): {best['player'].get('name')} - {best['metric']}")
        
        return best['player']

    def _recommend_captaincy(self, team_data: Dict, fixture_data: Dict, 
                           projections: CanonicalProjectionSet = None) -> Dict:
        """Recommend captain/vice based on available starters with highest total points"""
        squad = team_data.get('current_squad', [])
        # Only consider starters who are fit and available
        available_starters = [
            p for p in squad 
            if p.get('is_starter') and p.get('status_flag') not in ['OUT', 'DOUBT']
        ]
        
        if not available_starters:
            # If no available starters, fall back to all starters but mark as risky
            available_starters = [p for p in squad if p.get('is_starter')]
            if not available_starters:
                return {}
        
        starters_sorted = sorted(
            available_starters, 
            key=lambda p: (p.get('total_points', 0), p.get('current_price', 0)), 
            reverse=True
        )
        captain = starters_sorted[0]
        vice = starters_sorted[1] if len(starters_sorted) > 1 else None
        
        def _get_ownership_warning(player):
            """Generate ownership warning - note: true EO requires captaincy data not in API"""
            ownership = float(player.get('ownership', 0))
            if ownership > 75:
                return " ⚠️ Very high ownership - limited differential potential"
            elif ownership > 50:
                return " 📊 High ownership - consider differential risk"
            return ""

        recommendation = {
            "captain": {
                "name": captain.get('name'),
                "team": captain.get('team'),
                "position": captain.get('position'),
                "ownership_pct": float(captain.get('ownership', 0)),
                "rationale": "Highest total points among available starters; steady minutes profile" + _get_ownership_warning(captain)
            }
        }
        if vice:
            recommendation["vice_captain"] = {
                "name": vice.get('name'),
                "team": vice.get('team'),
                "position": vice.get('position'),
                "ownership_pct": float(vice.get('ownership', 0)),
                "rationale": "Second-best form/points among available players; injury insurance" + _get_ownership_warning(vice)
            }
            
        return recommendation

    def _find_replacement_players(self, position: str, max_price: float, all_players: List[Dict], avoid_teams: List[str] = None) -> List[Dict]:
        """Find replacement players for transfers"""
        if not all_players:
            return []
        
        avoid_teams = avoid_teams or []
        candidates = []
        
        for player in all_players:
            if player.get('position') != position:
                continue
                
            price = player.get('current_price', 0)
            if price > max_price:
                continue
                
            if player.get('team') in avoid_teams:
                continue
                
            # Filter out players with very low points (likely injured/new signings/etc)
            total_points = player.get('total_points', 0)
            
            # Only suggest players with reasonable points tally
            min_points_threshold = max(20, price * 6)  # At least 6 points per £1m
            if total_points < min_points_threshold:
                continue
                
            points_per_million = total_points / price if price > 0 else 0
            
            candidates.append({
                'name': player.get('name'),
                'team': player.get('team'),
                'position': position,
                'price': price,
                'total_points': total_points,
                'points_per_million': points_per_million,
                'form_score': total_points  # Simplified form metric
            })
        
        # Sort by points per million (value) and total points
        return sorted(candidates, key=lambda x: (x['points_per_million'], x['total_points']), reverse=True)[:3]

    def _compare_bb_vs_tc_decision(self, team_data: Dict, fixture_data: Dict, current_gw: int, bench_strength: float) -> DecisionOutput:
        """Compare Bench Boost vs Triple Captain and recommend the better option"""
        squad = team_data.get('current_squad', [])
        starters = [p for p in squad if p.get('is_starter')]
        bench = [p for p in squad if not p.get('is_starter')]
        
        # Calculate expected values
        bb_expected = bench_strength  # Already calculated
        
        # TC expected - find best captain candidate
        best_captain = None
        tc_expected = 0
        for player in starters:
            if player.get('status_flag') != 'OUT':
                total_points = player.get('total_points', 0)
                # Rough expected points this GW (season avg / games played)
                gw_expected = max(4, total_points / max(1, current_gw - 1)) 
                if gw_expected > tc_expected:
                    tc_expected = gw_expected
                    best_captain = player
        
        # TC gives double the captain's score, so multiply by 2
        tc_expected = tc_expected * 2
        
        # Decision logic
        if bb_expected >= tc_expected + 2:  # BB has 2+ point advantage
            decision = "Activate Bench Boost - Strong bench depth"
            reasoning = f"BB expected: ~{bb_expected:.0f}pts vs TC expected: ~{tc_expected:.0f}pts"
            return self._analyze_bench_boost_decision(team_data, fixture_data, current_gw)
        else:
            decision = f"Activate Triple Captain on {best_captain['name'] if best_captain else 'premium player'}"
            reasoning = f"TC expected: ~{tc_expected:.0f}pts vs BB expected: ~{bb_expected:.0f}pts"
            return self._analyze_triple_captain_decision(team_data, fixture_data, current_gw)

    def _build_chip_window_context(self, team_data: Dict, fixture_data: Dict, current_gw: int) -> Dict[str, Any]:
        chip_policy = team_data.get('chip_policy') or {}
        chip_windows = chip_policy.get('chip_windows') or []
        fixtures = fixture_data.get('fixtures', []) or []
        team_id = None
        try:
            team_id = int(team_data.get('team_info', {}).get('team_id'))
        except (TypeError, ValueError):
            team_id = None

        window_scores = []
        for window in sorted(chip_windows or [], key=lambda w: w.get('start_event', 0)):
            start_event = window.get('start_event') or 0
            end_event = window.get('end_event') or start_event
            score = self._score_window_for_team(fixtures, team_id, start_event, end_event, current_gw)
            is_current = start_event <= current_gw <= end_event if start_event and end_event else start_event <= current_gw
            window_scores.append({
                "name": window.get("name", f"window_{start_event}"),
                "start_event": start_event,
                "end_event": end_event,
                "score": score,
                "is_current": is_current,
                "chips": window.get("chips", [])
            })

        if not window_scores:
            window_scores = [{
                "name": "season",
                "start_event": current_gw,
                "end_event": current_gw,
                "score": 0,
                "is_current": True,
                "chips": []
            }]

        current_window = next((w for w in window_scores if w["is_current"]), window_scores[0])
        sorted_windows = sorted(window_scores, key=lambda w: w["score"], reverse=True)
        window_rank = 1 + sum(1 for w in sorted_windows if w["score"] > current_window["score"])
        future_windows = [w for w in window_scores if w["start_event"] > current_window["end_event"]]
        best_future = max(future_windows, key=lambda w: w["score"], default=current_window)

        return {
            "current_window_score": current_window["score"],
            "best_future_window_score": best_future["score"],
            "window_rank": window_rank,
            "current_window_name": current_window["name"],
            "best_future_window_name": best_future["name"],
            "current_gw": current_gw
        }

    def _score_window_for_team(self, fixtures: List[Dict], team_id: Optional[int],
                               start_event: int, end_event: int, current_gw: int) -> float:
        score = 0
        window_start = max(start_event, current_gw)
        if team_id is None:
            return 0.0
        for fixture in fixtures:
            event = fixture.get("event") or fixture.get("gw")
            if event is None or event < window_start or event > end_event:
                continue
            if team_id is not None:
                if fixture.get("team_h") != team_id and fixture.get("team_a") != team_id:
                    continue
            score += 1
        return float(score)

    def _return_no_chip_action(self, window_context: Dict[str, Any], available_chips: List[ChipType],
                               reason: str, reason_code: str = None) -> DecisionOutput:
        if reason_code:
            codes = window_context.setdefault('reason_codes', [])
            if reason_code not in codes:
                codes.append(reason_code)
        decision = self._build_no_chip_action_decision(window_context, available_chips, reason)
        return self._finalize_decision(decision, ChipType.NONE, available_chips)

    def _build_no_chip_action_decision(self, window_context: Dict[str, Any],
                                       available_chips: List[ChipType], reason: str) -> DecisionOutput:
        guidance = ChipDecisionContext(
            current_gw=window_context.get('current_gw', 0),
            chip_type=ChipType.NONE,
            available_chips=available_chips,
        )
        return DecisionOutput(
            primary_decision="NO_CHIP_ACTION",
            reasoning=reason,
            risk_scenarios=[],
            risk_posture=self.risk_posture,
            tilt_armor_threshold=0,
            chip_guidance=guidance,
            lineup_focus="full_optimization",
            decision_status="PASS",
            confidence_score=0.75
        )

    def _finalize_decision(self, decision_output: DecisionOutput, chip_type: ChipType,
                           available_chips: List[ChipType]) -> DecisionOutput:
        """Delegate to OutputFormatter for decision finalization."""
        return self._output_formatter._finalize_decision(decision_output, chip_type, available_chips)

    def _apply_window_context(self, decision_output: DecisionOutput, chip_type: ChipType,
                              available_chips: List[ChipType]):
        """Delegate to OutputFormatter."""
        return self._output_formatter._apply_window_context(
            decision_output, chip_type, available_chips, self._window_context or {}
        )

    def _can_activate_triple_captain(self, team_data: Dict, fixture_data: Dict, window_context: Dict[str, Any],
                                     available_chips: List[ChipType], 
                                     projections: 'CanonicalProjectionSet' = None) -> Tuple[bool, List[str], Optional[Dict]]:
        if ChipType.TRIPLE_CAPTAIN not in available_chips:
            return False, ["tc_unavailable"], None

        squad = team_data.get('current_squad', [])
        # Consider all MID/FWD for TC (let projections determine best, not price)
        premium_attackers = [p for p in squad if p.get('position') in ['MID', 'FWD']]
        
        # Pass manager context for risk-aware TC selection
        manager_context = team_data.get('manager_context', {})
        # Ensure manager_context is a dict (it might be a string from config)
        if not isinstance(manager_context, dict):
            manager_context = {}
        primary_target = self._identify_tc_target(premium_attackers, fixture_data, projections, manager_context)

        if not primary_target:
            return False, ["tc_target_missing"], None
        if team_data.get('force_tc_override'):
            return True, ["tc_force_override"], primary_target
        
        # Ensure window_context is a dict before using .get()
        if not isinstance(window_context, dict):
            window_context = {}
        
        if window_context.get('window_rank', 1) > 1:
            return False, ["tc_window_rank"], primary_target
        # REMOVED: _manager_context_allows_tc() gate
        # Risk posture already influences TC target selection (WHO to TC)
        # TC should be available for all risk postures
        minutes_confidence = self._minutes_confidence_for_player(primary_target)
        threshold = self._minutes_threshold_from_preferences(team_data)
        if minutes_confidence < threshold:
            return False, ["tc_minutes_low"], primary_target
        if self._player_has_rotation_risk(primary_target):
            return False, ["tc_rotation_risk"], primary_target
        return True, [], primary_target

    def _manager_context_allows_tc(self, team_data: Dict) -> bool:
        context = team_data.get('manager_context') or ""
        context_value = str(context).strip().upper()
        allowed_contexts = {"CHASE", "AGGRESSIVE", "RISK_ON", "FORCE_CHIP", "TC_COMMITMENT"}
        if context_value in allowed_contexts:
            return True
        prefs = team_data.get('analysis_preferences', {}) or {}
        if prefs.get('tc_force_override') or prefs.get('allow_high_risk_chips'):
            return True
        return False

    def _minutes_confidence_for_player(self, player: Dict) -> float:
        chance = player.get('chance_of_playing_next_round')
        if isinstance(chance, (int, float)):
            return float(chance)
        status = player.get('status_flag', 'FIT')
        if status == 'FIT':
            return 95.0
        if status == 'DOUBT':
            return 50.0
        return 75.0

    def _minutes_threshold_from_preferences(self, team_data: Dict) -> float:
        prefs = team_data.get('analysis_preferences', {}) or {}
        threshold = prefs.get('tc_minutes_threshold')
        try:
            value = float(threshold)
        except (TypeError, ValueError):
            value = 85.0
        return max(0.0, min(100.0, value))

    def _player_has_rotation_risk(self, player: Dict) -> bool:
        status = player.get('status_flag', '').upper()
        if status in {'OUT', 'DOUBT'}:
            return True
        news = (player.get('news') or "").lower()
        rotation_flags = ["rotation", "rest", "minutes", "bench", "unused", "squad"]
        return any(flag in news for flag in rotation_flags)

    def _align_confidence_with_risk(self, decision_output: DecisionOutput):
        """Delegate to OutputFormatter."""
        return self._output_formatter._align_confidence_with_risk(decision_output)

    def _assess_bench_weakness(self, squad: List[Dict], projections: CanonicalProjectionSet) -> List[Dict]:
        """Consolidated bench weakness assessment using canonical projections"""
        bench = [p for p in squad if not p.get('is_starter')]
        weak_bench = []
        
        for p in bench:
            if p.get('status_flag') == 'OUT':
                weak_bench.append(p)
            else:
                # Use canonical projection for bench strength assessment
                player_proj = projections.get_by_id(p.get('player_id') or p.get('id', 0))
                if player_proj and player_proj.nextGW_pts < 3.0:
                    weak_bench.append(p)
                elif not player_proj and p.get('total_points', 0) < 20:
                    # Fallback to total_points only if projection missing
                    weak_bench.append(p)
        
        return weak_bench

    def _create_recommendation(self, action: str, reason: str, profile: str = None, plan: Dict = None) -> Dict:
        """Helper to create standardized recommendation objects"""
        rec = {"action": action, "reason": reason}
        if profile:
            rec["profile"] = profile
        if plan:
            rec["plan"] = plan
        return rec

    def _recommend_transfers(self, team_data: Dict, free_transfers: int = 1, 
                           projections: CanonicalProjectionSet = None) -> List[Dict]:
        """Delegate to TransferAdvisor for transfer recommendations."""
        # Ensure manual transfers are applied before generating recommendations
        if team_data.get('manual_overrides', {}).get('planned_transfers'):
            logger.info("Ensuring manual transfers are applied before recommendations")
            team_data = self._transfer_advisor.apply_manual_transfers(team_data)
        
        return self._transfer_advisor.recommend_transfers(team_data, free_transfers, projections)

    def _get_manager_context_mode(self, team_data: Dict) -> str:
        """
        Resolve manager context mode for plan discipline.
        Uses orchestrator's risk_posture as authoritative source.
        """
        # Use orchestrator's risk_posture (set from config at initialization)
        return self.risk_posture

    def _context_allows_transfer(self, context_mode: str, projected_gain: float, free_transfers: int = 1) -> bool:
        """Determine whether the requested transfer gain satisfies context thresholds.
        
        With multiple free transfers, we should be MORE aggressive as the cost is lower.
        Adjust thresholds based on available free transfers.
        """
        base_thresholds = {
            "CHASE": 1.2,
            "AGGRESSIVE": 1.2,      # LOWERED from 2.0 - more proactive
            "RISK_ON": 0.8,
            "DEFEND": 3.5,
            "FORCE_CHIP": 0.5,
            "TC_COMMITMENT": 0.0,
            "BALANCED": 2.0,        # LOWERED from 2.5
            "DEFAULT": 2.0,
            "CONSERVATIVE": 2.8
        }
        
        base_required = base_thresholds.get(context_mode, base_thresholds["DEFAULT"])
        
        # Apply free transfer multiplier - more FTs = lower threshold
        if free_transfers >= 5:
            ft_multiplier = 0.4  # With 5 FTs, accept 40% of normal threshold
        elif free_transfers >= 4:
            ft_multiplier = 0.5  # With 4 FTs, accept 50% of normal threshold
        elif free_transfers >= 3:
            ft_multiplier = 0.6  # With 3 FTs, accept 60% of normal threshold
        elif free_transfers >= 2:
            ft_multiplier = 0.75 # With 2 FTs, accept 75% of normal threshold
        else:
            ft_multiplier = 1.0  # Normal threshold with 1 FT
        
        required = base_required * ft_multiplier
        logger.info(f"Transfer threshold: {required:.2f} pts (base={base_required:.2f}, FTs={free_transfers}, multiplier={ft_multiplier:.2f})")
        
        return projected_gain >= required

    def _build_transfer_plan(
        self,
        player_out: Dict,
        player_proj,
        best_candidate,
        alternatives: List = None,
        context_mode: str = "BALANCED",
        free_transfers: int = 1,
        bank_value: float = 0.0
    ) -> Dict:
        """Return a lightweight plan object describing the transfer sequence."""
        if not best_candidate:
            return self._build_general_plan(context_mode, bank_value, "No replacement identified.")
        gain = max(0.0, best_candidate.nextGW_pts - (player_proj.nextGW_pts or 0))
        horizon = "LONG" if gain >= 3 else "MEDIUM" if gain >= 1.5 else "SHORT"
        transfers_out = [player_out.get('player_id')] if player_out.get('player_id') else []
        transfers_in = [best_candidate.player_id]
        alternative_names = [alt.name for alt in (alternatives or [])][:2]
        return {
            "transfers_out": transfers_out,
            "transfers_in": transfers_in,
            "projected_gain_horizon": gain,
            "horizon": horizon,
            "budget_after": round(bank_value - (best_candidate.current_price - (player_proj.current_price or 0)), 2),
            "context": context_mode,
            "suggested_alternatives": alternative_names,
            "free_transfers_remaining": free_transfers
        }

    def _build_general_plan(self, context_mode: str, bank_value: float, message: str) -> Dict:
        """Fallback plan when a confident replacement cannot be constructed."""
        return {
            "transfers_out": [],
            "transfers_in": [],
            "projected_gain_horizon": 0.0,
            "horizon": "WAIT",
            "budget_after": round(bank_value, 2),
            "context": context_mode,
            "notes": message
        }

    def _generate_variance_expectations(self, risk_scenarios: List[RiskScenario], decision_type: str = "chip") -> Dict:
        """Generate post-GW variance expectations with realistic downside"""
        
        # Calculate risk scenario losses
        scenario_risk = sum(r.expected_loss_range[1] for r in risk_scenarios 
                           if r.risk_level != RiskLevel.ACCEPTABLE)
        
        # Add base FPL variance (even "perfect" decisions have variance)
        if decision_type == "bench_boost":
            base_variance = (0, 4)  # CS wipes, cameos, VAR decisions
            expected_downside = f"0–{max(4, scenario_risk)} points (variance-acceptable)"
        elif decision_type == "triple_captain":
            base_variance = (0, 6)  # Captain blanks, rotation, VAR
            expected_downside = f"0–{max(6, scenario_risk)} points (variance-acceptable)"
        elif decision_type == "transfer_first":
            base_variance = (0, 3)  # Transfer doesn't work out immediately
            expected_downside = f"0–{max(3, scenario_risk)} points (variance-acceptable)"
        else:
            base_variance = (0, 2)
            expected_downside = f"0–{max(2, scenario_risk)} points (variance-acceptable)"
        
        return {
            "good_process_indicators": [
                "Decision aligned with pre-GW risk assessment",
                "Avoided unacceptable risk scenarios",
                "Capitalized on favorable fixture timing"
            ],
            "bad_luck_vs_bad_process": {
                "bad_luck": f"Points lost ≤ {self.risk_thresholds['acceptable_loss']} AND decision was risk-optimal",
                "gray_zone": f"Points lost {self.risk_thresholds['acceptable_loss']}–{self.risk_thresholds['unacceptable_loss']} (Review, No Panic)",
                "bad_process": f"Points lost ≥ {self.risk_thresholds['unacceptable_loss']} OR ignored clear risk signals"
            },
            "expected_downside_range": expected_downside,
            "process_break_threshold": f"≥ {self.risk_thresholds['unacceptable_loss']} points"
        }
    
    def generate_decision_summary(self, decision_output: DecisionOutput, team_data: Dict = None) -> str:
        """Delegate to OutputFormatter for decision summary generation."""
        return self._output_formatter.generate_decision_summary(decision_output, team_data)


    def _bench_upgrade_candidate_note(self, team_data: Dict) -> str:
        """Generate actual bench upgrade candidates or explain why they cannot be generated."""
        
        # First check if pre-computed candidates are available
        summary_candidates = team_data.get('bench_upgrade_candidates')
        if summary_candidates:
            rendered = []
            for candidate in summary_candidates[:3]:
                name = candidate.get('name') or candidate.get('player') or "Unnamed player"
                price = candidate.get('price') or candidate.get('current_price')
                if isinstance(price, (int, float)):
                    price_label = f"£{price:.1f}m"
                else:
                    price_label = "price unknown"
                fixtures = candidate.get('fixtures') or []
                fixtures_label = ", ".join(fixtures) if fixtures else "fixtures pending"
                rendered.append(f"{name} ({price_label}, {fixtures_label})")
            if rendered:
                return "; ".join(rendered)
        
        # Generate candidates on-demand if data is available
        candidates = self._generate_bench_upgrade_candidates(team_data)
        if candidates:
            return "; ".join(candidates)
        
        # Provide specific explanation of what's missing
        missing_data = []
        if not team_data.get('current_squad'):
            missing_data.append('squad data')
        
        # Check if projections are available in team_data or environment
        projections_available = (
            team_data.get('canonical_projections') or 
            team_data.get('projections') or
            hasattr(self, '_cached_projections')
        )
        if not projections_available:
            missing_data.append('player projections')
            
        # Check for FPL player database - try multiple possible key names
        player_database = (
            team_data.get('bootstrap_elements') or 
            team_data.get('elements') or
            team_data.get('players') or
            team_data.get('all_players')  # Add support for 'all_players' key
        )
        if not player_database:
            missing_data.append('FPL player database')
            
        if missing_data:
            return f"Cannot suggest replacements: {', '.join(missing_data)} not loaded"
        
        return "Cannot suggest replacements: insufficient data for candidate analysis"

    def _generate_bench_upgrade_candidates(self, team_data: Dict) -> List[str]:
        """Generate actual bench upgrade candidates using canonical projections."""
        try:
            squad = team_data.get('current_squad', [])
            
            # Get available projections - try multiple possible locations
            projections = None
            if hasattr(self, '_cached_projections'):
                projections = self._cached_projections
            elif team_data.get('canonical_projections'):
                projections = team_data['canonical_projections']
            elif team_data.get('projections'):
                projections = team_data['projections']
                
            if not projections or not hasattr(projections, 'projections'):
                return []
            
            # Use consolidated bench assessment
            weak_bench = self._assess_bench_weakness(squad, projections)
            
            if not weak_bench:
                return []
                
            # Get player database for names and prices - try multiple key names
            bootstrap = (
                team_data.get('bootstrap_elements') or 
                team_data.get('elements') or 
                team_data.get('players') or
                team_data.get('all_players')  # Add support for 'all_players' key
            )
            if not bootstrap:
                return []
                
            # Create lookup dictionaries
            player_lookup = {p.get('id'): p for p in bootstrap}
            squad_ids = {p.get('player_id') or p.get('element') or p.get('id') for p in squad}
            
            candidates = []
            for weak_player in weak_bench[:2]:  # Focus on worst 2 bench players
                weak_id = weak_player.get('player_id') or weak_player.get('element') or weak_player.get('id')
                weak_position = weak_player.get('position')
                weak_price = weak_player.get('current_price', 4.0)
                
                if not weak_id or not weak_position:
                    continue
                    
                # Find replacement candidates in same position
                position_candidates = []
                for proj in projections.projections:
                    if (proj.player_id not in squad_ids and 
                        proj.position == weak_position and
                        proj.current_price <= weak_price + 1.0 and  # Allow £1m upgrade
                        proj.current_price >= 3.9):  # Minimum viable price
                        
                        player_info = player_lookup.get(proj.player_id)
                        if player_info:
                            # Estimate minutes confidence based on total points
                            total_pts = player_info.get('total_points', 0)
                            mins_conf = min(90, max(60, total_pts * 2)) if total_pts > 0 else 60
                            
                            position_candidates.append({
                                'proj': proj,
                                'player': player_info,
                                'mins_conf': mins_conf,
                                'value_score': proj.nextGW_pts + (proj.next6_pts / 10)  # Combine short and medium term
                            })
                
                # Get best replacement for this weak player
                if position_candidates:
                    best = sorted(position_candidates, key=lambda x: x['value_score'], reverse=True)[0]
                    
                    # Format the candidate suggestion
                    name = f"{best['player'].get('first_name', '')} {best['player'].get('second_name', '')}".strip()
                    if not name:
                        name = best['player'].get('web_name', 'Unknown')
                        
                    team_code = best['player'].get('team_code', 0)
                    team_name = self._get_team_abbreviation(team_code) if team_code else "UNK"
                    
                    price = best['proj'].current_price
                    mins_conf = best['mins_conf']
                    proj_pts = best['proj'].nextGW_pts
                    
                    # Get weak player name for replacement suggestion
                    weak_name = weak_player.get('name', 'Unknown')
                    
                    candidates.append(
                        f"Replace {weak_name} → {name} ({team_name}, £{price:.1f}m, {mins_conf}% mins, {proj_pts:.1f} pts)"
                    )
                    
            return candidates[:3]  # Return top 3 suggestions

        except (KeyError, IndexError, TypeError, AttributeError) as e:
            logger.debug(f"Error generating bench candidates: {e}")
            return []
    
    def _get_team_abbreviation(self, team_code: int) -> str:
        """Convert team code to abbreviation."""
        # Basic team code to abbreviation mapping
        team_map = {
            1: "ARS", 2: "AVL", 3: "BOU", 4: "BRE", 5: "BHA", 6: "BUR", 7: "CHE", 8: "CRY",
            9: "EVE", 10: "FUL", 11: "IPS", 12: "LEI", 13: "LIV", 14: "MCI", 15: "MUN", 16: "NEW",
            17: "NFO", 18: "SOU", 19: "TOT", 20: "WHU", 21: "WOL"
        }
        return team_map.get(team_code, f"T{team_code}")

    def _generate_bb_vs_tc_analysis(self, team_data: Dict) -> str:
        """Generate Bench Boost vs Triple Captain comparison analysis"""
        squad = team_data.get('current_squad', [])
        bench = [p for p in squad if not p.get('is_starter')]
        starters = [p for p in squad if p.get('is_starter')]
        
        analysis = ""
        
        # Bench Boost Analysis
        bench_expected = 0
        bench_players_info = []
        for player in bench:
            total_points = player.get('total_points', 0)
            price = player.get('current_price', 4.0)
            status = "✅" if player.get('status_flag') != 'OUT' else "❌"
            
            # Rough expected points this GW
            if total_points < 20:
                expected = 2
            elif total_points < 40:
                expected = 3
            elif total_points >= 60:
                expected = 5
            else:
                expected = 4
                
            bench_expected += expected
            bench_players_info.append(f"  • {player.get('name')} ({player.get('team')}) - ~{expected}pts {status}")
        
        analysis += "🪑 **BENCH BOOST OPTION:**\n"
        analysis += f"Expected: ~{bench_expected:.0f} points from bench\n"
        analysis += "\n".join(bench_players_info)
        analysis += "\n*Use if: All/most bench players are nailed starters*\n\n"
        
        # Triple Captain Analysis  
        top_captains = []
        for player in starters:
            if player.get('status_flag') != 'OUT':
                total_points = player.get('total_points', 0)
                price = player.get('current_price', 0)
                # Rough expected this GW
                gw_expected = max(4, total_points / 17) if total_points > 0 else 4
                tc_expected = gw_expected * 2  # Double points
                top_captains.append({
                    'name': player.get('name'),
                    'team': player.get('team'),
                    'expected': tc_expected,
                    'total_points': total_points
                })
        
        # Sort by expected and take top 3
        top_captains.sort(key=lambda x: x['expected'], reverse=True)
        best_tc_expected = top_captains[0]['expected'] if top_captains else 0
        
        analysis += "⚡ **TRIPLE CAPTAIN OPTION:**\n"
        analysis += f"Expected: ~{best_tc_expected:.0f} points (double captain score)\n"
        for captain in top_captains[:3]:
            analysis += f"  • {captain['name']} ({captain['team']}) - ~{captain['expected']:.0f}pts\n"
        analysis += "*Use if: You have a nailed premium with high ceiling*\n\n"
        
        # Recommendation logic
        if bench_expected >= best_tc_expected + 2:
            analysis += f"💡 **SUGGESTION:** Bench Boost (+{bench_expected - best_tc_expected:.0f}pt advantage)\n"
        elif best_tc_expected >= bench_expected + 3:
            analysis += f"💡 **SUGGESTION:** Triple Captain (+{best_tc_expected - bench_expected:.0f}pt advantage)\n"
        else:
            analysis += "💡 **SUGGESTION:** Close call - consider fixture difficulty & rotation risk\n"
        
        return analysis

    def _generate_bb_analysis(self, team_data: Dict) -> str:
        """Generate Bench Boost only analysis"""
        squad = team_data.get('current_squad', [])
        bench = [p for p in squad if not p.get('is_starter')]
        
        analysis = "🪑 **BENCH BOOST AVAILABLE:**\n"
        bench_expected = 0
        
        for player in bench:
            total_points = player.get('total_points', 0)
            status = "✅" if player.get('status_flag') != 'OUT' else "❌"
            
            if total_points < 20:
                expected = 2
            elif total_points < 40:
                expected = 3  
            elif total_points >= 60:
                expected = 5
            else:
                expected = 4
                
            bench_expected += expected
            analysis += f"  • {player.get('name')} ({player.get('team')}) - ~{expected}pts {status}\n"
        
        analysis += f"Expected total: ~{bench_expected:.0f} points\n"
        
        if bench_expected >= 12:
            analysis += "💡 **Strong bench - BB recommended**\n"
        elif bench_expected >= 8:
            analysis += "💡 **Decent bench - BB viable**\n"
        else:
            analysis += "💡 **Weak bench - consider saving BB**\n"
        
        return analysis

    def _generate_tc_analysis(self, team_data: Dict) -> str:
        """Generate Triple Captain only analysis"""
        squad = team_data.get('current_squad', [])
        starters = [p for p in squad if p.get('is_starter')]
        
        analysis = "⚡ **TRIPLE CAPTAIN AVAILABLE:**\n"
        
        captain_options = []
        for player in starters:
            if player.get('status_flag') != 'OUT':
                total_points = player.get('total_points', 0)
                gw_expected = max(4, total_points / 17) if total_points > 0 else 4
                tc_expected = gw_expected * 2
                captain_options.append({
                    'name': player.get('name'),
                    'team': player.get('team'),
                    'expected': tc_expected
                })
        
        captain_options.sort(key=lambda x: x['expected'], reverse=True)
        
        for i, captain in enumerate(captain_options[:3]):
            rank = ["🥇", "🥈", "🥉"][i]
            analysis += f"  {rank} {captain['name']} ({captain['team']}) - ~{captain['expected']:.0f}pts\n"
        
        best_expected = captain_options[0]['expected'] if captain_options else 0
        
        if best_expected >= 16:
            analysis += "💡 **High ceiling captain - TC recommended**\n"
        elif best_expected >= 12:
            analysis += "💡 **Decent captain - TC viable**\n"
        else:
            analysis += "💡 **Low ceiling - consider saving TC**\n"
        
        return analysis

    def _validate_squad_composition(self, team_data: Dict) -> List[Dict]:
        """
        Validate FPL squad composition rules:
        - Maximum 3 players from any single team
        - Return list of violations for URGENT transfer action
        """
        violations = []
        
        # Count players by team - check multiple possible data structures
        team_counts = {}
        
        # Try current_squad first (enhanced collector format)
        players = team_data.get('current_squad', [])
        if not players:
            # Fallback to players key (alternative format)
            players = team_data.get('players', [])
        
        for player in players:
            team_name = player.get('team', 'Unknown')
            if team_name not in team_counts:
                team_counts[team_name] = []
            team_counts[team_name].append(player)
        
        # Check for violations (more than 3 players from same team)
        MAX_PLAYERS_PER_TEAM = 3
        for team_name, team_players in team_counts.items():
            if len(team_players) > MAX_PLAYERS_PER_TEAM:
                violations.append({
                    'rule': 'max_players_per_team',
                    'team': team_name,
                    'current_count': len(team_players),
                    'max_allowed': MAX_PLAYERS_PER_TEAM,
                    'excess_count': len(team_players) - MAX_PLAYERS_PER_TEAM,
                    'players': team_players
                })
        
        return violations

    def _get_player_projection_points(self, projections: CanonicalProjectionSet, player_name: str) -> float:
        """Get nextGW_pts for a player by name from projections"""
        for proj in projections.projections:
            if proj.name == player_name:
                return proj.nextGW_pts
        return 0.0

    def _find_replacement_players(self, projections: CanonicalProjectionSet, player_to_replace: Dict, team_data: Dict) -> List[Dict]:
        """Find suitable replacement players for the same position"""
        position = player_to_replace['position']
        # Fix: team_info is direct key, not nested under my_team
        bank = team_data.get('team_info', {}).get('bank', 0.5)
        max_price = player_to_replace['price'] + bank  # Current price + available bank
        
        # Get current squad to avoid recommending players already owned
        current_squad_names = set()
        # Fix: team_data structure has current_squad as direct key, not nested under my_team
        current_squad = team_data.get('current_squad', [])
        for player in current_squad:
            current_squad_names.add(player.get('name', ''))
        
        replacement_candidates = []
        
        # Filter projections for same position, affordable, not owned, and not injured
        for proj in projections.projections:
            if (proj.position == position and 
                proj.current_price <= max_price and 
                proj.name not in current_squad_names and
                not proj.is_injury_risk and  # Exclude injured/unavailable players
                proj.xMins_next >= 60):  # Only consider players likely to start
                
                replacement_candidates.append({
                    'name': proj.name,
                    'position': proj.position,
                    'team': proj.team,
                    'price': proj.current_price,
                    'expected_points': proj.nextGW_pts,
                    'expected_minutes': proj.xMins_next,
                    'value_score': proj.nextGW_pts / proj.current_price  # Points per million
                })
        
        
        
        # Sort by expected points (descending), then by value score
        replacement_candidates.sort(key=lambda x: (x['expected_points'], x['value_score']), reverse=True)
        
        # Return top 3 options
        return replacement_candidates[:3]

    def _create_squad_violation_decision(self, violations: List[Dict], team_data: Dict, 
                                       projections: CanonicalProjectionSet, injury_reports: Dict) -> DecisionOutput:
        """
        Create URGENT decision output for squad rule violations requiring immediate transfers
        Enhanced to also recommend use of remaining free transfers
        """
        
        # First try to create XI for captaincy analysis
        optimized_xi = None
        try:
            optimized_xi = self._optimize_starting_xi(team_data, projections, injury_reports)
        except ValueError:
            # XI optimization failed, we'll skip captain/formation analysis
            pass
        violation = violations[0]  # Handle first violation (most critical)
        team_name = violation['team']
        excess_players = violation['players']
        
        # Build squad rule violation evidence block
        squad_evidence = []
        squad_evidence.append("### 🚫 Squad Rule Check")
        player_names = [p.get('name', f"Player {p.get('player_id', 'Unknown')}") for p in violation['players']]
        squad_evidence.append(f"{team_name}: {violation['current_count']} ({', '.join(player_names)}) ← violates max {violation['max_allowed']}")
        squad_evidence.append("")
        
        # Get available free transfers to plan remaining transfer recommendations
        free_transfers = team_data.get('team_info', {}).get('free_transfers', 1)
        
        # Prioritize transfer out: injured players first, then bench players, then lowest value
        transfer_candidates = []
        
        for player in excess_players:
            player_name = player.get('name', 'Unknown')
            position = player.get('position', 'Unknown')
            current_price = player.get('current_price', 0.0)
            is_injured = player_name in injury_reports and injury_reports[player_name].get('status') == 'OUT'
            is_bench = player.get('playing_position') in [12, 13, 14, 15]  # Bench positions
            
            priority_score = 0
            priority_reason = []
            
            if is_injured:
                priority_score += 100
                priority_reason.append("INJURED (OUT)")
            if is_bench:
                priority_score += 50
                priority_reason.append("benched")
            
            # Add negative value bonus (lower price = higher priority for transfer out)
            priority_score += (20 - current_price)  # Invert price (lower price = higher score)
            
            transfer_candidates.append({
                'player': player,
                'name': player_name,
                'position': position,
                'price': current_price,
                'priority_score': priority_score,
                'reasons': priority_reason,
                'is_injured': is_injured,
                'is_bench': is_bench
            })
        
        # Sort by priority (highest first)
        transfer_candidates.sort(key=lambda x: x['priority_score'], reverse=True)
        top_candidate = transfer_candidates[0]
        
        # Find suitable replacement players for the same position
        replacement_candidates = self._find_replacement_players(projections, top_candidate, team_data)
        
        # Create transfer recommendation with CLEAN REASONING ONLY (per user requirements)
        reasoning = f"Squad rule violation detected ({team_name} players={violation['current_count']}). One forced transfer required (see Transfer Plan)."
        
        # Store evidence separately for clean display
        squad_evidence_text = f"{team_name}: {violation['current_count']} ({', '.join(player_names)}) ← violates max {violation['max_allowed']}"
        
        # Calculate post-transfer state
        post_transfer_state = {}
        if replacement_candidates:
            best_replacement = replacement_candidates[0]
            
            # Post-transfer compliance check with actual calculation
            new_count = violation['current_count'] - 1
            max_allowed = violation['max_allowed']
            status = "compliant" if new_count <= max_allowed else "STILL_VIOLATION"
            squad_evidence_text += f"\nAfter transfer: {team_name} becomes {new_count} ({status})"
            
            # Calculate bench OUT count after transfer (if forced player was on bench)
            current_squad = team_data.get('current_squad', [])
            bench_out_after = len([p for p in current_squad if p.get('status_flag') == 'OUT' and not p.get('is_starter') and p.get('player_id') != top_candidate['player'].get('player_id')])
            
            post_transfer_state = {
                'squad_rule_compliance': f"{team_name} count = {new_count} (ok)" if status == "compliant" else f"{team_name} count = {new_count} (STILL VIOLATION)",
                'bench_out_count': f"Bench OUT = {bench_out_after} (ok)" if bench_out_after == 0 else f"Bench OUT = {bench_out_after}"
            }
        else:
            squad_evidence_text += "\nDATA_ERROR: cannot produce compliant transfer"
        
        transfer_recs = [{
            'action': 'OUT',
            'player_name': top_candidate['name'],
            'position': top_candidate['position'], 
            'team': team_name,
            'price': top_candidate['price'],
            'priority': 'URGENT',
            'reason': f"Squad rule violation - {violation['current_count']} {team_name} players (max {violation['max_allowed']})",
            'injury_status': 'OUT' if top_candidate['is_injured'] else 'Available',
            'expected_points': 0.0 if top_candidate['is_injured'] else self._get_player_projection_points(projections, top_candidate['name'])
        }]
        
        # Add IN recommendation if found
        if replacement_candidates:
            best_replacement = replacement_candidates[0]
            transfer_recs.append({
                'action': 'IN',
                'player_name': best_replacement['name'],
                'position': best_replacement['position'],
                'team': best_replacement.get('team', 'Unknown'),
                'price': best_replacement['price'],
                'priority': 'URGENT',
                'reason': f"Replace {top_candidate['name']} to resolve squad violation",
                'injury_status': 'Available',
                'expected_points': best_replacement['expected_points']
            })
        
        # ENHANCEMENT: If additional free transfers are available, recommend strategic use
        # This will be handled separately in the Transfer Plan section, not in reasoning
        remaining_transfers = free_transfers - 1  # 1 transfer used for squad violation fix
        additional_transfer_recs = []
        
        if remaining_transfers > 0:
            # Generate additional transfer recommendations for remaining free transfers
            additional_transfers = self._recommend_transfers(team_data, remaining_transfers, projections)
            
            if additional_transfers:
                # Filter out any transfers that conflict with the squad violation fix
                squad_fix_players = {top_candidate['name']}
                if replacement_candidates:
                    squad_fix_players.add(replacement_candidates[0]['name'])
                
                valid_additional = [
                    t for t in additional_transfers 
                    if t.get('player_name') not in squad_fix_players
                ]
                
                if valid_additional:
                    additional_transfer_recs.extend(valid_additional[:remaining_transfers])  # Add up to remaining transfers
        
        # Update the main reasoning to stay clean and short
        # No additional reasoning appended - handled in Transfer Plan section
        
        urgent_decision = DecisionOutput(
            primary_decision="URGENT_TRANSFER",
            reasoning=reasoning,
            decision_status="URGENT",
            block_reason=f"Squad rule violation: {violation['current_count']} {team_name} players",
            confidence_score=1.0,  # 100% confident this needs fixing
            risk_scenarios=[RiskScenario(
                condition="Squad rule violation",
                expected_loss_range=(4, 8),  # Point hit penalty + lost points from rule violation
                risk_level=RiskLevel.CRITICAL,
                mitigation_action=f"Transfer out {top_candidate['name']}, in {replacement_candidates[0]['name'] if replacement_candidates else 'suitable replacement'} immediately"
            )],
            transfer_recommendations=transfer_recs
        )
        
        # Store additional transfer recommendations and post-transfer state for Transfer Plan section
        setattr(urgent_decision, 'additional_transfer_recommendations', additional_transfer_recs)
        setattr(urgent_decision, 'post_transfer_state', post_transfer_state)
        
        # Add captaincy and XI analysis even for urgent transfers, if XI optimization succeeded
        if optimized_xi:
            urgent_decision.captaincy = self._recommend_captaincy_from_xi(optimized_xi, {}, projections, injury_reports)
            urgent_decision.optimized_xi = optimized_xi
        
        # Add basic chip guidance for urgent situations
        team_info = team_data.get('team_info', {})
        available_chips = team_info.get('available_chips', [])
        if available_chips:
            urgent_decision.chip_guidance = ChipDecisionContext(
                chip_type=ChipType.NO_CHIP,  # Don't use chips during urgent squad fixes
                current_window_score=0.0,
                best_future_window_score=0.0,
                reason_codes=["urgent_transfer_needed", "squad_rule_violation"],
                pivot_conditions=["Fix squad rule violation first", "Chip decisions secondary during urgent transfers"]
            )
        
        return urgent_decision


def example_usage():
    """Example of using the enhanced framework"""
    
    # Mock team data (would come from enhanced_fpl_collector)
    team_data = {
        'chip_status': {
            'Bench Boost': {'available': True, 'played_gw': None},
            'Triple Captain': {'available': True, 'played_gw': None}
        },
        'current_squad': [
            {'name': 'Haaland', 'current_price': 15.0, 'position': 'FWD', 'is_starter': True},
            {'name': 'Bruno', 'current_price': 8.5, 'position': 'MID', 'is_starter': False},
            {'name': 'Esteve', 'current_price': 4.2, 'position': 'DEF', 'is_starter': False}
        ]
    }
    
    fixture_data = {}  # Would contain fixture information
    
    # Create framework and analyze
    framework = EnhancedDecisionFramework()
    decision = framework.analyze_chip_decision(team_data, fixture_data, current_gw=18)
    
    # Generate formatted output
    summary = framework.generate_decision_summary(decision)
    # Remove print here - output handled in fpl_sage_integration
    
    return decision


if __name__ == "__main__":
    example_usage()
