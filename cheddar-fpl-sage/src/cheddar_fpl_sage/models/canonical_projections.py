"""
Canonical Projection Contracts
Establishes single source of truth for post-engine projections
"""

from dataclasses import dataclass
from typing import List, Optional

@dataclass
class CanonicalPlayerProjection:
    """
    Single canonical projection format used by ALL downstream components.
    Everything after Projection Engine consumes ONLY this format.
    """
    player_id: int
    name: str
    position: str  # GK, DEF, MID, FWD
    team: str
    current_price: float
    
    # Projection scores (primary decision inputs)
    nextGW_pts: float
    next6_pts: float
    xMins_next: float  # Expected minutes next GW (0-90)
    
    # Uncertainty & risk metrics
    volatility_score: float  # 0-1 score of point variance (higher = more volatile)
    ceiling: float     # 90th percentile outcome
    floor: float       # 10th percentile outcome
    
    # Meta information
    tags: List[str]    # ['injury_risk', 'rotation_risk', 'dgw', 'blank']
    confidence: float  # 0-1 projection confidence
    
    # Ownership (NOT effective ownership - see fix #2)
    ownership_pct: float        # Raw ownership percentage
    captaincy_rate: Optional[float] = None  # Captain rate when available
    
    # Fixture context
    fixture_difficulty: Optional[int] = None  # 1-5 scale (1=easiest, 5=hardest)
    
    @property
    def effective_ownership(self) -> Optional[float]:
        """Calculate EO only when we have captaincy data"""
        if self.captaincy_rate is not None:
            return self.ownership_pct * (1 + self.captaincy_rate / 100)
        return None
    
    @property
    def is_rotation_risk(self) -> bool:
        return 'rotation_risk' in self.tags or self.xMins_next < 70
    
    @property
    def is_injury_risk(self) -> bool:
        return 'injury_risk' in self.tags
    
    @property
    def points_per_million(self) -> float:
        """Value metric for transfer decisions"""
        return self.nextGW_pts / max(self.current_price, 1.0)

@dataclass 
class CanonicalProjectionSet:
    """
    Complete projection set for all players
    Single source consumed by Transfer Advisor, Captain Logic, etc.
    """
    projections: List[CanonicalPlayerProjection]
    gameweek: int
    created_timestamp: str
    confidence_level: str  # 'high', 'medium', 'low' - affects decision thresholds
    
    def get_by_position(self, position: str) -> List[CanonicalPlayerProjection]:
        return [p for p in self.projections if p.position == position]
    
    def get_by_id(self, player_id: int) -> Optional[CanonicalPlayerProjection]:
        return next((p for p in self.projections if p.player_id == player_id), None)
    
    def filter_by_tags(self, tags: List[str]) -> List[CanonicalPlayerProjection]:
        return [p for p in self.projections if any(tag in p.tags for tag in tags)]
    
    def top_by_points(self, n: int = 10) -> List[CanonicalPlayerProjection]:
        return sorted(self.projections, key=lambda x: x.nextGW_pts, reverse=True)[:n]

@dataclass
class OptimizedXI:
    """Enforced starting XI with legal formation - prevents XI/formation errors"""
    starting_xi: List[CanonicalPlayerProjection]  # Exactly 11 players
    bench: List[CanonicalPlayerProjection]        # Exactly 4 players
    formation: str                                # e.g., "3-4-3"
    captain_pool: List[CanonicalPlayerProjection] # Valid captain options from XI only
    total_expected_pts: float
    formation_valid: bool
    
    def __post_init__(self):
        assert len(self.starting_xi) == 11, f"XI must have 11 players, got {len(self.starting_xi)}"
        assert len(self.bench) == 4, f"Bench must have 4 players, got {len(self.bench)}"
        assert all(p in self.starting_xi for p in self.captain_pool), "Captain pool must be subset of XI"
        
        # Validate formation constraints
        pos_counts = {'GK': 0, 'DEF': 0, 'MID': 0, 'FWD': 0}
        for player in self.starting_xi:
            pos_counts[player.position] += 1
            
        self.formation_valid = (
            pos_counts['GK'] == 1 and
            3 <= pos_counts['DEF'] <= 5 and
            3 <= pos_counts['MID'] <= 5 and
            1 <= pos_counts['FWD'] <= 3
        )
        
        if not self.formation_valid:
            raise ValueError(f"Invalid formation: {pos_counts}")

    def get_captain_options(self) -> List[CanonicalPlayerProjection]:
        """Returns valid captain candidates (XI only)"""
        return sorted(self.captain_pool, key=lambda x: x.nextGW_pts, reverse=True)

# Legacy types - DEPRECATED, use CanonicalPlayerProjection instead
class LegacyProjectionTypes:
    """
    These types exist for backward compatibility only.
    All new code should use CanonicalPlayerProjection.
    """
    pass

# Contract enforcement
def validate_projection_set(projection_set: CanonicalProjectionSet):
    """
    Validate projection set meets requirements for decision logic.
    Returns dict: {"valid": bool, "errors": [str]} for compatibility.
    """
    errors = []
    
    if not projection_set.projections:
        errors.append("Empty projection set")
    
    # Check required fields
    for proj in projection_set.projections:
        if proj.nextGW_pts < 0:
            errors.append(f"Negative points projection for {proj.name}")
        if proj.xMins_next < 0 or proj.xMins_next > 90:
            errors.append(f"Invalid minutes projection for {proj.name}: {proj.xMins_next}")
        if proj.current_price <= 0:
            errors.append(f"Invalid price for {proj.name}: {proj.current_price}")
    
    return {"valid": len(errors) == 0, "errors": errors}
