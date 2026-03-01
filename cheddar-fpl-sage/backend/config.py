"""
Configuration settings for FPL Sage API.
"""
import logging

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Redis
    REDIS_URL: str = "redis://localhost:6379"

    # API
    DEBUG: bool = False
    API_V1_PREFIX: str = "/api/v1"
    API_VERSION: str = "2.0.0"
    ANALYSIS_ESTIMATED_DURATION_SECONDS: int = 45
    REQUEST_LOGGING_ENABLED: bool = True

    # CORS / ingress guardrails
    CORS_ALLOWED_ORIGINS: str = "https://cheddarlogic.com,http://localhost:3000"
    CORS_ALLOWED_METHODS: str = "GET,POST,OPTIONS"
    CORS_ALLOWED_HEADERS: str = "Authorization,Content-Type"

    # Rate limiting
    RATE_LIMIT_REQUESTS_PER_HOUR: int = 100
    RATE_LIMIT_ENABLED: bool = True

    # Caching
    CACHE_TTL_SECONDS: int = 300  # 5 minutes
    CACHE_ENABLED: bool = True
    ANALYSIS_JOB_TTL_SECONDS: int = 604800  # 7 days

    # Optional upstream health probing
    FPL_API_HEALTHCHECK_ENABLED: bool = False
    FPL_API_HEALTHCHECK_URL: str = "https://fantasy.premierleague.com/api/bootstrap-static/"
    FPL_API_HEALTHCHECK_TIMEOUT_SECONDS: float = 2.0
    
    # Unlimited Access Feature Flag
    UNLIMITED_ACCESS_ENABLED: bool = True  # Toggle off to disable all unlimited access
    UNLIMITED_TEAMS: str = "711511,1930561"  # Comma-separated team IDs

    model_config = SettingsConfigDict(
        env_prefix="FPL_SAGE_",
        case_sensitive=False,
    )


settings = Settings()


def _parse_csv_list(value: str) -> list[str]:
    """Parse CSV config into a de-duplicated list preserving order."""
    seen: set[str] = set()
    parsed: list[str] = []
    for item in value.split(","):
        normalized = item.strip()
        if normalized and normalized not in seen:
            parsed.append(normalized)
            seen.add(normalized)
    return parsed


def get_cors_allowed_origins() -> list[str]:
    """Return configured CORS origins."""
    return _parse_csv_list(settings.CORS_ALLOWED_ORIGINS)


def get_cors_allowed_methods() -> list[str]:
    """Return configured CORS methods."""
    return _parse_csv_list(settings.CORS_ALLOWED_METHODS)


def get_cors_allowed_headers() -> list[str]:
    """Return configured CORS headers."""
    return _parse_csv_list(settings.CORS_ALLOWED_HEADERS)


def get_unlimited_teams() -> set[int]:
    """Parse unlimited teams from config with validation."""
    if not settings.UNLIMITED_ACCESS_ENABLED:
        return set()
    
    try:
        teams = settings.UNLIMITED_TEAMS.strip()
        if not teams:
            return set()
        
        team_ids = set()
        for team_str in teams.split(','):
            team_str = team_str.strip()
            if team_str:
                team_id = int(team_str)
                if team_id > 0:
                    team_ids.add(team_id)
        
        return team_ids
    except (ValueError, AttributeError) as e:
        logger = logging.getLogger(__name__)
        logger.warning(f"Invalid UNLIMITED_TEAMS config: {e}. Defaulting to empty set.")
        return set()
