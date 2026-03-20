"""
Tests for rate limiting and caching.
"""
import asyncio
import json
from unittest.mock import MagicMock
import sys
import os

from starlette.requests import Request
from starlette.responses import JSONResponse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src'))

from backend.middleware.rate_limit import RateLimitMiddleware
from backend.services.cache_service import CacheService


def _make_request(path="/api/v1/analyze", method="GET", headers=None, client_host="127.0.0.1") -> Request:
    header_list = []
    for key, value in (headers or {}).items():
        header_list.append((key.lower().encode("latin-1"), value.encode("latin-1")))

    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": method,
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": b"",
        "headers": header_list,
        "client": (client_host, 12345),
        "server": ("testserver", 80),
        "scheme": "http",
    }
    return Request(scope)


class TestRateLimitMiddleware:
    """Tests for rate limiting."""

    def test_no_redis_allows_all_requests(self):
        """Without Redis, all requests are allowed."""
        middleware = RateLimitMiddleware(app=None, redis_client=None)
        allowed, remaining, reset = middleware._check_rate_limit("127.0.0.1")

        assert allowed is True
        assert remaining == 100  # Default limit

    def test_extracts_client_ip_from_headers(self):
        """X-Forwarded-For header is respected."""
        middleware = RateLimitMiddleware(app=None)

        class MockRequest:
            headers = {"X-Forwarded-For": "1.2.3.4, 5.6.7.8"}
            client = MagicMock(host="10.0.0.1")

        ip = middleware._get_client_ip(MockRequest())
        assert ip == "1.2.3.4"

    def test_falls_back_to_client_host(self):
        """Falls back to client.host when no X-Forwarded-For."""
        middleware = RateLimitMiddleware(app=None)

        class MockRequest:
            headers = {}
            client = MagicMock(host="192.168.1.1")

        ip = middleware._get_client_ip(MockRequest())
        assert ip == "192.168.1.1"

    def test_handles_missing_client(self):
        """Returns 'unknown' when no client info available."""
        middleware = RateLimitMiddleware(app=None)

        class MockRequest:
            headers = {}
            client = None

        ip = middleware._get_client_ip(MockRequest())
        assert ip == "unknown"

    def test_rate_limit_with_mock_redis(self):
        """Rate limiting works with Redis."""
        mock_redis = MagicMock()
        mock_pipe = MagicMock()
        mock_redis.pipeline.return_value = mock_pipe

        # Simulate 50 requests in window
        mock_pipe.execute.return_value = [None, 50, None, None]

        middleware = RateLimitMiddleware(
            app=None,
            redis_client=mock_redis,
            requests_per_hour=100,
        )

        allowed, remaining, reset = middleware._check_rate_limit("test_ip")

        assert allowed is True
        assert remaining == 49  # 100 - 50 - 1

    def test_rate_limit_exceeded(self):
        """Rate limit returns False when exceeded."""
        mock_redis = MagicMock()
        mock_pipe = MagicMock()
        mock_redis.pipeline.return_value = mock_pipe

        # Simulate 100 requests in window (at limit)
        mock_pipe.execute.return_value = [None, 100, None, None]

        middleware = RateLimitMiddleware(
            app=None,
            redis_client=mock_redis,
            requests_per_hour=100,
        )

        allowed, remaining, reset = middleware._check_rate_limit("test_ip")

        assert allowed is False
        assert remaining == 0

    def test_redis_error_allows_request(self):
        """Redis errors result in graceful degradation (allow request)."""
        mock_redis = MagicMock()
        mock_redis.pipeline.side_effect = Exception("Redis connection failed")

        middleware = RateLimitMiddleware(
            app=None,
            redis_client=mock_redis,
            requests_per_hour=100,
        )

        allowed, remaining, reset = middleware._check_rate_limit("test_ip")

        assert allowed is True
        assert remaining == 100

    def test_custom_requests_per_hour(self):
        """Custom rate limit is respected."""
        middleware = RateLimitMiddleware(app=None, redis_client=None, requests_per_hour=50)
        allowed, remaining, reset = middleware._check_rate_limit("127.0.0.1")

        assert allowed is True
        assert remaining == 50

    def test_dispatch_returns_429_with_retry_after_and_error_contract(self):
        """Exceeded limit returns Retry-After + standardized error envelope."""
        mock_redis = MagicMock()
        mock_pipe = MagicMock()
        mock_redis.pipeline.return_value = mock_pipe
        mock_pipe.execute.return_value = [None, 100, None, None]
        middleware = RateLimitMiddleware(app=None, redis_client=mock_redis, requests_per_hour=100)

        async def _call_next(_request):
            return JSONResponse({"ok": True})

        response = asyncio.run(middleware.dispatch(_make_request(), _call_next))
        payload = json.loads(response.body.decode("utf-8"))

        assert response.status_code == 429
        assert "Retry-After" in response.headers
        assert int(response.headers["Retry-After"]) > 0
        assert payload["error"] is True
        assert payload["error_code"] == "RATE_LIMITED"
        assert payload["message"] == "Rate limit exceeded"
        assert "timestamp" in payload
        assert payload["details"]["retry_after"] == int(response.headers["Retry-After"])

    def test_dispatch_allows_and_sets_rate_limit_headers(self):
        """Allowed requests include X-RateLimit headers."""
        mock_redis = MagicMock()
        mock_pipe = MagicMock()
        mock_redis.pipeline.return_value = mock_pipe
        mock_pipe.execute.return_value = [None, 5, None, None]
        middleware = RateLimitMiddleware(app=None, redis_client=mock_redis, requests_per_hour=100)

        async def _call_next(_request):
            return JSONResponse({"ok": True})

        response = asyncio.run(middleware.dispatch(_make_request(), _call_next))

        assert response.status_code == 200
        assert response.headers["X-RateLimit-Limit"] == "100"
        assert int(response.headers["X-RateLimit-Remaining"]) == 94
        assert "X-RateLimit-Reset" in response.headers

    def test_dispatch_skips_health_endpoint(self):
        """Health endpoint bypasses limiter path."""
        mock_redis = MagicMock()
        middleware = RateLimitMiddleware(app=None, redis_client=mock_redis, requests_per_hour=1)

        async def _call_next(_request):
            return JSONResponse({"status": "healthy"})

        response = asyncio.run(middleware.dispatch(_make_request(path="/health"), _call_next))

        assert response.status_code == 200
        mock_redis.pipeline.assert_not_called()

    def test_unlimited_team_path_is_exempt(self):
        """Configured unlimited team IDs bypass limiter checks."""
        middleware = RateLimitMiddleware(app=None, redis_client=None)
        middleware._unlimited_teams = {711511}

        request = _make_request(path="/api/v1/analyze/711511")
        assert middleware._is_unlimited_team_request(request) is True


