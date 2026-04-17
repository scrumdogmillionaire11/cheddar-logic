"""Weekly review service for retrospective payload + receipt outcome persistence.

Builds a null-safe weekly review card and applies retrospective evaluation to
stored decision receipts when previous-GW history is available.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from backend.models.product_models import DecisionReceipt
from backend.services.product_store import product_store


def _to_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _to_bool(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "y"}:
            return True
        if lowered in {"false", "0", "no", "n"}:
            return False
    return None


def _norm_token(value: Any) -> Optional[str]:
    if value is None:
        return None
    token = str(value).strip().lower()
    return token or None


def _extract_history_rows(raw_results: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw_data = raw_results.get("raw_data") if isinstance(raw_results, dict) else {}
    if not isinstance(raw_data, dict):
        raw_data = {}

    my_team = raw_data.get("my_team") if isinstance(raw_data.get("my_team"), dict) else {}

    candidates = [
        my_team.get("history_current"),
        my_team.get("history"),
        raw_data.get("history_current"),
        raw_data.get("history"),
    ]

    for rows in candidates:
        if isinstance(rows, list) and rows:
            return [row for row in rows if isinstance(row, dict)]
    return []


def _history_row_for_event(rows: List[Dict[str, Any]], event_id: int) -> Optional[Dict[str, Any]]:
    for row in rows:
        if _to_int(row.get("event")) == event_id:
            return row
    return None


@dataclass
class ReviewComputation:
    previous_gw: Optional[int]
    points: Optional[int]
    points_delta: Optional[int]
    rank: Optional[int]
    rank_delta: Optional[int]
    history_available: bool


class WeeklyReviewService:
    """Computes weekly retrospective review and persists receipt outcomes."""

    @staticmethod
    def default_review_card() -> Dict[str, Any]:
        return {
            "version": "v1",
            "summary": "No prior gameweek history available yet.",
            "highlights": [
                "Retrospective review will populate after at least one completed gameweek.",
            ],
            "metrics": {
                "previous_gw": None,
                "points": None,
                "points_delta": None,
                "rank": None,
                "rank_delta": None,
                "captain_followed": None,
                "recommendation_followed": None,
                "process_verdict": None,
                "drift_flags": [],
                "history_available": False,
                "updated_receipts": 0,
            },
        }

    def _compute_review(self, raw_results: Dict[str, Any], transformed_results: Dict[str, Any]) -> ReviewComputation:
        raw_data = raw_results.get("raw_data") if isinstance(raw_results, dict) else {}
        if not isinstance(raw_data, dict):
            raw_data = {}
        my_team = raw_data.get("my_team") if isinstance(raw_data.get("my_team"), dict) else {}

        current_gw = _to_int(my_team.get("current_gameweek") or transformed_results.get("current_gw") or raw_data.get("current_gameweek"))
        if current_gw is None or current_gw <= 1:
            return ReviewComputation(None, None, None, None, None, False)

        rows = _extract_history_rows(raw_results)
        previous_gw = current_gw - 1
        previous_row = _history_row_for_event(rows, previous_gw)
        current_row = _history_row_for_event(rows, current_gw)

        if not previous_row:
            return ReviewComputation(previous_gw, None, None, None, None, False)

        prev_points = _to_int(previous_row.get("points") or previous_row.get("event_points"))
        prev_rank = _to_int(previous_row.get("overall_rank") or previous_row.get("rank"))

        if current_row:
            curr_points = _to_int(current_row.get("points") or current_row.get("event_points"))
            curr_rank = _to_int(current_row.get("overall_rank") or current_row.get("rank"))
            points_delta = (curr_points - prev_points) if (curr_points is not None and prev_points is not None) else None
            rank_delta = (curr_rank - prev_rank) if (curr_rank is not None and prev_rank is not None) else None
            return ReviewComputation(previous_gw, prev_points, points_delta, prev_rank, rank_delta, True)

        # Null-safe fallback when current row not present yet: show previous GW values.
        return ReviewComputation(previous_gw, prev_points, None, prev_rank, None, True)

    @staticmethod
    def _infer_outcome(receipt: DecisionReceipt) -> Optional[str]:
        if receipt.outcome is not None:
            return receipt.outcome

        if not isinstance(receipt.payload, dict) or not isinstance(receipt.user_choice, dict):
            return None

        recommended = (
            _norm_token(receipt.payload.get("recommended"))
            or _norm_token(receipt.payload.get("player"))
            or _norm_token(receipt.payload.get("captain"))
            or _norm_token(receipt.payload.get("in"))
            or _norm_token(receipt.payload.get("target"))
        )
        chosen = (
            _norm_token(receipt.user_choice.get("selected"))
            or _norm_token(receipt.user_choice.get("player"))
            or _norm_token(receipt.user_choice.get("captain"))
            or _norm_token(receipt.user_choice.get("in"))
            or _norm_token(receipt.user_choice.get("target"))
        )

        if recommended is None or chosen is None:
            return None
        if recommended == chosen:
            return "followed"
        return "ignored"

    @staticmethod
    def _infer_process_verdict(
        existing: Optional[str],
        inferred_outcome: Optional[str],
        points_delta: Optional[int],
        rank_delta: Optional[int],
    ) -> Optional[str]:
        if existing is not None:
            return existing
        if inferred_outcome == "followed":
            return "good_process"
        if inferred_outcome == "ignored":
            if (points_delta is not None and points_delta < 0) or (rank_delta is not None and rank_delta > 0):
                return "bad_process"
            return "good_process"
        if (points_delta is not None and points_delta < 0) and (rank_delta is not None and rank_delta > 0):
            return "bad_process"
        return None

    @staticmethod
    def _merge_drift_flags(
        existing_flags: List[str],
        outcome: Optional[str],
        process_verdict: Optional[str],
        points_delta: Optional[int],
        rank_delta: Optional[int],
    ) -> List[str]:
        merged = list(existing_flags or [])
        if outcome == "ignored" and "recommendation_ignored" not in merged:
            merged.append("recommendation_ignored")
        if process_verdict == "bad_process" and "bad_process" not in merged:
            merged.append("bad_process")
        if points_delta is not None and points_delta < 0 and "points_drop" not in merged:
            merged.append("points_drop")
        if rank_delta is not None and rank_delta > 0 and "rank_drop" not in merged:
            merged.append("rank_drop")
        return merged

    def _persist_receipt_outcomes(
        self,
        manager_id: str,
        points_delta: Optional[int],
        rank_delta: Optional[int],
        history_available: bool,
    ) -> Dict[str, Any]:
        receipts = product_store.list_receipts(manager_id=manager_id)
        updated = 0

        if not history_available:
            return {
                "updated": 0,
                "captain_followed": None,
                "recommendation_followed": None,
                "process_verdict": None,
                "drift_flags": [],
            }

        for receipt in receipts:
            inferred_outcome = self._infer_outcome(receipt)
            inferred_verdict = self._infer_process_verdict(
                receipt.process_verdict,
                inferred_outcome,
                points_delta,
                rank_delta,
            )

            next_outcome = receipt.outcome if receipt.outcome is not None else inferred_outcome
            next_process_verdict = (
                receipt.process_verdict if receipt.process_verdict is not None else inferred_verdict
            )
            next_drift_flags = self._merge_drift_flags(
                receipt.drift_flags,
                next_outcome,
                next_process_verdict,
                points_delta,
                rank_delta,
            )

            if (
                next_outcome != receipt.outcome
                or next_process_verdict != receipt.process_verdict
                or next_drift_flags != receipt.drift_flags
            ):
                receipt.outcome = next_outcome
                receipt.process_verdict = next_process_verdict
                receipt.drift_flags = next_drift_flags
                product_store.save_receipt(receipt)
                updated += 1

        captain_receipts = [r for r in product_store.list_receipts(manager_id=manager_id) if r.decision_type == "captain"]
        recommendation_receipts = [
            r for r in product_store.list_receipts(manager_id=manager_id)
            if r.decision_type in {"transfer", "captain", "chip", "formation"}
        ]

        captain_followed_values = [r.outcome == "followed" for r in captain_receipts if r.outcome is not None]
        recommendation_followed_values = [
            r.outcome in {"followed", "partial"}
            for r in recommendation_receipts
            if r.outcome is not None
        ]

        all_receipts = product_store.list_receipts(manager_id=manager_id)
        all_drift_flags: List[str] = []
        for r in all_receipts:
            for flag in r.drift_flags:
                if flag not in all_drift_flags:
                    all_drift_flags.append(flag)

        process_verdict = None
        if any(r.process_verdict == "bad_process" for r in all_receipts):
            process_verdict = "bad_process"
        elif any(r.process_verdict == "good_process" for r in all_receipts):
            process_verdict = "good_process"

        return {
            "updated": updated,
            "captain_followed": (captain_followed_values[-1] if captain_followed_values else None),
            "recommendation_followed": (
                recommendation_followed_values[-1] if recommendation_followed_values else None
            ),
            "process_verdict": process_verdict,
            "drift_flags": all_drift_flags,
        }

    def build_review(
        self,
        raw_results: Dict[str, Any],
        transformed_results: Dict[str, Any],
        manager_id: str,
    ) -> Dict[str, Any]:
        review = self._compute_review(raw_results, transformed_results)
        persistence = self._persist_receipt_outcomes(
            manager_id=manager_id,
            points_delta=review.points_delta,
            rank_delta=review.rank_delta,
            history_available=review.history_available,
        )

        if not review.history_available:
            card = self.default_review_card()
            card["metrics"]["previous_gw"] = review.previous_gw
            card["metrics"]["updated_receipts"] = persistence["updated"]
            return card

        highlights = []
        if review.points is not None:
            highlights.append(f"Previous GW points: {review.points}")
        if review.rank is not None:
            highlights.append(f"Previous GW rank: {review.rank:,}")
        if review.points_delta is not None:
            highlights.append(f"Points delta vs current GW: {review.points_delta:+d}")
        if review.rank_delta is not None:
            highlights.append(f"Rank delta vs current GW: {review.rank_delta:+d}")

        summary = "Retrospective review captured from previous gameweek data."
        if persistence["process_verdict"] == "bad_process":
            summary = "Retrospective review signals process drift; tighten decision discipline."
        elif persistence["process_verdict"] == "good_process":
            summary = "Retrospective review supports current decision process."

        return {
            "version": "v1",
            "summary": summary,
            "highlights": highlights,
            "metrics": {
                "previous_gw": review.previous_gw,
                "points": review.points,
                "points_delta": review.points_delta,
                "rank": review.rank,
                "rank_delta": review.rank_delta,
                "captain_followed": persistence["captain_followed"],
                "recommendation_followed": persistence["recommendation_followed"],
                "process_verdict": persistence["process_verdict"],
                "drift_flags": persistence["drift_flags"],
                "history_available": True,
                "updated_receipts": persistence["updated"],
            },
        }


weekly_review_service = WeeklyReviewService()
