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
            
        captain = eligible[0]
        vice = eligible[1] if len(eligible) > 1 else eligible[0]
        
        # Build candidate list for transparency
        candidate_list = [
            {
                "player_id": p.player_id,
                "name": p.name,
                "team": p.team,
                "position": p.position,
                "nextGW_pts": getattr(p, "nextGW_pts", 0),
                "ownership_pct": getattr(p, "ownership_pct", 0)
            }
            for p in eligible[:3]
        ]
        
        return {
            "captain": {
                "name": captain.name,
                "team": captain.team,
                "position": captain.position,
                "ownership_pct": getattr(captain, "ownership_pct", 0),
                "rationale": f"Top projected points in XI ({getattr(captain, 'nextGW_pts', 0):.1f}pts)"
            },
            "vice_captain": {
                "name": vice.name,
                "team": vice.team,
                "position": vice.position,
                "ownership_pct": getattr(vice, "ownership_pct", 0),
                "rationale": f"Second-best option ({getattr(vice, 'nextGW_pts', 0):.1f}pts)"
            },
            "candidate_pool": candidate_list
        }
