"""Monitoring helpers for upstream dependency availability."""
from __future__ import annotations

import urllib.request


def check_http_health(url: str, timeout_seconds: float = 2.0) -> tuple[str, str | None]:
    """
    Probe an HTTP endpoint and return status + optional detail.

    Returns:
      ("healthy", None) on 2xx/3xx responses.
      ("unavailable", detail) on network or non-success responses.
    """
    try:
        with urllib.request.urlopen(url, timeout=timeout_seconds) as response:  # nosec B310
            status = getattr(response, "status", 200)
            if 200 <= int(status) < 400:
                return "healthy", None
            return "unavailable", f"Unexpected status {status}"
    except Exception as exc:  # pragma: no cover - exercised through caller tests
        return "unavailable", str(exc)
