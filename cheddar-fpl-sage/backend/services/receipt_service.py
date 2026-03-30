"""Receipt service — create, query, and drift-signal decisions (WI-0658).

All receipt persistence uses product_store (durable file-backed JSON).
No Redis, no cache_service. Deterministic drift-flag logic only — no LLM.
"""
from __future__ import annotations

import logging
from typing import List, Optional

from backend.models.product_models import DecisionReceipt
from backend.models.receipt_api_models import (
    DecisionMemorySummary,
    DecisionReceiptCreateRequest,
    DecisionReceiptResponse,
    UserAnalyticsResponse,
)
from backend.services.product_store import product_store

logger = logging.getLogger(__name__)

# ── Helpers ───────────────────────────────────────────────────────────────────

_OUTCOME_SET = {"followed", "ignored", "partial"}


def _to_response(receipt: DecisionReceipt) -> DecisionReceiptResponse:
    """Convert DecisionReceipt domain model → API response."""
    data = receipt.model_dump(mode="json")
    # issued_at comes back as datetime or str depending on pydantic mode
    issued_at = data.get("issued_at", "")
    if not isinstance(issued_at, str):
        issued_at = str(issued_at)
    return DecisionReceiptResponse(
        receipt_id=data["receipt_id"],
        session_id=data["session_id"],
        manager_id=data["manager_id"],
        decision_type=data["decision_type"],
        rationale=data["rationale"],
        payload=data.get("payload", {}),
        issued_at=issued_at,
        schema_version=data.get("schema_version", "1.0"),
        user_choice=data.get("user_choice"),
        applied_overrides=data.get("applied_overrides"),
        outcome=data.get("outcome"),
        process_verdict=data.get("process_verdict"),
        drift_flags=data.get("drift_flags", []),
    )


def _season_matches(issued_at_str: str, season: str) -> bool:
    """Return True if the issued_at datetime string falls within the season year range.

    Season format: "YYYY-YY" e.g. "2024-25" covers years 2024 and 2025.
    """
    try:
        # Parse year from ISO8601 prefix
        year = int(issued_at_str[:4])
        start_year = int(season[:4])
        end_year = start_year + 1
        return year in (start_year, end_year)
    except (ValueError, IndexError):
        return False


