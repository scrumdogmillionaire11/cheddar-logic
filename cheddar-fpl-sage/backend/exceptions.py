"""
Custom exceptions and error handlers for FPL Sage API.
Provides consistent error response format across all endpoints.
"""
from datetime import datetime, timezone
from typing import Optional
from fastapi import Request, HTTPException
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
import logging

logger = logging.getLogger(__name__)


def build_error_payload(
    error_code: str,
    message: str,
    details: Optional[dict] = None,
) -> dict:
    """Build the standardized API error envelope with legacy compatibility keys."""
    details_payload = details or {}
    legacy_detail = details_payload.get("detail") if isinstance(details_payload, dict) else None
    return {
        "error": True,
        "error_code": error_code,
        "message": message,
        "details": details_payload,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        # Legacy compatibility fields used by existing frontend/tests.
        "code": error_code,
        "detail": legacy_detail,
    }


class FPLSageError(Exception):
    """Base exception for FPL Sage API."""

    def __init__(
        self,
        message: str,
        code: str = "INTERNAL_ERROR",
        status_code: int = 500,
        detail: Optional[str] = None,
    ):
        self.message = message
        self.code = code
        self.status_code = status_code
        self.detail = detail
        super().__init__(message)


class FPLAPIError(FPLSageError):
    """Error from FPL API (upstream service)."""

    def __init__(self, message: str, detail: Optional[str] = None):
        super().__init__(
            message=message,
            code="FPL_API_ERROR",
            status_code=502,  # Bad Gateway for upstream errors
            detail=detail,
        )


class InvalidTeamError(FPLSageError):
    """Invalid or non-existent FPL team."""

    def __init__(self, team_id: int):
        super().__init__(
            message=f"Team {team_id} not found or invalid",
            code="INVALID_TEAM_ID",
            status_code=404,
            detail="The FPL team ID does not exist or is private",
        )


class AnalysisTimeoutError(FPLSageError):
    """Analysis took too long."""

    def __init__(self, analysis_id: str, timeout_seconds: int = 30):
        super().__init__(
            message=f"Analysis {analysis_id} timed out after {timeout_seconds}s",
            code="ANALYSIS_TIMEOUT",
            status_code=504,  # Gateway Timeout
            detail="The analysis took too long to complete. Please try again.",
        )


class DataValidationError(FPLSageError):
    """Data from FPL API failed validation."""

    def __init__(self, message: str, detail: Optional[str] = None):
        super().__init__(
            message=message,
            code="DATA_VALIDATION_ERROR",
            status_code=422,
            detail=detail,
        )


# Exception handlers

async def fpl_sage_error_handler(request: Request, exc: FPLSageError) -> JSONResponse:
    """Handler for FPL Sage custom exceptions."""
    logger.warning(f"FPLSageError: {exc.code} - {exc.message}")
    return JSONResponse(
        status_code=exc.status_code,
        content=build_error_payload(
            error_code=exc.code,
            message=exc.message,
            details={"detail": exc.detail} if exc.detail else {},
        ),
    )


async def http_exception_handler(
    request: Request, exc: HTTPException
) -> JSONResponse:
    """Handler for standard HTTP exceptions."""
    # Handle detail that might be a dict (from our endpoints)
    if isinstance(exc.detail, dict):
        error_code = str(exc.detail.get("error_code") or exc.detail.get("code") or f"HTTP_{exc.status_code}")
        message = str(exc.detail.get("message") or exc.detail.get("error") or "Request failed")
        details = exc.detail.get("details")
        if not isinstance(details, dict):
            details = {}
        if "detail" in exc.detail and "detail" not in details:
            details["detail"] = exc.detail["detail"]
        return JSONResponse(
            status_code=exc.status_code,
            content=build_error_payload(
                error_code=error_code,
                message=message,
                details=details,
            ),
        )

    return JSONResponse(
        status_code=exc.status_code,
        content=build_error_payload(
            error_code=f"HTTP_{exc.status_code}",
            message=str(exc.detail),
            details={},
        ),
    )


async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Handler for Pydantic validation errors."""
    errors = exc.errors()

    # Format validation errors nicely
    error_messages = []
    for error in errors:
        loc = " -> ".join(str(l) for l in error["loc"])
        msg = error["msg"]
        error_messages.append(f"{loc}: {msg}")

    return JSONResponse(
        status_code=422,
        content=build_error_payload(
            error_code="VALIDATION_ERROR",
            message="Validation error",
            details={
                "detail": "; ".join(error_messages),
                "errors": errors,  # Include full error details for debugging
            },
        ),
    )


async def general_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch-all handler for unhandled exceptions."""
    logger.exception(f"Unhandled exception: {exc}")
    return JSONResponse(
        status_code=500,
        content=build_error_payload(
            error_code="INTERNAL_ERROR",
            message="Internal server error",
            details={"detail": "An unexpected error occurred. Please try again later."},
        ),
    )


def register_exception_handlers(app):
    """Register all exception handlers with the app."""
    app.add_exception_handler(FPLSageError, fpl_sage_error_handler)
    app.add_exception_handler(HTTPException, http_exception_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    # Note: General exception handler should be last resort
    # Only uncomment in production:
    # app.add_exception_handler(Exception, general_exception_handler)
