"""
Chip analysis module for FPL decision framework.
Handles Bench Boost, Triple Captain, Free Hit, and Wildcard timing decisions.

EXTRACTION COMPLETE: All chip methods extracted from enhanced_decision_framework.py
"""

import logging
from typing import Optional, Dict, Any, List, Tuple
from enum import Enum
from dataclasses import dataclass

from .models import ChipRecommendation
from .constants import CHIP_NAMES

logger = logging.getLogger(__name__)


class ChipType(Enum):
    """Chip type enumeration"""
    BENCH_BOOST = "BB"
    TRIPLE_CAPTAIN = "TC"
    FREE_HIT = "FH"
    WILDCARD = "WC"
    NONE = "NONE"


class RiskLevel(Enum):
    """Risk level classification for scenarios"""
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
    optimized_xi: Any = None  # OptimizedXI type


class ChipAnalyzer:
    """Analyzes chip timing and usage recommendations."""

    def __init__(self, risk_posture: str = "BALANCED"):
        """
        Initialize chip analyzer.
        
        Args:
            risk_posture: Manager's risk tolerance (CONSERVATIVE|BALANCED|AGGRESSIVE)
        """
        self.risk_posture = risk_posture
        self.risk_thresholds = {
            'acceptable_loss': 8,
            'unacceptable_loss': 15
        }
        logger.info(f"ChipAnalyzer initialized with risk_posture={risk_posture}")

    def analyze_chip_decision(
        self,
        squad_data: Dict[str, Any],
        fixture_data: Dict[str, Any],
        projections: Dict[int, Any],
        chip_status: Dict[str, Any],
        current_gw: int,
        chip_policy: Optional[Dict[str, Any]] = None
    ) -> ChipRecommendation:
        """
        Analyze which chip (if any) to play this gameweek.

        Always returns a valid ChipRecommendation, even for edge cases.
        Gracefully handles empty windows, missing data, and unavailable chips.

        Args:
            squad_data: Current squad information
            fixture_data: Fixture data for analysis
            projections: Player projections by ID
            chip_status: Availability status of each chip
            current_gw: Current gameweek number
            chip_policy: Optional chip policy with windows

        Returns:
            ChipRecommendation with chip, use_this_gw, reasoning, confidence
        """
        # Get available chips - filter by availability status
        available_chips = [
            chip for chip in CHIP_NAMES
            if chip_status.get(chip, {}).get('available', True)
        ]

        # Edge case: No chips available
        if not available_chips:
            return ChipRecommendation(
                chip="None",
                use_this_gw=False,
                reasoning="No chips available - all have been used this season.",
                confidence="HIGH"
            )

        # Get chip windows from policy
        windows = (chip_policy or {}).get('chip_windows', [])

        # Edge case: No chip windows defined
        if not windows:
            return ChipRecommendation(
                chip="None",
                use_this_gw=False,
                reasoning="No chip windows defined. Consider defining optimal windows in config.",
                confidence="LOW"
            )

        # Find windows containing current GW with available chips
        current_windows = [
            w for w in windows
            if w.get('start_gw', 0) <= current_gw <= w.get('end_gw', 0)
            and w.get('chip') in available_chips
        ]

        if not current_windows:
            # Find next available window for forward guidance
            future_windows = [
                w for w in windows
                if w.get('start_gw', 0) > current_gw
                and w.get('chip') in available_chips
            ]
            if future_windows:
                next_window = min(future_windows, key=lambda w: w['start_gw'])
                return ChipRecommendation(
                    chip="None",
                    use_this_gw=False,
                    optimal_window_gw=next_window['start_gw'],
                    reasoning=f"Save chips. Next optimal window: GW{next_window['start_gw']} for {next_window['chip']}.",
                    confidence="MEDIUM"
                )
            else:
                return ChipRecommendation(
                    chip="None",
                    use_this_gw=False,
                    reasoning="No optimal chip windows for remaining gameweeks.",
                    confidence="LOW"
                )

        # Score current windows and select best
        try:
            best_window = self._score_and_select_window(
                current_windows, squad_data, fixture_data, projections
            )
            chip_name = best_window.get('chip', 'None')

            return ChipRecommendation(
                chip=chip_name,
                use_this_gw=True,
                optimal_window_gw=current_gw,
                reasoning=f"GW{current_gw} is optimal for {chip_name}. {best_window.get('reason', '')}",
                confidence="HIGH"
            )
        except (KeyError, TypeError, ValueError) as e:
            logger.warning("Chip window scoring failed: %s, returning conservative recommendation", e)
            return ChipRecommendation(
                chip="None",
                use_this_gw=False,
                reasoning="Chip analysis incomplete. Consider manual review.",
                confidence="LOW"
            )

    def _score_and_select_window(
        self,
        windows: List[Dict],
        squad_data: Dict,
        fixture_data: Dict,
        projections: Dict
    ) -> Dict:
        """
        Score chip windows and return the best one.

        Simple scoring based on window configuration.
        Can be enhanced with fixture/projection analysis.
        """
        if not windows:
            raise ValueError("No windows to score")

        # For now, return first window - can be enhanced with scoring logic
        # Priority order: Bench Boost > Triple Captain > Free Hit > Wildcard
        priority = {
            'Bench Boost': 1,
            'Triple Captain': 2,
            'Free Hit': 3,
            'Wildcard': 4
        }

        sorted_windows = sorted(
            windows,
            key=lambda w: priority.get(w.get('chip', ''), 99)
        )

        return sorted_windows[0]

    def should_use_free_hit(self, team_data: Dict, fixture_data: Dict, current_gw: int,
                            critical_needs: int, free_transfers: int, available_chips: List[ChipType]) -> bool:
        """Determine if Free Hit is defensible based on needs and upcoming windows."""
        if ChipType.FREE_HIT not in available_chips:
            return False
        if critical_needs >= 3:
            return True
        if free_transfers == 0 and self.has_upcoming_special_window(team_data, fixture_data, current_gw):
            return True
        return False

    def has_upcoming_special_window(self, team_data: Dict, fixture_data: Dict, current_gw: int, lookahead: int = 3) -> bool:
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

    def choose_best_chip_option(self, optimized_xi, bench_strength: float, available_chips: List[ChipType]) -> Optional[ChipType]:
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
    
    def analyze_bench_boost_decision(self, team_data: Dict, fixture_data: Dict, 
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
    
    def analyze_triple_captain_decision(self, team_data: Dict, fixture_data: Dict, 
                                       current_gw: int, primary_target: Optional[Dict] = None,
                                       projections=None) -> DecisionOutput:
        """Triple Captain analysis with pivot conditions"""
        
        # Identify TC targets
        squad = team_data.get('current_squad', [])
        premium_attackers = [p for p in squad if p.get('current_price', 0) > 11.0 
                           and p.get('position') in ['MID', 'FWD']]
        
        risk_scenarios = []
        if not primary_target:
            manager_context = team_data.get('manager_context', {})
            # Ensure manager_context is a dict (it might be a string from config)
            if not isinstance(manager_context, dict):
                manager_context = {}
            primary_target = self._identify_tc_target(premium_attackers, fixture_data, projections, manager_context)
        
        if not primary_target:
            return DecisionOutput(
                primary_decision="NO_CHIP_ACTION",
                reasoning="Triple Captain target unknown; hold chips until clarity.",
                risk_scenarios=[],
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

    def analyze_no_chip_decision(self, team_data: Dict, fixture_data: Dict, 
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

    def analyze_free_hit_decision(self, team_data: Dict, fixture_data: Dict, 
                                 current_gw: int, critical_needs: int, free_transfers: int) -> DecisionOutput:
        """Analyze Free Hit chip decision"""
        decision = f"Activate Free Hit - {critical_needs} critical issues to fix"
        reasoning = f"Team has {critical_needs} critical problems but limited transfers. FH provides optimal solution."
        
        risk_scenarios = [
            RiskScenario(
                condition="If FH team construction is poor",
                expected_loss_range=(8, 15),
                risk_level=RiskLevel.UNACCEPTABLE,
                probability_estimate=0.2,
                mitigation_action="Careful FH squad selection"
            )
        ]
        
        return DecisionOutput(
            primary_decision=decision,
            reasoning=reasoning,
            risk_scenarios=risk_scenarios,
            tilt_armor_threshold=10,
            chip_guidance=ChipDecisionContext(
                current_gw=current_gw,
                chip_type=ChipType.FREE_HIT,
                available_chips=[ChipType.FREE_HIT],
                next_optimal_window=None
            ),
            lineup_focus="complete_overhaul"
        )
    
    def analyze_wildcard_decision(self, team_data: Dict, fixture_data: Dict, 
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

    def can_activate_triple_captain(self, team_data: Dict, fixture_data: Dict, window_context: Dict[str, Any],
                                   available_chips: List[ChipType], 
                                   projections=None) -> Tuple[bool, List[str], Optional[Dict]]:
        """
        Check if Triple Captain can be activated based on various conditions.
        
        Returns:
            Tuple of (can_activate, reason_codes, primary_target)
        """
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
        if not self._manager_context_allows_tc(team_data):
            return False, ["tc_manager_context_conservative"], primary_target
        minutes_confidence = self._minutes_confidence_for_player(primary_target)
        threshold = self._minutes_threshold_from_preferences(team_data)
        if minutes_confidence < threshold:
            return False, ["tc_minutes_low"], primary_target
        if self._player_has_rotation_risk(primary_target):
            return False, ["tc_rotation_risk"], primary_target
        return True, [], primary_target

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

    def _has_strong_captain_candidate(self, squad: List[Dict], fixture_data: Dict) -> bool:
        """Check if there's a strong TC candidate available"""
        premium_players = [p for p in squad if p.get('current_price', 0) > 11.0 
                          and p.get('is_starter', False) and p.get('status_flag') not in ['OUT', 'DOUBT']]
        return len(premium_players) > 0

    def _identify_tc_target(self, premium_players: List[Dict], fixture_data: Dict, 
                          projections=None,
                          manager_context: Dict = None) -> Optional[Dict]:
        """Identify TC target using risk-aware selection based on manager posture"""
        
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
        
        # Get risk posture from manager context
        risk_posture = (manager_context or {}).get('risk_posture', 'BALANCED')
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
            if risk_posture == 'CHASE':
                # CHASE: Favor ceiling over floor, prefer differentials
                score = (
                    proj.ceiling * 0.6 +           # High ceiling matters most
                    proj.nextGW_pts * 0.3 +        # Expected points matter
                    (100 - proj.ownership_pct) * 0.1  # Differential bonus
                )
                metric = f"ceiling={proj.ceiling:.1f}, diff={100-proj.ownership_pct:.0f}%"
            elif risk_posture == 'DEFEND':
                # DEFEND: Favor floor over ceiling, template picks OK
                score = (
                    proj.floor * 0.4 +             # High floor prevents disasters
                    proj.nextGW_pts * 0.5 +        # Expected points primary
                    proj.ownership_pct * 0.1       # Template pick bonus
                )
                metric = f"floor={proj.floor:.1f}, template={proj.ownership_pct:.0f}%"
            else:  # BALANCED
                # BALANCED: Weight expected points most, ceiling/floor secondary
                score = (
                    proj.nextGW_pts * 0.6 +        # Expected points primary
                    proj.ceiling * 0.25 +          # Some upside potential
                    proj.floor * 0.15              # Some downside protection
                )
                metric = f"xPts={proj.nextGW_pts:.1f}"
            
            candidates.append({
                'player': player,
                'score': score,
                'metric': metric
            })
            logger.info(f"  {player.get('name')}: score={score:.1f} ({metric})")
        
        if not candidates:
            logger.warning("⚠️ No viable TC candidates with projections")
            return None
        
        # Sort by score and return best
        best = max(candidates, key=lambda x: x['score'])
        logger.info(f"✅ TC Target: {best['player'].get('name')} (score={best['score']:.1f})")
        return best['player']

    def _manager_context_allows_tc(self, team_data: Dict) -> bool:
        """Check if manager context allows TC activation"""
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
        """Get minutes confidence for a player"""
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
        """Get minutes threshold from preferences"""
        prefs = team_data.get('analysis_preferences', {}) or {}
        threshold = prefs.get('tc_minutes_threshold')
        try:
            value = float(threshold)
        except (TypeError, ValueError):
            value = 85.0
        return max(0.0, min(100.0, value))

    def _player_has_rotation_risk(self, player: Dict) -> bool:
        """Determine if player has rotation risk"""
        status = player.get('status_flag', '').upper()
        if status in {'OUT', 'DOUBT'}:
            return True
        news = (player.get('news') or "").lower()
        rotation_flags = ["rotation", "rest", "minutes", "bench", "unused", "squad"]
        return any(flag in news for flag in rotation_flags)

    def _is_high_minutes_risk(self, player: Dict) -> bool:
        """Determine if player has high minutes risk"""
        # Simple heuristic - can be enhanced with more data
        return (player.get('current_price', 0) > 6.0 and 
                player.get('team') in ['CHE', 'MUN', 'TOT'])  # High rotation teams
    
    def _is_rotation_risk(self, player: Dict) -> bool:
        """Determine if expensive player has rotation risk"""
        return (player.get('current_price', 0) > 8.0 and 
                player.get('position') in ['MID', 'FWD'])

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
