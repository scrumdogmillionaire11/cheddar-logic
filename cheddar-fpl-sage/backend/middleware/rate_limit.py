"""
Rate limiting middleware using Redis.
Implements sliding window rate limiting with graceful degradation.
"""
import logging
import re
import time
from typing import Tuple

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from backend.exceptions import build_error_payload

logger = logging.getLogger(__name__)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    Rate limiting middleware using Redis sliding window.

    - 100 requests per hour per IP address
    - Returns 429 Too Many Requests when exceeded
    - Gracefully degrades to no-limit when Redis unavailable
    - Adds X-RateLimit-* headers to responses
    - Exempts unlimited team IDs from rate limiting (configured via settings)
    """

    def __init__(self, app, redis_client=None, requests_per_hour: int = 100):
        super().__init__(app)
        self.redis = redis_client
        self.requests_per_hour = requests_per_hour
        self.window_seconds = 3600  # 1 hour
        # Load unlimited teams from config at initialization
        from backend.config import get_unlimited_teams
        self._unlimited_teams = get_unlimited_teams()
        if self._unlimited_teams:
            logger.info(f"Rate limit exemptions for teams: {self._unlimited_teams}")

    def _get_client_ip(self, request: Request) -> str:
        """Extract client IP, respecting X-Forwarded-For."""
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            # Take first IP in chain (original client)
            return forwarded.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    def _is_unlimited_team_request(self, request: Request) -> bool:
        """
        Check if request is for an unlimited team.
        
        Matches URLs like:
        - /api/v1/analyze/interactive (with team_id in body)
        - /api/v1/analyze/{team_id}
        """
        path = request.url.path
        
        # Extract team_id from URL path
        match = re.search(r'/analyze/(\d+)', path)
        if match:
            team_id = int(match.group(1))
            if team_id in self._unlimited_teams:
                logger.info(f"Rate limit exemption: unlimited team {team_id} (via config)")
                return True
        
        return False

    def _check_rate_limit(self, client_ip: str) -> Tuple[bool, int, int]:
        """
        Check if request is within rate limit.

        Returns: (allowed, remaining, reset_time)
        """
        if not self.redis:
            # No Redis = no rate limiting (graceful degradation)
            return True, self.requests_per_hour, 0

        key = f"rate_limit:{client_ip}"
        now = int(time.time())
        window_start = now - self.window_seconds

        try:
            # Use Redis pipeline for atomic operations
            pipe = self.redis.pipeline()

            # Remove old entries outside window
            pipe.zremrangebyscore(key, 0, window_start)

            # Count requests in current window
            pipe.zcard(key)

            # Add current request
            pipe.zadd(key, {str(now): now})

            # Set expiry on key
            pipe.expire(key, self.window_seconds)

            results = pipe.execute()
            request_count = results[1]

            remaining = max(0, self.requests_per_hour - request_count - 1)
            reset_time = now + self.window_seconds

            if request_count >= self.requests_per_hour:
                return False, 0, reset_time

            return True, remaining, reset_time

        except Exception as e:
            logger.warning(f"Redis rate limit check failed: {e}")
            # Graceful degradation - allow request
            return True, self.requests_per_hour, 0

    async def dispatch(self, request: Request, call_next):
        """Process request with rate limiting."""
        # Skip rate limiting for health checks and docs
        if request.url.path in ["/health", "/", "/docs", "/openapi.json", "/redoc"]:
            return await call_next(request)

        # Skip rate limiting for unlimited teams
        if self._is_unlimited_team_request(request):
            return await call_next(request)

        client_ip = self._get_client_ip(request)
        allowed, remaining, reset_time = self._check_rate_limit(client_ip)

        if not allowed:
            retry_after = reset_time - int(time.time())
            return JSONResponse(
                status_code=429,
                content=build_error_payload(
                    error_code="RATE_LIMITED",
                    message="Rate limit exceeded",
                    details={
                        "detail": f"Maximum {self.requests_per_hour} requests per hour",
                        "retry_after": retry_after,
                    },
                ),
                headers={
                    "X-RateLimit-Limit": str(self.requests_per_hour),
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": str(reset_time),
                    "Retry-After": str(retry_after),
                },
            )

        # Process request
        response = await call_next(request)

        # Add rate limit headers
        response.headers["X-RateLimit-Limit"] = str(self.requests_per_hour)
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        if reset_time:
            response.headers["X-RateLimit-Reset"] = str(reset_time)

        return response
