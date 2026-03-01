"""
Transform FPL Sage analysis results into frontend-friendly format.

This module is the single source of truth for all derived display values.
Frontend components should consume these values directly without recalculation.
"""
from typing import Dict, Any, Optional, List
import logging
from backend.services.risk_aware_filter import filter_transfers_by_risk

logger = logging.getLogger(__name__)


# =============================================================================
# DERIVED VALUE CALCULATIONS
# These calculations happen once in the backend, consumed by all frontends
# =============================================================================

def _calculate_captain_delta(captain_data: Optional[Dict], vice_data: Optional[Dict]) -> Dict[str, Any]:
    """
    Calculate the points delta between captain and vice captain.

    Returns:
        Dict with delta_pts (next GW) and delta_pts_4gw (4 gameweek window)
    """
    if not captain_data or not vice_data:
        return {"delta_pts": None, "delta_pts_4gw": None}

    captain_pts = captain_data.get("expected_pts") or captain_data.get("nextGW_pts") or 0
    vice_pts = vice_data.get("expected_pts") or vice_data.get("nextGW_pts") or 0

    # Calculate 4GW delta if available
    captain_4gw = captain_data.get("next4gw_pts") or captain_data.get("next4_pts")
    vice_4gw = vice_data.get("next4gw_pts") or vice_data.get("next4_pts")

    delta_4gw = None
    if captain_4gw is not None and vice_4gw is not None:
        delta_4gw = round(captain_4gw - vice_4gw, 1)

    return {
        "delta_pts": round(captain_pts - vice_pts, 1) if captain_pts and vice_pts else None,
        "delta_pts_4gw": delta_4gw
    }


def _calculate_squad_health(my_team: Dict, analysis: Dict) -> Dict[str, Any]:
    """
    Calculate squad health metrics from injury data and squad composition.

    Returns:
        Dict with injury counts, availability percentage, and critical positions
    """
    # Note: injury_data and squad are available for future enhancement
    # when we have more detailed injury reporting
    _ = my_team.get("injuries", {})  # Reserved for future use
    _ = my_team.get("picks", [])  # Reserved for future use

    # Count injuries from risk scenarios if available
    risk_scenarios = analysis.get("decision", {})
    if hasattr(risk_scenarios, "__dict__"):
        risk_scenarios = risk_scenarios.__dict__

    scenarios = risk_scenarios.get("risk_scenarios", []) if isinstance(risk_scenarios, dict) else []

    injured_count = 0
    doubtful_count = 0
    critical_positions = []

    for scenario in scenarios:
        if hasattr(scenario, "__dict__"):
            scenario = scenario.__dict__

        condition = scenario.get("scenario", "").lower() if isinstance(scenario, dict) else ""
        severity = scenario.get("severity", "").upper() if isinstance(scenario, dict) else ""

        if "injur" in condition or "out" in condition:
            if severity in ("CRITICAL", "HIGH"):
                injured_count += 1
            elif severity in ("MEDIUM", "WARNING"):
                doubtful_count += 1

            # Extract position if mentioned
            for pos in ["GK", "DEF", "MID", "FWD"]:
                if pos in condition.upper():
                    critical_positions.append(pos)

    # Calculate health percentage
    available = 15 - injured_count - doubtful_count
    health_pct = round((available / 15) * 100, 1) if available >= 0 else 0

    return {
        "total_players": 15,
        "available": max(available, 0),
        "injured": injured_count,
        "doubtful": doubtful_count,
        "health_pct": health_pct,
        "critical_positions": list(set(critical_positions))
    }


def _calculate_transfer_metrics(out_player: Dict, in_player: Dict, free_transfers: int = 1) -> Dict[str, Any]:
    """
    Calculate transfer cost metrics.

    Returns:
        Dict with hit_cost, net_cost, delta_pts_4gw, delta_pts_6gw
    """
    # Hit cost: 0 if free transfer available, -4 otherwise
    hit_cost = 0 if free_transfers > 0 else 4

    # Net cost: price difference (in_price - out_price)
    out_price = out_player.get("price") or out_player.get("current_price") or 0
    in_price = in_player.get("price") or in_player.get("current_price") or 0
    net_cost = round(in_price - out_price, 1) if in_price and out_price else 0

    # Points delta over 4 and 6 gameweeks
    out_4gw = out_player.get("next4_pts") or out_player.get("next4gw_pts") or 0
    in_4gw = in_player.get("next4_pts") or in_player.get("next4gw_pts") or in_player.get("expected_points") or 0

    out_6gw = out_player.get("next6_pts") or out_player.get("next6gw_pts") or 0
    in_6gw = in_player.get("next6_pts") or in_player.get("next6gw_pts") or 0

    # Delta is IN player - OUT player (positive = improvement)
    delta_4gw = round(in_4gw - out_4gw, 1) if in_4gw or out_4gw else None
    delta_6gw = round(in_6gw - out_6gw, 1) if in_6gw and out_6gw else None

    return {
        "hit_cost": hit_cost,
        "net_cost": net_cost,
        "delta_pts_4gw": delta_4gw,
        "delta_pts_6gw": delta_6gw
    }


