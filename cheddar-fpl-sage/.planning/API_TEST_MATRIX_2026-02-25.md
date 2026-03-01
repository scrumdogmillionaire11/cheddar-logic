# API Test Matrix (2026-02-25)

## Implemented + Tested
- `POST /api/v1/analyze`
  - queues successfully
  - returns cached result when available
  - validates team id
- `POST /api/v1/analyze/interactive`
  - accepts overrides and queues
- `GET /api/v1/analyze/{analysis_id}`
  - 404 for missing analysis
  - returns completed payload
- `GET /api/v1/analyze/{analysis_id}/dashboard`
  - dashboard contract response validated
- `GET /api/v1/user/{user_id}/analyses`
  - pagination/filter/sort query handling validated
- `GET /api/v1/user/{user_id}/performance`
  - aggregate schema + include_details flow validated
- `GET /api/v1/analyze/{analysis_id}/projections`
  - 425 when analysis not complete
  - returns detailed response when complete
- Usage limits removed
  - `/api/v1/usage/{team_id}` removed
  - analyze flow no longer returns `USAGE_LIMIT_REACHED`

## Planned Contracts (xfail tests)
- `POST /api/v1/auth/validate-token` (intentionally removed per auth sunset decision; tests assert 404)

## Observability + Monitoring
- Structured request logging middleware (request_id, latency_ms, status)
- Response tracing headers: `X-Request-ID`, `X-Process-Time-Ms`
- Optional upstream FPL API health probe in `/health` (env-gated)
- Concurrent health endpoint smoke/load test added

## Commands
- Targeted suite:
  - `pytest -q tests/test_analyze_api.py tests/test_limits_removed.py tests/test_manual_transfers.py tests/test_risk_filtering.py tests/test_planned_api_contracts.py`
- Full suite (currently has unrelated legacy failures):
  - `pytest -q`
