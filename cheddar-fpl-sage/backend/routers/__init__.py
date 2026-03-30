"""API Routers"""
from .advisor import router as advisor_router
from .analyze import router as analyze_router
from .screenshot_parse import router as screenshot_parse_router
from .user import router as user_router

__all__ = ["advisor_router", "analyze_router", "screenshot_parse_router", "user_router"]
