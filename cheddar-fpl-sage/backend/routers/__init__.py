"""API Routers"""
from .advisor import router as advisor_router
from .analyze import router as analyze_router
from .draft_analysis import router as draft_analysis_router
from .draft_sessions import router as draft_sessions_router
from .receipts import router as receipts_router
from .screenshot_parse import router as screenshot_parse_router
from .user import router as user_router

__all__ = [
    "advisor_router",
    "analyze_router",
    "draft_analysis_router",
    "draft_sessions_router",
    "receipts_router",
    "screenshot_parse_router",
    "user_router",
]