def _map_transfer_confidence(priority: str, profile: str = "") -> tuple[str, str]:
    """
    Map transfer priority and profile to confidence level with context.

    Args:
        priority: URGENT, NORMAL, or similar
        profile: Transfer profile like FIXTURE_UPGRADE, VALUE_PICK, etc.

    Returns:
        Tuple of (confidence_level, context_string)
    """
    priority_upper = (priority or "").upper()
    profile_upper = (profile or "").upper()

    # High confidence triggers
    if priority_upper == "URGENT":
        if "INJURY" in profile_upper or "SUSPEND" in profile_upper:
            return ("HIGH", "Injury/suspension replacement")
        return ("HIGH", "Urgent transfer required")
    if "INJURY" in profile_upper or "FORCED" in profile_upper:
        return ("HIGH", "Forced by team news")
    if "FIXTURE" in profile_upper and "UPGRADE" in profile_upper:
        return ("HIGH", "Strong fixture upgrade")

    # Low confidence triggers
    if "PUNT" in profile_upper or "DIFFERENTIAL" in profile_upper:
        return ("LOW", "Speculative differential punt")
    if "SIDEWAYS" in profile_upper:
        return ("LOW", "Marginal sideways move")

    # Default to medium
    return ("MEDIUM", "Standard fixture/form upgrade")