class TestCacheService:
    """Tests for caching service."""

    def test_no_redis_returns_none(self):
        """Without Redis, cache returns None."""
        cache = CacheService(redis_client=None)
        result = cache.get_cached_analysis(12345, 25)
        assert result is None

    def test_cache_miss_returns_none(self):
        """Cache miss returns None."""
        mock_redis = MagicMock()
        mock_redis.get.return_value = None

        cache = CacheService(redis_client=mock_redis)
        result = cache.get_cached_analysis(12345, 25)

        assert result is None
        mock_redis.get.assert_called_once()

    def test_cache_hit_returns_data(self):
        """Cache hit returns parsed data."""
        import json

        test_data = {"recommendations": ["test"]}
        mock_redis = MagicMock()
        mock_redis.get.return_value = json.dumps(test_data)

        cache = CacheService(redis_client=mock_redis)
        result = cache.get_cached_analysis(12345, 25)

        assert result == test_data

    def test_cache_set_with_ttl(self):
        """Cache stores with TTL."""
        mock_redis = MagicMock()

        cache = CacheService(redis_client=mock_redis, ttl_seconds=300)
        cache.cache_analysis(12345, 25, {"test": "data"})

        mock_redis.setex.assert_called_once()
        # Verify TTL is 300
        call_args = mock_redis.setex.call_args
        assert call_args[0][1] == 300  # TTL argument

    def test_cache_key_format(self):
        """Cache key includes team_id and gameweek."""
        cache = CacheService()

        key = cache._make_key(12345, 25)
        assert key == "fpl_sage:analysis:12345:25"

        key_no_gw = cache._make_key(12345, None)
        assert key_no_gw == "fpl_sage:analysis:12345:current"

    def test_invalidate_deletes_key(self):
        """Invalidate removes cache entry."""
        mock_redis = MagicMock()

        cache = CacheService(redis_client=mock_redis)
        cache.invalidate(12345, 25)

        mock_redis.delete.assert_called_once()

    def test_invalidate_without_redis_returns_false(self):
        """Invalidate returns False without Redis."""
        cache = CacheService(redis_client=None)
        result = cache.invalidate(12345, 25)
        assert result is False

    def test_cache_analysis_without_redis_returns_false(self):
        """cache_analysis returns False without Redis."""
        cache = CacheService(redis_client=None)
        result = cache.cache_analysis(12345, 25, {"test": "data"})
        assert result is False

    def test_cache_get_handles_json_error(self):
        """Cache handles invalid JSON gracefully."""
        mock_redis = MagicMock()
        mock_redis.get.return_value = "invalid json {"

        cache = CacheService(redis_client=mock_redis)
        result = cache.get_cached_analysis(12345, 25)

        assert result is None  # Graceful degradation

    def test_cache_set_handles_error(self):
        """Cache set handles errors gracefully."""
        mock_redis = MagicMock()
        mock_redis.setex.side_effect = Exception("Redis error")

        cache = CacheService(redis_client=mock_redis, ttl_seconds=300)
        result = cache.cache_analysis(12345, 25, {"test": "data"})

        assert result is False
