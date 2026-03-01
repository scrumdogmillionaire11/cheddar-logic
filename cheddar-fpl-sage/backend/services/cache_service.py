"""
Caching service for analysis results using Redis.
"""
import logging
import json
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)


class CacheService:
    """
    Caches analysis results in Redis.

    Cache key: fpl_sage:analysis:{team_id}:{gameweek}
    TTL: 5 minutes (configurable)
    """

    def __init__(self, redis_client=None, ttl_seconds: int = 300):
        self.redis = redis_client
        self.ttl = ttl_seconds

    def _make_key(self, team_id: int, gameweek: Optional[int]) -> str:
        """Generate cache key."""
        gw = gameweek or "current"
        return f"fpl_sage:analysis:{team_id}:{gw}"

    def get_cached_analysis(
        self, team_id: int, gameweek: Optional[int] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Get cached analysis result if available.

        Returns None if not cached or Redis unavailable.
        """
        if not self.redis:
            return None

        key = self._make_key(team_id, gameweek)

        try:
            cached = self.redis.get(key)
            if cached:
                logger.info(f"Cache hit for {key}")
                return json.loads(cached)
            return None
        except Exception as e:
            logger.warning(f"Cache get failed: {e}")
            return None

    def cache_analysis(
        self,
        team_id: int,
        gameweek: Optional[int],
        results: Dict[str, Any],
    ) -> bool:
        """
        Cache analysis results.

        Returns True if cached successfully, False otherwise.
        """
        if not self.redis:
            return False

        key = self._make_key(team_id, gameweek)

        try:
            # Serialize results
            serialized = json.dumps(results, default=str)

            # Store with TTL
            self.redis.setex(key, self.ttl, serialized)
            logger.info(f"Cached analysis for {key}, TTL={self.ttl}s")
            return True
        except Exception as e:
            logger.warning(f"Cache set failed: {e}")
            return False

    def invalidate(self, team_id: int, gameweek: Optional[int] = None) -> bool:
        """Invalidate cached analysis."""
        if not self.redis:
            return False

        key = self._make_key(team_id, gameweek)

        try:
            self.redis.delete(key)
            return True
        except Exception as e:
            logger.warning(f"Cache invalidate failed: {e}")
            return False


# Singleton - will be initialized with Redis in main.py
cache_service = CacheService()