def _build_transfer_plans(transfer_recs: List[Dict], free_transfers: int) -> Dict[str, Any]:
    """
    Build structured transfer plans with calculated metrics for frontend.

    Returns:
        Dict with primary and secondary transfer plans, each containing:
        - out: player name being transferred out
        - in: player name being transferred in
        - hit_cost: points cost (0 if free, 4 if hit)
        - net_cost: price difference in millions
        - delta_pts_4gw: expected points gain over 4 GWs
        - delta_pts_6gw: expected points gain over 6 GWs (if available)
        - reason: explanation for the transfer
        - confidence: HIGH/MEDIUM/LOW
    """
    plans: Dict[str, Any] = {
        "primary": None,
        "secondary": None,
        "no_transfer_reason": None
    }

    if not transfer_recs:
        plans["no_transfer_reason"] = "No transfer clears value thresholds this GW."
        return plans

    # Process transfers - look for paired OUT/IN transfers
    paired_transfers = []

    for transfer in transfer_recs:
        # Handle dataclass conversion
        if hasattr(transfer, "__dict__"):
            transfer = transfer.__dict__

        # Check for new structured format with transfer_out/transfer_in
        if 'transfer_out' in transfer and 'transfer_in' in transfer:
            out_player = transfer['transfer_out']
            in_player = transfer['transfer_in']

            # Calculate metrics
            metrics = _calculate_transfer_metrics(out_player, in_player, free_transfers)

            # Get confidence and context
            confidence_level, confidence_context = _map_transfer_confidence(
                transfer.get('priority', 'NORMAL'),
                transfer.get('profile', '')
            )

            # Check for urgency indicators
            urgency = None
            priority = transfer.get('priority', 'NORMAL')
            if priority == 'URGENT':
                if "INJURY" in transfer.get('profile', '').upper() or "SUSPEND" in transfer.get('profile', '').upper():
                    urgency = "injury"
                else:
                    urgency = "urgent"

            # Check if transfer is marginal (low expected value)
            is_marginal = False
            if metrics["delta_pts_4gw"] is not None and metrics["delta_pts_4gw"] < 8:
                is_marginal = True

            paired_transfers.append({
                "out": out_player.get('name', 'Unknown'),
                "in": in_player.get('name', 'Unknown'),
                "hit_cost": metrics["hit_cost"],
                "net_cost": metrics["net_cost"],
                "delta_pts_4gw": metrics["delta_pts_4gw"],
                "delta_pts_6gw": metrics["delta_pts_6gw"],
                "reason": transfer.get('in_reason') or out_player.get('reason', 'Improves squad structure'),
                "confidence": confidence_level,
                "confidence_context": confidence_context,
                "priority": transfer.get('priority', 'NORMAL'),
                "profile": transfer.get('profile', ''),
                "urgency": urgency,
                "is_marginal": is_marginal,
                "alternatives": transfer.get('suggested_alternatives', [])  # Strategic alternatives (PREMIUM/VALUE/BALANCED)
            })

            # After first transfer, any subsequent would be a hit
            free_transfers = max(0, free_transfers - 1)

    # Also handle old format by pairing OUT and IN actions
    if not paired_transfers:
        out_actions = [t for t in transfer_recs if _get_action(t) == "OUT"]
        in_actions = [t for t in transfer_recs if _get_action(t) == "IN"]

        for i, (out_t, in_t) in enumerate(zip(out_actions, in_actions)):
            if hasattr(out_t, "__dict__"):
                out_t = out_t.__dict__
            if hasattr(in_t, "__dict__"):
                in_t = in_t.__dict__

            out_name = out_t.get("player_name") or out_t.get("player_out", "Unknown")
            in_name = in_t.get("player_name") or in_t.get("player_in", "Unknown")

            # Build player dicts for metrics calculation
            out_player = {"name": out_name, "price": out_t.get("price")}
            in_player = {
                "name": in_name,
                "price": in_t.get("price"),
                "expected_points": in_t.get("expected_pts") or in_t.get("expected_points")
            }

            metrics = _calculate_transfer_metrics(out_player, in_player, max(0, free_transfers - i))

            # Get confidence and context
            confidence_level, confidence_context = _map_transfer_confidence(
                in_t.get('priority', 'NORMAL'),
                in_t.get('profile', '')
            )

            # Check for urgency indicators
            urgency = None
            priority = in_t.get('priority', 'NORMAL')
            if priority == 'URGENT':
                if "INJURY" in in_t.get('profile', '').upper() or "SUSPEND" in in_t.get('profile', '').upper():
                    urgency = "injury"
                else:
                    urgency = "urgent"

            # Check if transfer is marginal
            delta = in_t.get("expected_pts") or in_t.get("expected_points") or 0
            is_marginal = delta < 8 if delta else False

            paired_transfers.append({
                "out": out_name,
                "in": in_name,
                "hit_cost": metrics["hit_cost"],
                "net_cost": metrics["net_cost"],
                "delta_pts_4gw": delta,
                "delta_pts_6gw": metrics["delta_pts_6gw"],
                "reason": in_t.get("reason") or out_t.get("reason", "Improves squad"),
                "confidence": confidence_level,
                "confidence_context": confidence_context,
                "priority": priority,
                "profile": in_t.get('profile', ''),
                "urgency": urgency,
                "is_marginal": is_marginal,
                "alternatives": []  # No alternatives in old format
            })

    # Assign to primary/secondary/additional
    if paired_transfers:
        plans["primary"] = paired_transfers[0]
        if len(paired_transfers) > 1:
            plans["secondary"] = paired_transfers[1]
        if len(paired_transfers) > 2:
            plans["additional"] = paired_transfers[2:]  # All remaining transfers
    else:
        plans["no_transfer_reason"] = "No transfer clears value thresholds this GW."

    return plans


def _get_action(transfer: Dict) -> str:
    """Extract action from transfer dict or object."""
    if hasattr(transfer, "__dict__"):
        transfer = transfer.__dict__
    return (transfer.get("action") or "").upper()


