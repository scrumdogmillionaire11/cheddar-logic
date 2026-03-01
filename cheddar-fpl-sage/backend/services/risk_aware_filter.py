"""
Risk-aware filtering for transfer recommendations.
This module applies risk posture to filter and adjust transfer suggestions.
"""
from typing import List, Dict


def get_risk_multipliers(risk_posture: str) -> dict:
    """
    Get multipliers that adjust recommendation thresholds based on risk tolerance.
    
    Args:
        risk_posture: One of CONSERVATIVE, BALANCED, AGGRESSIVE
        
    Returns:
        Dictionary with:
        - min_gain_multiplier: Multiplier for minimum point gain (lower = more aggressive)
        - bench_threshold_multiplier: Multiplier for bench upgrade thresholds
        - max_recommendations: Maximum number of recommendations to show
    """
    risk_posture = risk_posture.upper()
    
    if risk_posture == "CONSERVATIVE":
        return {
            "min_gain_multiplier": 1.5,  # Require 50% more gain
            "bench_threshold_multiplier": 1.3,  # Stricter bench upgrades
            "max_recommendations": 2,  # Show fewer, safer options
        }
    elif risk_posture == "AGGRESSIVE":
        return {
            "min_gain_multiplier": 0.7,  # Accept smaller gains (30% less)
            "bench_threshold_multiplier": 0.8,  # More liberal bench upgrades
            "max_recommendations": 5,  # Show more speculative options
        }
    else:  # BALANCED (default)
        return {
            "min_gain_multiplier": 1.0,
            "bench_threshold_multiplier": 1.0,
            "max_recommendations": 3,
        }


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
