"""Decision-receipts router — POST/GET /api/v1/decision-receipts (WI-0658)."""
from __future__ import annotations

import logging
from typing import List

from fastapi import APIRouter, HTTPException, status

from backend.models.receipt_api_models import (
    DecisionReceiptCreateRequest,
    DecisionReceiptResponse,
)
from backend.services.product_store import product_store
from backend.services.receipt_service import receipt_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/decision-receipts", tags=["decision-receipts"])


@router.post("", response_model=DecisionReceiptResponse, status_code=201)
async def create_receipt(
    request: DecisionReceiptCreateRequest,
) -> DecisionReceiptResponse:
    """Persist a new decision receipt and return the stored contract."""
    return receipt_service.create_receipt(request)


@router.get("/{receipt_id}", response_model=DecisionReceiptResponse)
async def get_receipt(receipt_id: str) -> DecisionReceiptResponse:
    """Retrieve a single decision receipt by ID."""
    receipt = product_store.get_receipt(receipt_id)
    if receipt is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Receipt '{receipt_id}' not found.",
        )
    from backend.services.receipt_service import _to_response  # noqa: PLC0415

    return _to_response(receipt)


@router.get("/manager/{manager_id}", response_model=List[DecisionReceiptResponse])
async def list_receipts_by_manager(manager_id: str) -> List[DecisionReceiptResponse]:
    """List all decision receipts for a given manager."""
    from backend.services.receipt_service import _to_response  # noqa: PLC0415

    receipts = product_store.list_receipts(manager_id=manager_id)
    return [_to_response(r) for r in receipts]
