"""
FPL Sage API - Main Application
"""
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import logging
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import redis

from backend.config import (
    settings,
    get_cors_allowed_headers,
    get_cors_allowed_methods,
    get_cors_allowed_origins,
)
from backend.routers import analyze_router, user_router
from backend.routers.dashboard import router as dashboard_router
from backend.middleware import RateLimitMiddleware, RequestLoggingMiddleware
from backend.services.cache_service import cache_service
from backend.services.engine_service import engine_service
from backend.services.monitoring_service import check_http_health
from backend.exceptions import register_exception_handlers

logging.basicConfig(level=logging.INFO if not settings.DEBUG else logging.DEBUG)
logger = logging.getLogger(__name__)

# Global Redis client
redis_client: Optional[redis.Redis] = None
started_at = datetime.now(timezone.utc)


def get_redis_client() -> Optional[redis.Redis]:
    """Get Redis client with connection pooling."""
    global redis_client
    if redis_client is not None:
        return redis_client

    try:
        redis_client = redis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=2,
            socket_timeout=2,
        )
        # Test connection
        redis_client.ping()
        logger.info(f"Connected to Redis at {settings.REDIS_URL}")
        return redis_client
    except Exception as e:
        logger.warning(f"Redis connection failed: {e}. Running without cache/rate limiting.")
        return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan context manager."""
    logger.info("FPL Sage API starting up...")

    # Initialize Redis connection
    client = get_redis_client()

    # Configure services with Redis
    if client:
        cache_service.redis = client
        cache_service.ttl = settings.CACHE_TTL_SECONDS
        engine_service.configure_redis(client, settings.ANALYSIS_JOB_TTL_SECONDS)

    yield

    # Cleanup
    if redis_client:
        redis_client.close()
    logger.info("FPL Sage API shutting down...")


app = FastAPI(
    title="FPL Sage API",
    description="AI-powered FPL decision engine API",
    version=settings.API_VERSION,
    lifespan=lifespan,
)

# Register exception handlers FIRST (before middleware)
register_exception_handlers(app)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_cors_allowed_origins(),
    allow_credentials=True,
    allow_methods=get_cors_allowed_methods(),
    allow_headers=get_cors_allowed_headers(),
)

# Rate limiting middleware
if settings.RATE_LIMIT_ENABLED:
    app.add_middleware(
        RateLimitMiddleware,
        redis_client=get_redis_client(),
        requests_per_hour=settings.RATE_LIMIT_REQUESTS_PER_HOUR,
    )

# Request observability middleware (add last so it wraps and logs all responses)
if settings.REQUEST_LOGGING_ENABLED:
    app.add_middleware(RequestLoggingMiddleware)

# Include routers
app.include_router(analyze_router, prefix=settings.API_V1_PREFIX)
app.include_router(dashboard_router, prefix=settings.API_V1_PREFIX)
app.include_router(user_router, prefix=settings.API_V1_PREFIX)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    now = datetime.now(timezone.utc)
    uptime_hours = round((now - started_at).total_seconds() / 3600, 2)

    fpl_api_status = "healthy"
    health_message = None
    if settings.FPL_API_HEALTHCHECK_ENABLED:
        fpl_api_status, detail = check_http_health(
            settings.FPL_API_HEALTHCHECK_URL,
            timeout_seconds=settings.FPL_API_HEALTHCHECK_TIMEOUT_SECONDS,
        )
        health_message = detail if fpl_api_status != "healthy" else None

    components = {
        "fpl_api": fpl_api_status,
        "database": "healthy" if redis_client else "degraded",
        "analysis_engine": "healthy",
    }
    is_critical_degraded = components["analysis_engine"] != "healthy" or components["fpl_api"] != "healthy"
    service_status = "degraded" if is_critical_degraded else "healthy"
    payload = {
        "status": service_status,
        "timestamp": now.isoformat(),
        "components": components,
        "version": settings.API_VERSION,
        "uptime_hours": uptime_hours,
    }
    if health_message:
        payload["message"] = health_message
    if service_status == "degraded":
        return JSONResponse(status_code=503, content=payload)
    return payload


@app.get("/")
async def root():
    """Root endpoint with API info."""
    return {
        "name": "FPL Sage API",
        "version": settings.API_VERSION,
        "docs": "/docs",
        "health": "/health",
    }