class ReceiptService:
    """Service for decision receipt CRUD and analytics."""

    # ── Create ─────────────────────────────────────────────────────────────────

    def create_receipt(self, req: DecisionReceiptCreateRequest) -> DecisionReceiptResponse:
        """Persist a new decision receipt and return the response contract."""
        receipt = DecisionReceipt(
            session_id=req.session_id,
            manager_id=req.manager_id,
            decision_type=req.decision_type,
            rationale=req.rationale,
            payload=req.payload,
            user_choice=req.user_choice,
            applied_overrides=req.applied_overrides,
            outcome=req.outcome,
            process_verdict=req.process_verdict,
        )
        saved = product_store.save_receipt(receipt)
        logger.info("Created receipt %s for manager %s", saved.receipt_id, saved.manager_id)
        return _to_response(saved)

    # ── Analytics ──────────────────────────────────────────────────────────────

    def get_analytics(
        self, manager_id: str, season: Optional[str] = None
    ) -> UserAnalyticsResponse:
        """Compute aggregated analytics for a manager from their stored receipts."""
        all_receipts = product_store.list_receipts(manager_id=manager_id)

        if season:
            receipts: List[DecisionReceipt] = []
            for r in all_receipts:
                issued_str = r.model_dump(mode="json").get("issued_at", "")
                if not isinstance(issued_str, str):
                    issued_str = str(issued_str)
                if _season_matches(issued_str, season):
                    receipts.append(r)
        else:
            receipts = list(all_receipts)

        receipt_count = len(receipts)

        # Adoption rate: (followed + partial) / receipts that have an outcome set
        outcome_set = [r for r in receipts if r.outcome in _OUTCOME_SET]
        if outcome_set:
            followed_or_partial = sum(
                1 for r in outcome_set if r.outcome in ("followed", "partial")
            )
            adoption_rate = followed_or_partial / len(outcome_set)
        else:
            adoption_rate = 0.0

        # Transfer quality: followed-transfer / transfer-with-outcome
        transfer_with_outcome = [
            r for r in receipts if r.decision_type == "transfer" and r.outcome in _OUTCOME_SET
        ]
        if transfer_with_outcome:
            transfer_quality = sum(
                1 for r in transfer_with_outcome if r.outcome == "followed"
            ) / len(transfer_with_outcome)
        else:
            transfer_quality = 0.0

        # Captain accuracy: followed-captain / captain-with-outcome
        captain_with_outcome = [
            r for r in receipts if r.decision_type == "captain" and r.outcome in _OUTCOME_SET
        ]
        if captain_with_outcome:
            captain_accuracy = sum(
                1 for r in captain_with_outcome if r.outcome == "followed"
            ) / len(captain_with_outcome)
        else:
            captain_accuracy = 0.0

        # Missed opportunities: ignored captain or transfer receipts
        missed_opportunity_count = sum(
            1
            for r in receipts
            if r.outcome == "ignored" and r.decision_type in ("captain", "transfer")
        )

        return UserAnalyticsResponse(
            manager_id=manager_id,
            season=season,
            adoption_rate=round(adoption_rate, 4),
            transfer_quality=round(transfer_quality, 4),
            captain_accuracy=round(captain_accuracy, 4),
            missed_opportunity_count=missed_opportunity_count,
            receipt_count=receipt_count,
        )

    # ── Memory ─────────────────────────────────────────────────────────────────

    def get_memory(self, manager_id: str) -> DecisionMemorySummary:
        """Derive deterministic drift flags from all receipts for a manager.

        Rules (all strictly > threshold to trigger flag):
          bench_neglect    : >40% of chip receipts are ignored
          overreaction     : >30% of transfer receipts have process_verdict="bad_process"
          excessive_templating: >50% of formation receipts have outcome="followed"
          overpunting      : >25% of transfer receipts have outcome="ignored"
        """
        receipts = list(product_store.list_receipts(manager_id=manager_id))
        receipt_count = len(receipts)
        evidence: dict[str, int] = {}

        # bench_neglect
        chip_receipts = [r for r in receipts if r.decision_type == "chip"]
        chip_with_outcome = [r for r in chip_receipts if r.outcome in _OUTCOME_SET]
        chip_ignored = sum(1 for r in chip_with_outcome if r.outcome == "ignored")
        evidence["chip_ignored"] = chip_ignored
        evidence["chip_with_outcome"] = len(chip_with_outcome)
        bench_neglect = (
            len(chip_with_outcome) > 0
            and chip_ignored / len(chip_with_outcome) > 0.40
        )

        # overreaction
        transfer_receipts = [r for r in receipts if r.decision_type == "transfer"]
        transfer_with_verdict = [
            r for r in transfer_receipts if r.process_verdict is not None
        ]
        transfer_bad_process = sum(
            1 for r in transfer_with_verdict if r.process_verdict == "bad_process"
        )
        evidence["transfer_bad_process"] = transfer_bad_process
        evidence["transfer_with_verdict"] = len(transfer_with_verdict)
        overreaction = (
            len(transfer_with_verdict) > 0
            and transfer_bad_process / len(transfer_with_verdict) > 0.30
        )

        # excessive_templating: >50% formation followed
        formation_receipts = [r for r in receipts if r.decision_type == "formation"]
        formation_with_outcome = [
            r for r in formation_receipts if r.outcome in _OUTCOME_SET
        ]
        formation_followed = sum(
            1 for r in formation_with_outcome if r.outcome == "followed"
        )
        evidence["formation_followed"] = formation_followed
        evidence["formation_with_outcome"] = len(formation_with_outcome)
        excessive_templating = (
            len(formation_with_outcome) > 0
            and formation_followed / len(formation_with_outcome) > 0.50
        )

        # overpunting: >25% of transfer receipts ignored (all transfers, not just those with outcome)
        transfer_with_outcome = [
            r for r in transfer_receipts if r.outcome in _OUTCOME_SET
        ]
        transfer_ignored = sum(
            1 for r in transfer_with_outcome if r.outcome == "ignored"
        )
        evidence["transfer_ignored"] = transfer_ignored
        evidence["transfer_with_ignore_outcome"] = len(transfer_with_outcome)
        overpunting = (
            len(transfer_with_outcome) > 0
            and transfer_ignored / len(transfer_with_outcome) > 0.25
        )

        return DecisionMemorySummary(
            manager_id=manager_id,
            bench_neglect=bench_neglect,
            overreaction=overreaction,
            excessive_templating=excessive_templating,
            overpunting=overpunting,
            receipt_count=receipt_count,
            evidence=evidence,
        )


# ── Singleton ─────────────────────────────────────────────────────────────────
receipt_service = ReceiptService()
