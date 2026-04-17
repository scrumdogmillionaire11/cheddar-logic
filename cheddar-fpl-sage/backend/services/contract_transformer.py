"""
Transform internal analysis artifacts into Cheddar integration contracts.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional


STATUS_MAP = {
    "queued": "queued",
    "running": "analyzing",
    "analyzing": "analyzing",
    "completed": "complete",
    "complete": "complete",
    "failed": "failed",
}

CONFIDENCE_MAP = {
    "urgent": 0.92,
    "high": 0.88,
    "medium": 0.75,
    "low": 0.6,
}


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    return value.isoformat()


def _normalize_status(status: Optional[str]) -> str:
    if not status:
        return "queued"
    return STATUS_MAP.get(status.lower(), "queued")


def _confidence_from_priority(priority: str) -> float:
    return CONFIDENCE_MAP.get(priority.lower(), 0.7)


def _extract_expected_points(value: Dict[str, Any]) -> Optional[float]:
    for key in ("expected_points", "expected_pts"):
        raw = value.get(key)
        if raw is not None:
            try:
                return float(raw)
            except (TypeError, ValueError):
                return None
    return None


def _card_payload(results: Dict[str, Any], card_key: str) -> Dict[str, Any]:
    card = results.get(card_key)
    if isinstance(card, dict):
        return card
    return {}


def _card_metrics(results: Dict[str, Any], card_key: str) -> Dict[str, Any]:
    metrics = _card_payload(results, card_key).get("metrics")
    return metrics if isinstance(metrics, dict) else {}


def _card_summary(results: Dict[str, Any], card_key: str) -> str:
    summary = _card_payload(results, card_key).get("summary")
    return str(summary) if summary is not None else ""


def _plan_priority(plan: Dict[str, Any], fallback: str = "MEDIUM") -> str:
    confidence = str(plan.get("confidence") or fallback).upper()
    if confidence in {"HIGH", "URGENT", "MEDIUM", "LOW"}:
        return "URGENT" if confidence == "HIGH" else confidence
    return fallback


def _append_transfer_pair(
    recommendations: List[Dict[str, Any]],
    plan: Dict[str, Any],
    plan_id: str,
) -> None:
    out_name = plan.get("out")
    in_name = plan.get("in")
    if not out_name or not in_name:
        return

    priority = _plan_priority(plan)
    gain = plan.get("delta_pts_4gw")
    confidence = float(plan.get("confidence_score") or _confidence_from_priority(priority))

    recommendations.append(
        {
            "id": f"{plan_id}_out",
            "action": "remove",
            "player_id": None,
            "player_name": out_name,
            "position": None,
            "reason": plan.get("reason") or "",
            "priority": priority,
            "confidence": confidence,
            "current_price": plan.get("net_cost"),
            "expected_points_gained": gain,
        }
    )
    recommendations.append(
        {
            "id": f"{plan_id}_in",
            "action": "add",
            "player_id": None,
            "player_name": in_name,
            "position": None,
            "reason": plan.get("reason") or "",
            "priority": priority,
            "confidence": confidence,
            "price": plan.get("net_cost"),
            "expected_points": gain,
            "expected_points_gained": gain,
        }
    )


def _build_transfer_recommendations(results: Dict[str, Any]) -> List[Dict[str, Any]]:
    transfer_metrics = _card_metrics(results, "transfer_recommendation")
    plans = transfer_metrics.get("transfer_plans")
    recommendations: List[Dict[str, Any]] = []

    if isinstance(plans, dict):
        primary = plans.get("primary")
        if isinstance(primary, dict):
            _append_transfer_pair(recommendations, primary, "transfer_primary")

        secondary = plans.get("secondary")
        if isinstance(secondary, dict):
            _append_transfer_pair(recommendations, secondary, "transfer_secondary")

        additional = plans.get("additional") or []
        if isinstance(additional, list):
            for index, plan in enumerate(additional, start=1):
                if isinstance(plan, dict):
                    _append_transfer_pair(recommendations, plan, f"transfer_additional_{index:02d}")

    if recommendations:
        return recommendations

    # Compatibility fallback: use pre-transformed transfer list if canonical plans are unavailable.
    transfer_recs = results.get("transfer_recommendations") or []
    for index, transfer in enumerate(transfer_recs, start=1):
        action_raw = str(transfer.get("action", "")).upper()
        action = "remove" if action_raw == "OUT" else "add" if action_raw == "IN" else str(transfer.get("action", "add")).lower()
        priority = str(transfer.get("priority", "MEDIUM")).upper()
        player_name = transfer.get("player_name") or transfer.get("player_out") or transfer.get("player_in") or "Unknown"
        recommendation: Dict[str, Any] = {
            "id": f"transfer_{index:03d}",
            "action": action,
            "player_id": transfer.get("player_id"),
            "player_name": player_name,
            "position": transfer.get("position"),
            "reason": transfer.get("reason") or "",
            "priority": priority,
            "confidence": float(transfer.get("confidence") or _confidence_from_priority(priority)),
        }
        if action == "remove":
            recommendation["current_price"] = transfer.get("price")
            recommendation["expected_points_gained"] = transfer.get("expected_points_gained")
        else:
            recommendation["price"] = transfer.get("price")
            recommendation["expected_points"] = _extract_expected_points(transfer)
            recommendation["expected_points_gained"] = transfer.get("expected_points_gained")
        recommendations.append(recommendation)
    return recommendations


def _build_chip_strategy(results: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    chip_metrics = _card_metrics(results, "chip_strategy")
    recommendation_meta = chip_metrics.get("recommendation")
    if not isinstance(recommendation_meta, dict):
        recommendation_meta = results.get("chip_recommendation") if isinstance(results.get("chip_recommendation"), dict) else {}

    available_chips = set(chip_metrics.get("available_chips") or results.get("available_chips") or [])
    verdict = str(chip_metrics.get("verdict") or recommendation_meta.get("chip") or results.get("chip_verdict") or "NONE").upper()
    rationale = chip_metrics.get("explanation") or _card_summary(results, "chip_strategy") or recommendation_meta.get("narrative") or recommendation_meta.get("rationale") or ""
    best_gw = recommendation_meta.get("best_gw")
    opportunity_cost = recommendation_meta.get("opportunity_cost") or {}

    use_bb = verdict == "BB"
    use_tc = verdict == "TC"
    use_fh = verdict == "FH"

    chips: Dict[str, Dict[str, Any]] = {
        "bench_boost": {
            "recommended": use_bb,
            "rationale": rationale,
            "available": "bench_boost" in available_chips,
            "best_window_gw": best_gw,
            "current_window_value": opportunity_cost.get("current_value"),
            "best_window_value": opportunity_cost.get("best_value"),
        },
        "triple_captain": {
            "recommended": use_tc,
            "rationale": rationale,
            "available": "triple_captain" in available_chips,
            "best_window_gw": best_gw,
            "best_player": (_card_metrics(results, "captaincy").get("captain") or results.get("captain") or {}).get("name"),
            "expected_boost": opportunity_cost.get("delta"),
        },
        "free_hit": {
            "recommended": use_fh,
            "rationale": rationale,
            "available": "free_hit" in available_chips,
            "best_window_gw": best_gw,
        },
    }
    return chips


def _build_captain_recommendation(results: Dict[str, Any]) -> Dict[str, Any]:
    captain_metrics = _card_metrics(results, "captaincy")
    primary = captain_metrics.get("captain") if isinstance(captain_metrics.get("captain"), dict) else (results.get("captain") or {})
    vice = captain_metrics.get("vice_captain") if isinstance(captain_metrics.get("vice_captain"), dict) else (results.get("vice_captain") or {})
    return {
        "primary": {
            "player_id": primary.get("player_id"),
            "player_name": primary.get("name"),
            "expected_points": _extract_expected_points(primary),
            "ownership": primary.get("ownership_pct"),
            "form": primary.get("form_avg"),
            "fixture": primary.get("fixture"),
            "fixture_difficulty": primary.get("fixture_difficulty"),
            "confidence": primary.get("confidence") or 0.85,
            "rationale": primary.get("rationale"),
        },
        "vice": {
            "player_id": vice.get("player_id"),
            "player_name": vice.get("name"),
            "expected_points": _extract_expected_points(vice),
            "ownership": vice.get("ownership_pct"),
            "form": vice.get("form_avg"),
            "fixture": vice.get("fixture"),
            "fixture_difficulty": vice.get("fixture_difficulty"),
            "confidence": vice.get("confidence") or 0.75,
            "rationale": vice.get("rationale"),
        },
    }


def _build_team_weaknesses(results: Dict[str, Any]) -> List[Dict[str, Any]]:
    weaknesses: List[Dict[str, Any]] = []
    squad_metrics = _card_metrics(results, "squad_state")
    squad_health = squad_metrics.get("squad_health") if isinstance(squad_metrics.get("squad_health"), dict) else (results.get("squad_health") or {})
    injured = int(squad_health.get("injured", 0) or 0)
    doubtful = int(squad_health.get("doubtful", 0) or 0)
    if injured > 0:
        weaknesses.append(
            {
                "weakness": "injury_load",
                "description": f"{injured} players currently unavailable",
                "affected_player_ids": [],
                "severity": "HIGH" if injured >= 2 else "MEDIUM",
            }
        )
    if doubtful > 0:
        weaknesses.append(
            {
                "weakness": "injury_uncertainty",
                "description": f"{doubtful} players flagged as doubtful",
                "affected_player_ids": [],
                "severity": "MEDIUM",
            }
        )
    bench_warning = squad_metrics.get("bench_warning") if isinstance(squad_metrics.get("bench_warning"), dict) else (results.get("bench_warning") or {})
    if bench_warning:
        weaknesses.append(
            {
                "weakness": "bench_depth_risk",
                "description": bench_warning.get("warning_message") or "Bench depth below target",
                "affected_player_ids": [],
                "severity": "MEDIUM",
            }
        )
    return weaknesses


def _build_risk_flags(results: Dict[str, Any]) -> List[Dict[str, Any]]:
    risk_flags: List[Dict[str, Any]] = []
    for item in results.get("risk_scenarios") or []:
        scenario = item.get("scenario") or "unknown_risk"
        risk_flags.append(
            {
                "flag": scenario,
                "player_id": item.get("player_id"),
                "player_name": item.get("player_name"),
                "description": item.get("severity") or scenario,
                "mitigation": item.get("mitigation"),
            }
        )

    weekly_review_metrics = _card_metrics(results, "weekly_review")
    drift_flags = weekly_review_metrics.get("drift_flags")
    if isinstance(drift_flags, list):
        for drift in drift_flags:
            token = str(drift or "").strip()
            if token:
                risk_flags.append(
                    {
                        "flag": token,
                        "player_id": None,
                        "player_name": None,
                        "description": f"Retrospective drift signal: {token}",
                        "mitigation": None,
                    }
                )
    return risk_flags


def _summary_confidence(results: Dict[str, Any]) -> float:
    confidence_card = results.get("decision_confidence")
    if isinstance(confidence_card, dict):
        score = confidence_card.get("score")
        try:
            if score is not None:
                return round(float(score) / 100.0, 4)
        except (TypeError, ValueError):
            pass

    confidence_text = str(results.get("confidence", "MEDIUM")).lower()
    if "high" in confidence_text:
        return 0.9
    if "low" in confidence_text:
        return 0.65
    return 0.78


def build_detailed_analysis_contract(job: Any) -> Dict[str, Any]:
    """Build detailed analysis response from a persisted job object."""
    raw_status = str(getattr(job, "status", "queued")).lower()
    normalized_status = _normalize_status(raw_status)
    response_status = "completed" if raw_status == "completed" else normalized_status
    results = getattr(job, "results", None) or {}
    gameweek_plan_metrics = _card_metrics(results, "gameweek_plan")
    squad_metrics = _card_metrics(results, "squad_state")
    transfer_recommendations = _build_transfer_recommendations(results)
    urgent_count = sum(1 for rec in transfer_recommendations if rec.get("priority") == "URGENT")
    expected_improvement = sum(float(rec.get("expected_points_gained") or 0) for rec in transfer_recommendations)
    health_pct = float((results.get("squad_health") or {}).get("health_pct", 0) or 0)

    payload: Dict[str, Any] = {
        "analysis_id": getattr(job, "analysis_id"),
        "team_id": getattr(job, "team_id", None),
        "status": response_status,
        "created_at": _iso(getattr(job, "created_at", None)),
        "completed_at": _iso(getattr(job, "completed_at", None)),
        "gameweek": gameweek_plan_metrics.get("gameweek") or results.get("current_gw"),
        "season": results.get("season", "2025-26"),
        "results": results,
        "strategy_mode": gameweek_plan_metrics.get("strategy_mode") or squad_metrics.get("strategy_mode") or results.get("strategy_mode"),
        "manager_state": results.get("manager_state"),
        "near_threshold_moves": results.get("near_threshold_moves") or [],
        "strategy_paths": results.get("strategy_paths") or {},
        "squad_issues": results.get("squad_issues") or [],
        "chip_timing_outlook": results.get("chip_timing_outlook"),
        "fixture_planner": results.get("fixture_planner"),
        "transfer_recommendations": transfer_recommendations,
        "chip_strategy": _build_chip_strategy(results),
        "captain_recommendation": _build_captain_recommendation(results),
        "team_weaknesses": _build_team_weaknesses(results),
        "risk_flags": _build_risk_flags(results),
        "summary": {
            "total_transfers_recommended": len(transfer_recommendations),
            "urgent_transfers": urgent_count,
            "expected_team_points_improvement": round(expected_improvement, 2),
            "overall_team_health": "good" if health_pct >= 75 else "fragile",
            "readiness_for_deadline": "ready" if normalized_status == "complete" else "processing",
            "confidence_score": _summary_confidence(results),
        },
    }
    if normalized_status == "failed":
        payload["error"] = getattr(job, "error", "Analysis failed")
    return payload


def build_dashboard_contract(detailed_payload: Dict[str, Any]) -> Dict[str, Any]:
    """Build simplified dashboard response from the detailed payload."""
    transfers = detailed_payload.get("transfer_recommendations") or []
    quick_actions: List[Dict[str, Any]] = []
    outs = [rec for rec in transfers if rec.get("action") == "remove"]
    ins = [rec for rec in transfers if rec.get("action") == "add"]
    pair_count = min(len(outs), len(ins))
    for i in range(pair_count):
        quick_actions.append(
            {
                "action": "transfer",
                "priority": outs[i].get("priority") or ins[i].get("priority"),
                "from_player": outs[i].get("player_name"),
                "to_player": ins[i].get("player_name"),
                "gain": ins[i].get("expected_points_gained") or outs[i].get("expected_points_gained"),
            }
        )

    chip_strategy = detailed_payload.get("chip_strategy") or {}
    chips = {
        "bench_boost": "use" if chip_strategy.get("bench_boost", {}).get("recommended") else ("save" if chip_strategy.get("bench_boost", {}).get("available") else "not_available"),
        "triple_captain": "use" if chip_strategy.get("triple_captain", {}).get("recommended") else ("save" if chip_strategy.get("triple_captain", {}).get("available") else "not_available"),
        "free_hit": "use" if chip_strategy.get("free_hit", {}).get("recommended") else ("save" if chip_strategy.get("free_hit", {}).get("available") else "not_available"),
    }

    captain_primary = (detailed_payload.get("captain_recommendation") or {}).get("primary", {})
    return {
        "analysis_id": detailed_payload.get("analysis_id"),
        "team_id": detailed_payload.get("team_id"),
        "status": detailed_payload.get("status"),
        "gameweek": detailed_payload.get("gameweek"),
        "quick_actions": quick_actions,
        "captain": {
            "player": captain_primary.get("player_name"),
            "expected_points": captain_primary.get("expected_points"),
            "confidence": captain_primary.get("confidence"),
        },
        "chips": chips,
        "health_score": detailed_payload.get("summary", {}).get("confidence_score"),
        "key_risks": [risk.get("flag") for risk in (detailed_payload.get("risk_flags") or []) if risk.get("flag")],
    }
