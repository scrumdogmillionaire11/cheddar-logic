# FPL Sage Production Readiness Audit

Date: 2026-02-25

## Scope
- Keep dashboard UX as primary experience
- Remove legacy multi-step form path
- Audit readiness for Cheddar Logic production integration

## Cleanup Completed (This Session)
- Dashboard remains default route at `/`
- Legacy wizard route `/legacy` now redirects to dashboard
- Removed legacy multi-step frontend files:
  - `frontend/src/pages/Landing.tsx`
  - `frontend/src/components/ChipSelector.tsx`
  - `frontend/src/components/FreeTransfersSelector.tsx`
  - `frontend/src/components/RiskPostureSelector.tsx`
  - `frontend/src/components/InjuryOverrideSelector.tsx`
  - `frontend/src/components/ManualTransfersInput.tsx`
- Removed broken legacy context layer implementation:
  - `frontend/src/fpl-sage-context-v2.tsx`
- Dashboard now uses in-file risk threshold mappings for API requests

## Validation Results
- Frontend build: PASS (`npm run build`)
- Frontend lint: FAIL (`npm run lint`) with 8 errors, 1 warning
- Targeted API/contract tests: PASS (`14 passed, 4 xfailed`)
- Full Python suite: FAIL (`pytest -q`) due pre-existing legacy failures outside API integration scope

## Critical Gaps Before Production

### P0 - Security/Auth/Access
1. Missing auth validation endpoint required by integration spec
- Required: `POST /auth/validate-token`
- Current: no auth router/endpoints in backend

2. CORS is fully open in API app
- `backend/main.py` allows `allow_origins=["*"]`
- Must restrict to approved cheddarlogic domains in production

### P0 - Data Integrity / Contract Mismatch
3. Analysis IDs are short 8-char strings, not UUID v4
- Current: `str(uuid.uuid4())[:8]` in `backend/services/engine_service.py`
- Spec asks for UUID v4 IDs

4. Request model does not include integration metadata fields from plan
- Missing fields in `AnalyzeRequest`: `user_id`, `source`
- Required in `.planning/fpl-sage-api-requirements.md`

5. Required user-history/performance endpoints are missing
- Missing:
  - `GET /user/{user_id}/analyses`
  - `GET /user/{user_id}/performance`

### Post-Launch (Non-MVP) - Reliability / Scale
6. Durable analytics persistence beyond Redis TTL
- Decision: defer to post-launch (not required for MVP launch)
- Current: Redis-backed job state + in-memory cache is acceptable for launch scope
- Future: add durable DB-backed analytics retention for long-horizon history/performance

## High Priority Gaps (P1)

1. Test suite not production-gating yet
- `pytest` fails at collection:
  - `tests/test_manual_transfers.py` (`NoneType.get`)
  - `tests/test_risk_filtering.py` imports removed `imp` module

2. Lint policy non-compliant
- Existing lint errors in API typing/ref usage and UI utility components

3. Dashboard docs are out of sync with codebase cleanup
- Multiple docs still claim legacy form is preserved and available

## Recommended Next Steps (Execution Order)

1. Lock security baseline (P0)
- Implement `POST /auth/validate-token`
- Add middleware/dependency that validates token for protected endpoints
- Restrict CORS to explicit allowed origins (env-driven)

2. Fix API contract parity with integration plan (P0)
- Switch analysis IDs to full UUID v4
- Add `user_id` and `source` fields to analyze request models and persistence
- Implement missing user history/performance endpoints

3. (Post-launch) Add durable analytics store
- Move long-term user analytics/history persistence to Postgres (or equivalent)
- Keep Redis as execution-time cache/queue layer

4. Stabilize CI quality gates (P1)
- Make `pytest -q` pass
- Make `npm run lint` pass
- Add CI pipeline that blocks deploy on test/lint/build failure

5. Doc and runbook alignment (P1)
- Update API requirements doc statuses to reflect implemented vs missing endpoints
- Add production deploy runbook: env vars, Redis, health checks, rollback steps

## Suggested Production Go/No-Go Criteria
- Go only when all P0 items are complete and validated in staging.
- Required checks:
  - `frontend: npm run build && npm run lint`
  - `backend: pytest -q`
  - smoke tests for auth, analyze flow, websocket updates, and result retrieval
