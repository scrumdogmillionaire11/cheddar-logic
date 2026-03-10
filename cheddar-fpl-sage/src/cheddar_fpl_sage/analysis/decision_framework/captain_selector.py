"""
Captain selection module for FPL decision framework.
Handles captain and vice-captain recommendations.
"""
import logging
from typing import Dict

logger = logging.getLogger(__name__)


class CaptainSelector:
    """Selects optimal captain and vice-captain."""

    def __init__(self, risk_posture: str = "BALANCED"):
        self.risk_posture = risk_posture
        self.strategy_mode = "BALANCED"
        self.fixture_horizon_context: Dict = {}

    @staticmethod
    def _clamp(value: float, minimum: float, maximum: float) -> float:
        return max(minimum, min(maximum, value))

    def _get_horizon_summary(self, player) -> Dict:
        ctx = self.fixture_horizon_context if isinstance(self.fixture_horizon_context, dict) else {}
        summary_by_id = ctx.get("player_summary_by_id") or {}
        player_id = getattr(player, "player_id", None)
        if player_id is None:
            return {}
        return summary_by_id.get(player_id) or summary_by_id.get(str(player_id)) or {}

    def _horizon_captain_adjustment(self, player) -> float:
        """
        DGW/BGW captain adjustment with deterministic caps.
        Formula:
        clamp((0.40*near_dgw) - (0.95*near_bgw), -1.00, +0.70)
        """
        summary = self._get_horizon_summary(player)
        if not summary:
            return 0.0

        near_dgw = float(summary.get("near_dgw") or 0.0)
        near_bgw = float(summary.get("near_bgw") or 0.0)

        # DGW bonus gate: minutes >= 60 and not injury-risk.
        xmins = float(getattr(player, "xMins_next", 0.0) or 0.0)
        is_injury_risk = bool(getattr(player, "is_injury_risk", False))
        if xmins < 60 or is_injury_risk:
            near_dgw = 0.0

        raw_adj = (0.40 * near_dgw) - (0.95 * near_bgw)
        return self._clamp(raw_adj, -1.00, 0.70)

    def _score_captain_candidate(self, player, strategy_mode: str) -> float:
        """Score captain options with strategy-specific leverage/floor profiles."""
        strategy = (strategy_mode or "BALANCED").upper()
        next_pts = float(getattr(player, "nextGW_pts", 0) or 0)
        ownership = float(getattr(player, "ownership_pct", 20) or 20)
        floor = float(getattr(player, "floor", next_pts * 0.8) or next_pts * 0.8)
        ceiling = float(getattr(player, "ceiling", next_pts * 1.2) or next_pts * 1.2)

        if strategy == "RECOVERY":
            base_score = next_pts + ((100 - ownership) * 0.035) + ((ceiling - next_pts) * 0.7)
        elif strategy == "DEFEND":
            base_score = next_pts + (ownership * 0.02) + (floor * 0.25)
        elif strategy == "CONTROLLED":
            base_score = next_pts + (floor * 0.15) + ((100 - ownership) * 0.015)
        else:
            base_score = next_pts + (floor * 0.10)

        horizon_adj = self._horizon_captain_adjustment(player)
        dominance_cap = 0.2 * abs(base_score)
        if dominance_cap <= 0:
            return base_score
        capped_adj = self._clamp(horizon_adj, -dominance_cap, dominance_cap)
        return base_score + capped_adj

    def recommend_captaincy(
        self,
        team_data: Dict,
        fixture_data: Dict,
        projections=None
    ) -> Dict:
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
                "expected_pts": round(float(captain.get('total_points', 0) or 0), 2),
                "ownership_pct": float(captain.get('ownership', 0)),
                "rationale": "Highest total points among available starters; steady minutes profile" + _get_ownership_warning(captain)
            }
        }
        if vice:
            recommendation["vice_captain"] = {
                "name": vice.get('name'),
                "team": vice.get('team'),
                "position": vice.get('position'),
                "expected_pts": round(float(vice.get('total_points', 0) or 0), 2),
                "ownership_pct": float(vice.get('ownership', 0)),
                "rationale": "Second-best form/points among available players; injury insurance" + _get_ownership_warning(vice)
            }
            
        return recommendation

    def recommend_captaincy_from_xi(
        self,
        optimized_xi,
        fixture_data: Dict,
        projections=None,
        injury_reports=None
    ) -> Dict:
        """Captain recommendation using only XI-validated players, excluding OUT players"""
        pool = optimized_xi.get_captain_options()
        
        # Filter OUT players from captain pool
        if injury_reports:
            # Need to import InjuryReport and InjuryStatus from somewhere
            # For now, use basic filtering
            pool = [
                p for p in pool 
                if getattr(injury_reports.get(p.player_id, None), 'status', None) != 'OUT'
            ]
        
        # Enforce captain/vice eligibility: MID/FWD only, minutes >= 60
        eligible = [
            p for p in pool
            if p.position in ["MID", "FWD"] and getattr(p, "xMins_next", 90) >= 60
        ]
        if not eligible:
            eligible = pool
        eligible = eligible[:3]

        if not eligible:
            return {
                "captain": {
                    "name": "No valid captain in XI",
                    "team": "N/A",
                    "position": "N/A",
                    "ownership_pct": 0,
                    "rationale": "No players available in XI for captaincy"
                },
                "vice_captain": {
                    "name": "N/A",
                    "team": "N/A",
                    "position": "N/A",
                    "ownership_pct": 0,
                    "rationale": "No vice available"
                }
            }
            
        ranked = sorted(
            eligible,
            key=lambda p: self._score_captain_candidate(p, self.strategy_mode),
            reverse=True,
        )
        captain = ranked[0]
        vice = ranked[1] if len(ranked) > 1 else ranked[0]
        captain_score = self._score_captain_candidate(captain, self.strategy_mode)
        vice_score = self._score_captain_candidate(vice, self.strategy_mode)
        
        # Build candidate list for transparency
        candidate_list = [
            {
                "player_id": p.player_id,
                "name": p.name,
                "team": p.team,
                "position": p.position,
                "nextGW_pts": getattr(p, "nextGW_pts", 0),
                "ownership_pct": getattr(p, "ownership_pct", 0),
                "strategy_score": round(self._score_captain_candidate(p, self.strategy_mode), 2),
            }
            for p in ranked[:3]
        ]
        
        return {
            "captain": {
                "name": captain.name,
                "team": captain.team,
                "position": captain.position,
                "expected_pts": round(float(getattr(captain, 'nextGW_pts', 0) or 0), 2),
                "ownership_pct": getattr(captain, "ownership_pct", 0),
                "rationale": (
                    f"Top captain score in XI for {self.strategy_mode} mode "
                    f"({captain_score:.2f} score; {getattr(captain, 'nextGW_pts', 0):.1f} projected pts)"
                )
            },
            "vice_captain": {
                "name": vice.name,
                "team": vice.team,
                "position": vice.position,
                "expected_pts": round(float(getattr(vice, 'nextGW_pts', 0) or 0), 2),
                "ownership_pct": getattr(vice, "ownership_pct", 0),
                "rationale": (
                    f"Second captain score option "
                    f"({vice_score:.2f} score; {getattr(vice, 'nextGW_pts', 0):.1f} projected pts)"
                )
            },
            "candidate_pool": candidate_list
        }
