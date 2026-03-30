"""API models package."""
from .api_models import (
    AnalyzeRequest,
    AnalyzeResponse,
    AnalysisStatus,
    ErrorResponse,
)
from .product_models import (
    DecisionReceipt,
    DraftAudit,
    DraftCandidate,
    DraftSession,
    ManagerProfile,
    ParsedSquad,
    PRODUCT_SCHEMA_VERSION,
)

__all__ = [
    # Transient analysis-job contracts
    "AnalyzeRequest",
    "AnalyzeResponse",
    "AnalysisStatus",
    "ErrorResponse",
    # Durable product-store contracts (WI-0652)
    "ManagerProfile",
    "DraftSession",
    "DraftCandidate",
    "ParsedSquad",
    "DraftAudit",
    "DecisionReceipt",
    "PRODUCT_SCHEMA_VERSION",
]
