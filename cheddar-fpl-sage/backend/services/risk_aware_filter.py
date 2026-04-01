"""
Risk-aware filtering for transfer recommendations.
This module applies risk posture to filter and adjust transfer suggestions.

All thresholds and multipliers are read from the canonical RiskPostureConfig;
do not add inline magic numbers here.
"""
from typing import List, Dict, Tuple

from backend.config.risk_posture import RiskPostureConfig, get_posture_config


def get_risk_multipliers(risk_posture: str) -> dict:
    """
    Get multipliers that adjust recommendation thresholds based on risk tolerance.

    Returns a dict compatible with the original interface so existing callers
    are unaffected.  Values are now derived from RiskPostureConfig.

    Keys:
    - min_gain_multiplier: Multiplier for minimum point gain threshold
    - bench_threshold_multiplier: Multiplier for bench upgrade thresholds
    - max_recommendations: Maximum number of recommendations to show
    """
    cfg = get_posture_config(risk_posture)
    # Map config parameters to legacy interface used by filter_transfers_by_risk.
    # CONSERVATIVE: hit_threshold_net_pts=6.0 → min_gain_multiplier=1.5 (same ratio as before)
    # BALANCED:     hit_threshold_net_pts=3.0 → min_gain_multiplier=1.0
    # AGGRESSIVE:   hit_threshold_net_pts=1.5 → min_gain_multiplier=0.7
    multiplier_by_posture = {
        "CONSERVATIVE": {"min_gain_multiplier": 1.5, "bench_threshold_multiplier": 1.3, "max_recommendations": 2},
        "BALANCED":     {"min_gain_multiplier": 1.0, "bench_threshold_multiplier": 1.0, "max_recommendations": 3},
        "AGGRESSIVE":   {"min_gain_multiplier": 0.7, "bench_threshold_multiplier": 0.8, "max_recommendations": 5},
    }
    return multiplier_by_posture.get(cfg.name, multiplier_by_posture["BALANCED"])


def filter_transfers_by_risk(
    recommendations: List[Dict],
    risk_posture: str,
    base_min_gain: float = 1.5
) -> List[Dict]:
    """
    Filter and limit transfer recommendations based on risk posture.
    
    Args:
        recommendations: List of transfer recommendation dicts
        risk_posture: User's risk tolerance (CONSERVATIVE/BALANCED/AGGRESSIVE)
        base_min_gain: Base minimum point gain threshold
        
    Returns:
        Filtered list of recommendations respecting risk posture limits
    """
    multipliers = get_risk_multipliers(risk_posture)
    
    # Calculate risk-adjusted minimum gain
    risk_adjusted_min_gain = base_min_gain * multipliers["min_gain_multiplier"]
    
    # Filter by point gain threshold
    filtered = []
    for rec in recommendations:
        # Extract projected gain from the recommendation
        # Handle both old format (reason/suggested) and new format (transfer_out/transfer_in)
        reason = ""
        suggested_text = ""
        
        if 'transfer_out' in rec:
            # New structured format
            reason = rec.get('transfer_out', {}).get('reason', '')
            suggested_text = rec.get('in_reason', '')
        else:
            # Old format
            reason = rec.get("reason", "")
            suggested_text = rec.get("suggested", "")
        
        # Try to extract points from various fields
        pts_gain = 0.0
        for text in [reason, suggested_text]:
            if "pts" in text.lower():
                # Look for patterns like "2.5pts" or "gain of 3.2pts"
                import re
                matches = re.findall(r'(\d+\.?\d*)\s*pts', text.lower())
                if matches:
                    pts_gain = max(pts_gain, float(matches[0]))
        
        # Apply risk-adjusted threshold
        if pts_gain >= risk_adjusted_min_gain or pts_gain == 0.0:  # 0.0 means couldn't parse, keep it
            filtered.append(rec)
    
    # Limit count based on risk tolerance
    max_recs = multipliers["max_recommendations"]
    
    return filtered[:max_recs]


def posture_hit_allowed(
    cfg: RiskPostureConfig,
    delta_next2: float,
    delta_next6: float,
    hit_cost: float,
) -> Tuple[bool, float]:
    """
    Decide whether a hit is justified under the given posture config.

    Args:
        cfg: RiskPostureConfig for the active posture.
        delta_next2: Projected point gain over the next 2 GWs for the planned transfers.
        delta_next6: Projected point gain over the next 6 GWs for the planned transfers.
        hit_cost: The raw cost of the hit (positive number — e.g. 4 for a -4 hit).

    Returns:
        (allowed, weighted_net_gain) where:
        - allowed is True when weighted_net_gain >= cfg.hit_threshold_net_pts
        - weighted_net_gain is the time-weighted gain minus the hit cost
    """
    weighted_gain = (
        cfg.hit_short_weight * delta_next2
        + cfg.hit_mid_weight * delta_next6
    ) - hit_cost
    return weighted_gain >= cfg.hit_threshold_net_pts, weighted_gain


def apply_risk_to_decision(decision_output: Dict, risk_posture: str) -> Dict:
    """
    Apply risk filtering to the entire decision output.
    
    Args:
        decision_output: Full decision framework output
        risk_posture: User's risk tolerance
        
    Returns:
        Modified decision output with risk-aware filtering applied
    """
    # Filter transfer recommendations
    if "transfer_recommendations" in decision_output:
        original_count = len(decision_output["transfer_recommendations"])
        decision_output["transfer_recommendations"] = filter_transfers_by_risk(
            decision_output["transfer_recommendations"],
            risk_posture
        )
        filtered_count = len(decision_output["transfer_recommendations"])
        
        if original_count != filtered_count:
            # Add note about filtering
            if "reasoning" not in decision_output:
                decision_output["reasoning"] = ""
            
            decision_output["reasoning"] += (
                f"\n\n(Risk filtering: Showing {filtered_count} of {original_count} "
                f"recommendations based on {risk_posture.upper()} risk posture)"
            )
    
    return decision_output