def _build_projected_squad(
    starting_xi: List[Dict],
    bench: List[Dict],
    transfer_plans: Dict[str, Any],
    manual_transfers: Optional[List[Dict]] = None
) -> Dict[str, Any]:
    """
    Build projected squad after applying manual transfers AND recommended transfers.

    Args:
        starting_xi: Current starting XI list
        bench: Current bench list
        transfer_plans: Dict with primary, secondary, and additional transfer plans
        manual_transfers: Optional list of manual transfers already made by user

    Returns:
        Dict with projected_xi and projected_bench after swapping transfers
    """
    if not starting_xi and not bench:
        return {"projected_xi": [], "projected_bench": []}

    # Collect all transfers (manual + primary + secondary + additional)
    all_transfers = []
    
    # Add manual transfers FIRST (these have already been made)
    if manual_transfers:
        for mt in manual_transfers:
            # Handle both field name conventions
            out_name = mt.get("out_name") or mt.get("player_out", "")
            in_name = mt.get("in_name") or mt.get("player_in", "")
            all_transfers.append({
                "out": out_name,
                "in": in_name,
                "delta_pts_4gw": 0,  # Unknown delta for manual transfers
                "net_cost": 0,
                "is_manual": True
            })
    
    # Add recommended transfers
    if transfer_plans.get("primary"):
        all_transfers.append(transfer_plans["primary"])
    if transfer_plans.get("secondary"):
        all_transfers.append(transfer_plans["secondary"])
    if transfer_plans.get("additional"):
        all_transfers.extend(transfer_plans["additional"])

    if not all_transfers:
        # No transfers - projected is same as current
        return {
            "projected_xi": starting_xi.copy() if starting_xi else [],
            "projected_bench": bench.copy() if bench else []
        }

    # Build lookup of OUT player names to IN player data
    swap_map = {}
    for transfer in all_transfers:
        out_name = transfer.get("out", "").lower()
        in_name = transfer.get("in", "Unknown")
        in_pts = transfer.get("delta_pts_4gw")  # We'll estimate next GW pts

        # Estimate the IN player's expected pts from the transfer data
        # delta = IN - OUT, so IN pts ≈ OUT pts + delta
        swap_map[out_name] = {
            "name": in_name,
            "delta_pts_4gw": in_pts,
            "net_cost": transfer.get("net_cost", 0)
        }

    # Apply swaps to starting XI
    projected_xi = []
    for player in (starting_xi or []):
        player_name = player.get("name", "").lower()
        if player_name in swap_map:
            # Swap this player
            swap_data = swap_map[player_name]
            new_player = player.copy()
            new_player["name"] = swap_data["name"]
            new_player["is_new"] = True  # Flag for frontend to highlight
            # Estimate new expected pts
            if swap_data["delta_pts_4gw"] and player.get("expected_pts"):
                # Rough estimate: add delta/4 to single GW expectation
                new_player["expected_pts"] = round(
                    player["expected_pts"] + (swap_data["delta_pts_4gw"] / 4), 1
                )
            projected_xi.append(new_player)
        else:
            projected_xi.append(player.copy())

    # Apply swaps to bench
    projected_bench = []
    for player in (bench or []):
        player_name = player.get("name", "").lower()
        if player_name in swap_map:
            swap_data = swap_map[player_name]
            new_player = player.copy()
            new_player["name"] = swap_data["name"]
            new_player["is_new"] = True
            if swap_data["delta_pts_4gw"] and player.get("expected_pts"):
                new_player["expected_pts"] = round(
                    player["expected_pts"] + (swap_data["delta_pts_4gw"] / 4), 1
                )
            projected_bench.append(new_player)
        else:
            projected_bench.append(player.copy())

    # Sort projected XI by expected points (highest first) for optimal lineup
    projected_xi.sort(key=lambda p: p.get("expected_pts", 0), reverse=True)

    return {
        "projected_xi": projected_xi,
        "projected_bench": projected_bench
    }


def _detect_bench_warning(
    projected_bench: List[Dict],
    transfer_plans: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """
    Detect if multiple transfers are being used primarily on bench upgrades.
    
    Warns when 2+ transfers land on bench, suggesting a measured approach
    and highlighting which transfers are highest priority.
    
    Args:
        projected_bench: List of players on bench after transfers
        transfer_plans: Dict with primary, secondary, and additional transfer plans
        
    Returns:
        Warning dict with strategic guidance if 2+ transfers on bench, None otherwise
    """
    if not projected_bench or not transfer_plans:
        return None
    
    # Collect all transfers with their priority
    all_transfers = []
    
    if transfer_plans.get("primary"):
        all_transfers.append({
            "transfer": transfer_plans["primary"],
            "priority_level": "PRIMARY",
            "in_name": transfer_plans["primary"].get("in", "").lower()
        })
    if transfer_plans.get("secondary"):
        all_transfers.append({
            "transfer": transfer_plans["secondary"],
            "priority_level": "BACKUP",
            "in_name": transfer_plans["secondary"].get("in", "").lower()
        })
    if transfer_plans.get("additional"):
        for i, transfer in enumerate(transfer_plans["additional"]):
            all_transfers.append({
                "transfer": transfer,
                "priority_level": "ADDITIONAL",
                "in_name": transfer.get("in", "").lower()
            })
    
    if not all_transfers:
        return None
    
    # Find which transferred-in players ended up on bench
    bench_transfers = []
    for transfer_info in all_transfers:
        in_name = transfer_info["in_name"]
        transfer = transfer_info["transfer"]
        
        # Check if this player is on the bench
        for player in projected_bench:
            player_name = player.get("name", "").lower()
            if player_name == in_name or (player.get("is_new") and player_name == in_name):
                expected_pts = player.get("expected_pts") or 0
                bench_transfers.append({
                    "name": player.get("name"),
                    "expected_pts": expected_pts,
                    "position": player.get("position", ""),
                    "priority_level": transfer_info["priority_level"],
                    "urgency": transfer.get("urgency")
                })
                break
    
    # Trigger warning if 2+ transfers landing on bench
    if len(bench_transfers) >= 2:
        avg_bench_pts = sum(p["expected_pts"] for p in bench_transfers) / len(bench_transfers)
        
        # Check if any are urgent (injury/suspension)
        has_urgent = any(p.get("urgency") in ["injury", "urgent"] for p in bench_transfers)
        
        return {
            "bench_count": len(bench_transfers),
            "bench_players": [p["name"] for p in bench_transfers],
            "avg_expected_pts": round(avg_bench_pts, 1),
            "has_urgent": has_urgent,
            "warning_message": f"{len(bench_transfers)} transfers landing on bench with {round(avg_bench_pts, 1)}pts/game value",
            "suggestion": "Measured approach: Consider taking 1-2 highest priority transfers and rolling the rest. Focus free transfers on Starting XI improvements for immediate gameweek impact.",
            "priority_signal": "PRIMARY transfer" if bench_transfers[0].get("priority_level") == "PRIMARY" else "Lower priority transfers"
        }
    
    return None


def transform_analysis_results(raw_results: Dict[str, Any], overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Transform the raw FPL Sage analysis output into a clean frontend format.
    
    Args:
        raw_results: Dict with keys: raw_data, analysis, config_used, capability_matrix
        overrides: Optional dict of manual overrides (chips, transfers, injuries)
        
    Returns:
        Clean dict optimized for frontend display
    """
    overrides = overrides or {}
    logger.info(f"Transforming results with keys: {list(raw_results.keys())}")
    
    # Extract components from the raw results
    analysis = raw_results.get("analysis", {})
    raw_data = raw_results.get("raw_data", {})
    
    logger.info(f"Analysis keys: {list(analysis.keys()) if isinstance(analysis, dict) else 'not a dict'}")
    
    # The decision is a DecisionOutput dataclass object
    decision = analysis.get("decision")
    my_team = raw_data.get("my_team", {})
    
    # Extract team info - check multiple possible locations
    team_info = my_team.get("team_info", {})
    manager_context = my_team.get("manager_context", {})
    
    # manager_context might be a string or dict
    if isinstance(manager_context, str):
        manager_name_str = manager_context
        manager_context = {}
    else:
        manager_name_str = manager_context.get("manager_name", "") if isinstance(manager_context, dict) else ""
    
    # Safe null checks for manager_context
    manager_ctx = manager_context if isinstance(manager_context, dict) else {}
    
    team_name = (
        team_info.get("team_name") or 
        manager_ctx.get("team_name") or \
        manager_ctx.get("name") or 
        "Unknown Team"
    )
    
    manager_name = (
        manager_name_str or
        manager_ctx.get("manager_name") or 
        f"{team_info.get('player_first_name', '')} {team_info.get('player_last_name', '')}".strip() or
        "Unknown Manager"
    )
    
    overall_rank = team_info.get("overall_rank") or manager_ctx.get("overall_rank")
    overall_points = team_info.get("total_points") or manager_ctx.get("total_points")
    
    current_gw = my_team.get("current_gameweek") or my_team.get("next_gameweek")
    
    # Get free transfers from overrides or my_team data
    free_transfers = overrides.get("free_transfers") or my_team.get("free_transfers")
    
    # Convert decision dataclass to dict if needed
    if hasattr(decision, "__dict__"):
        decision_dict = decision.__dict__
    else:
        decision_dict = decision if isinstance(decision, dict) else {}
    
    # Build transformed result
    result = {
        "team_name": team_name,
        "manager_name": manager_name,
        "current_gw": current_gw,
        "overall_rank": overall_rank,
        "overall_points": overall_points,
        "free_transfers": free_transfers,
        "risk_posture": decision_dict.get("risk_posture", "BALANCED"),
        "primary_decision": decision_dict.get("primary_decision", "Hold"),
        "decision_status": decision_dict.get("decision_status"),
        "confidence": _map_confidence(decision_dict.get("decision_status")),
        "reasoning": decision_dict.get("reasoning", ""),
    }
    
    # Captain and vice captain with delta calculation
    captaincy = decision_dict.get("captaincy", {})
    if captaincy:
        captain_raw = captaincy.get("captain")
        vice_raw = captaincy.get("vice_captain")

        result["captain"] = _transform_captain(captain_raw)
        result["vice_captain"] = _transform_captain(vice_raw)

        # Calculate and add captain delta
        captain_delta = _calculate_captain_delta(captain_raw, vice_raw)
        result["captain_delta"] = captain_delta

        # Enhance captain rationale with delta if available
        if result["captain"] and captain_delta.get("delta_pts") is not None:
            delta = captain_delta["delta_pts"]
            if delta > 0:
                delta_text = f"+{delta}pts vs vice captain"
            else:
                delta_text = f"{delta}pts vs vice captain"

            existing_rationale = result["captain"].get("rationale", "")
            if existing_rationale:
                result["captain"]["rationale"] = f"{existing_rationale} ({delta_text})"
            else:
                result["captain"]["rationale"] = f"Highest projected points ({delta_text})"

    # Calculate squad health
    squad_health = _calculate_squad_health(my_team, analysis)
    result["squad_health"] = squad_health
    
    # Transfer recommendations - handle both forced and optional
    transfer_recs = decision_dict.get("transfer_recommendations", [])
    logger.info(f"Transfer recs from decision_dict: {len(transfer_recs)} transfers")
    
    # CRITICAL: Filter out transfers that conflict with manual transfers
    manual_transfers = overrides.get("manual_transfers", [])
    if manual_transfers:
        # Handle both field name conventions:
        # - CLI uses: out_name/in_name
        # - Pydantic serialization uses: player_out/player_in
        manual_out_names = {
            (mt.get("out_name") or mt.get("player_out", "")).lower() 
            for mt in manual_transfers
        }
        manual_in_names = {
            (mt.get("in_name") or mt.get("player_in", "")).lower() 
            for mt in manual_transfers
        }
        
        # Remove recommended transfers that suggest transferring out players already transferred out
        # or transferring in players already transferred in
        filtered_recs = []
        for rec in transfer_recs:
            rec_dict = rec.__dict__ if hasattr(rec, "__dict__") else rec
            
            # Get out/in names from various possible structures
            out_name = ""
            in_name = ""
            if "transfer_out" in rec_dict:
                out_name = rec_dict.get("transfer_out", {}).get("name", "").lower()
            elif "out" in rec_dict:
                out_name = rec_dict.get("out", "").lower()
            
            if "transfer_in" in rec_dict:
                in_name = rec_dict.get("transfer_in", {}).get("name", "").lower()
            elif "in" in rec_dict:
                in_name = rec_dict.get("in", "").lower()
            
            # Skip if conflicts with manual transfers
            if out_name in manual_out_names:
                logger.warning(f"⚠️ Skipping recommended transfer out of '{out_name}' - already manually transferred out")
                continue
            if in_name in manual_in_names:
                logger.warning(f"⚠️ Skipping recommended transfer in of '{in_name}' - already manually transferred in")
                continue
            
            filtered_recs.append(rec)
        
        if len(filtered_recs) < len(transfer_recs):
            logger.warning(f"🚫 Filtered {len(transfer_recs) - len(filtered_recs)} transfer recs that conflicted with manual transfers")
        transfer_recs = filtered_recs
    
    # CRITICAL: Apply risk-aware filtering based on user's risk posture
    risk_posture = decision_dict.get("risk_posture", "BALANCED")
    logger.warning(f"🔍 DEBUG: decision_dict keys: {list(decision_dict.keys())}")
    logger.warning(f"🔍 DEBUG: risk_posture from decision_dict: {risk_posture}")
    logger.warning(f"🔍 DEBUG: overrides passed to transformer: {overrides}")
    if transfer_recs:
        original_count = len(transfer_recs)
        transfer_recs = filter_transfers_by_risk(transfer_recs, risk_posture)
        logger.warning(f"🎯 Risk filtering ({risk_posture}): {original_count} → {len(transfer_recs)} recommendations")
        
        logger.info(f"First transfer sample: {transfer_recs[0] if transfer_recs else 'None'}")
        result["transfer_recommendations"] = _transform_transfers(transfer_recs)
        logger.info(f"After transformation: {len(result['transfer_recommendations'])} transfer actions")
        result["forced_transfers"] = [t for t in result["transfer_recommendations"] if t.get("priority") == "URGENT"]
        result["optional_transfers"] = [t for t in result["transfer_recommendations"] if t.get("priority") != "URGENT"]

        # Build transfer plans with calculated metrics for frontend consumption
        transfer_plans = _build_transfer_plans(transfer_recs, free_transfers or 1)
        result["transfer_plans"] = transfer_plans
    else:
        logger.warning("NO transfer_recommendations found in decision_dict!")
        result["transfer_plans"] = {"primary": None, "secondary": None, "no_transfer_reason": "No transfer clears value thresholds this GW."}
    
    # Chip guidance - handle both dict and dataclass (ChipDecisionContext)
    chip_guidance = decision_dict.get("chip_guidance", {})
    if chip_guidance:
        # Convert dataclass to dict if needed
        if hasattr(chip_guidance, "__dict__") and not isinstance(chip_guidance, dict):
            chip_guidance_dict = chip_guidance.__dict__
        elif isinstance(chip_guidance, dict):
            chip_guidance_dict = chip_guidance
        else:
            chip_guidance_dict = {}

        # Calculate opportunity cost if available
        opportunity_cost = None
        best_gw = chip_guidance_dict.get("next_optimal_window")
        current_score = chip_guidance_dict.get("current_window_score")
        best_score = chip_guidance_dict.get("best_future_window_score")

        if current_score is not None and best_score is not None and best_score > current_score:
            opportunity_cost = {
                "current_value": round(current_score, 1),
                "best_value": round(best_score, 1),
                "best_gw": best_gw,
                "delta": round(best_score - current_score, 1)
            }

        result["chip_recommendation"] = {
            "recommendation": chip_guidance_dict.get("recommendation", "SAVE"),
            "rationale": chip_guidance_dict.get("rationale", ""),
            "timing": chip_guidance_dict.get("timing"),
            "opportunity_cost": opportunity_cost,
            "best_gw": best_gw,
            "current_window_name": chip_guidance_dict.get("current_window_name"),
            "best_future_window_name": chip_guidance_dict.get("best_future_window_name"),
        }
    
    # Chip status from my_team
    chip_status = my_team.get("chip_status", {})
    result["available_chips"] = [name for name, used in chip_status.items() if not used] if chip_status else []
    result["active_chip"] = my_team.get("active_chip")
    
    # Risk scenarios
    risk_scenarios = decision_dict.get("risk_scenarios", [])
    if risk_scenarios:
        transformed_risks = []
        for rs in risk_scenarios:
            # Handle both dict and dataclass objects
            if hasattr(rs, "__dict__"):
                rs_dict = rs.__dict__
            elif isinstance(rs, dict):
                rs_dict = rs
            else:
                continue
            
            transformed_risks.append({
                "scenario": rs_dict.get("scenario", ""),
                "severity": rs_dict.get("severity", ""),
                "mitigation": rs_dict.get("mitigation", ""),
            })
        result["risk_scenarios"] = transformed_risks
    
    # Add projections if available
    projections = analysis.get("projections")
    if projections:
        logger.info(f"Found projections with {len(projections.projections) if hasattr(projections, 'projections') else 0} players")
        result["projections"] = projections
    else:
        logger.warning("No projections found in analysis results")
    
    # Add optimized XI if available
    optimized_xi = analysis.get("optimized_xi")
    if optimized_xi:
        logger.info("Found optimized XI")
        # Convert optimized XI to projection lists
        if hasattr(optimized_xi, 'starting_xi'):
            result["starting_xi"] = [_transform_projection(p) for p in optimized_xi.starting_xi]
        if hasattr(optimized_xi, 'bench'):
            result["bench"] = [_transform_projection(p) for p in optimized_xi.bench]
        
        # Build projected squad after transfers (manual + recommended)
        # Extract manual transfers from overrides if provided
        manual_transfers = overrides.get("manual_transfers", [])
        
        if result.get("transfer_plans") or manual_transfers:
            projected = _build_projected_squad(
                result.get("starting_xi", []),
                result.get("bench", []),
                result.get("transfer_plans", {}),
                manual_transfers
            )
            result["projected_xi"] = projected["projected_xi"]
            result["projected_bench"] = projected["projected_bench"]
            
            logger.warning("🔍 BENCH DEBUG: About to check bench warning")
            logger.warning(f"🔍 BENCH DEBUG: transfer_plans exists = {bool(result.get('transfer_plans'))}")
            logger.warning(f"🔍 BENCH DEBUG: transfer_plans.primary = {result.get('transfer_plans', {}).get('primary')}")
            
            # Detect bench warning if we have transfers
            if result.get("transfer_plans", {}).get("primary"):
                logger.warning("🔍 BENCH DEBUG: Checking for bench warning")
                logger.warning(f"🔍 BENCH DEBUG: projected_bench = {projected['projected_bench']}")
                logger.warning(f"🔍 BENCH DEBUG: transfer_plans = {result.get('transfer_plans', {})}")
                bench_warning = _detect_bench_warning(
                    projected["projected_bench"],
                    result.get("transfer_plans", {})
                )
                logger.warning(f"🔍 BENCH DEBUG: bench_warning result = {bench_warning}")
                if bench_warning:
                    result["bench_warning"] = bench_warning
                    logger.warning(f"⚠️ Bench warning: {bench_warning['warning_message']}")
    
    logger.info(f"Transformed result keys: {list(result.keys())}")
    
    return result


def _transform_projection(proj) -> Dict[str, Any]:
    """Transform a CanonicalPlayerProjection to dict."""
    if hasattr(proj, "__dict__"):
        return {
            "name": proj.name,
            "team": proj.team,
            "position": proj.position,
            "price": proj.current_price,
            "expected_pts": proj.nextGW_pts,
            "ownership": proj.ownership_pct,
            "form": proj.next6_pts / 6,  # Approximate form from 6-week projection
            "fixture_difficulty": proj.fixture_difficulty if hasattr(proj, 'fixture_difficulty') else None,
        }
    return proj


def _map_confidence(decision_status: Optional[str]) -> str:
    """Map decision status to confidence level."""
    mapping = {
        "PASS": "High",
        "HOLD": "Medium",
        "BLOCKED": "Low"
    }
    return mapping.get(decision_status or "", "Medium")


def _calculate_ownership_insight(ownership_pct: Optional[float]) -> Optional[str]:
    """
    Calculate ownership leverage insight for captain picks.

    Args:
        ownership_pct: Player ownership percentage (0-100)

    Returns:
        Insight string describing the ownership leverage angle
    """
    if ownership_pct is None:
        return None

    if ownership_pct < 10:
        return "Huge differential - high risk, high reward"
    elif ownership_pct < 30:
        return "Quality differential option"
    elif ownership_pct < 60:
        return "Balanced ownership"
    elif ownership_pct < 80:
        return "Template pick - safe floor"
    else:
        return "Essential - avoid mass rank drops"


def _transform_captain(captain_data: Optional[Dict]) -> Optional[Dict[str, Any]]:
    """Transform captain data to frontend format with fixture and ownership context."""
    if not captain_data:
        return None

    # Extract ownership and form data
    ownership_pct = captain_data.get("ownership_pct") or captain_data.get("selected_by_percent")
    next6_pts = captain_data.get("next6_pts")

    # Calculate form indicator (average pts per game over next 6)
    form_avg = round(next6_pts / 6, 1) if next6_pts else None

    # Get ownership insight
    ownership_insight = _calculate_ownership_insight(ownership_pct)

    return {
        "name": captain_data.get("name", "Unknown"),
        "team": captain_data.get("team", ""),
        "position": captain_data.get("position", ""),
        "expected_pts": captain_data.get("expected_pts") or captain_data.get("nextGW_pts", 0),
        "rationale": captain_data.get("rationale", ""),
        "ownership_pct": ownership_pct,
        "ownership_insight": ownership_insight,
        "form_avg": form_avg,
        "fixture_difficulty": captain_data.get("fixture_difficulty"),  # Will be None if not available
    }


def _transform_transfers(transfers: List[Dict]) -> List[Dict[str, Any]]:
    """Transform transfer recommendations to frontend format."""
    result = []
    for transfer in transfers:
        # Handle both dict and object attributes
        if hasattr(transfer, "__dict__"):
            transfer = transfer.__dict__
        
        # Check if this is the new structured format with transfer_out/transfer_in
        if 'transfer_out' in transfer and 'transfer_in' in transfer:
            out = transfer['transfer_out']
            in_player = transfer['transfer_in']
            
            # Create OUT action
            result.append({
                "action": "OUT",
                "player_out": out['name'],
                "player_in": "",
                "player_name": out['name'],
                "position": out.get('position', ''),
                "team": out.get('team', ''),
                "price": out.get('price'),
                "reason": out.get('reason', ''),
                "profile": transfer.get('profile', ''),
                "expected_pts": 0,
                "priority": transfer.get('priority', 'NORMAL'),
            })
            
            # Create IN action
            in_reason = transfer.get('in_reason', '')
            result.append({
                "action": "IN",
                "player_out": "",
                "player_in": in_player['name'],
                "player_name": in_player['name'],
                "position": in_player.get('position', ''),
                "team": in_player.get('team', ''),
                "price": in_player.get('price'),
                "reason": in_reason,
                "profile": transfer.get('profile', ''),
                "expected_pts": in_player.get('expected_points', 0),
                "priority": transfer.get('priority', 'NORMAL'),
            })
        else:
            # Fall back to old format for backward compatibility
            player = transfer.get("player_name") or transfer.get("player_out") or transfer.get("player_in", "")
            action = transfer.get("action", "")
            
            result.append({
                "action": action,
                "player_out": player if action == "OUT" else "",
                "player_in": player if action == "IN" else "",
                "player_name": player,
                "position": transfer.get("position", ""),
                "team": transfer.get("team", ""),
                "price": transfer.get("price"),
                "reason": transfer.get("reason", ""),
                "profile": transfer.get("profile", ""),
                "expected_pts": transfer.get("expected_points") or transfer.get("expected_pts"),
                "priority": transfer.get("priority", "NORMAL"),
            })
    return result
