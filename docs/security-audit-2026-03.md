# Security Audit Report — 2026-03

**Date:** 2026-03-15
**Auditor:** Claude (automated review, WI-0458)
**Scope:** `web/src/app/api/**`, `web/src/lib/api-security/**`, `web/src/proxy.ts`
**Out of scope:** FPL Sage backend (separate service), worker/scheduler processes, database-level permissions

---

## API Route Inventory

| Route | Method | Auth Enforced | Rate Limited | Input Validated | Notes |
|---|---|---|---|---|---|
| `/api/cards` | GET | Yes (restored — WI-0458) | Yes | Yes | `requireEntitlementForRequest(CHEDDAR_BOARD)` |
| `/api/cards/[gameId]` | GET | Yes (restored — WI-0458) | No | Yes | Auth restored; no `performSecurityChecks` call in this route |
| `/api/games` | GET | Yes (restored — WI-0458) | Yes | Yes | `requireEntitlementForRequest(CHEDDAR_BOARD)` |
| `/api/results` | GET | None | Yes | Yes | FINDING-003: no auth gate |
| `/api/team-metrics` | GET | None | Yes | Yes | FINDING-004: no auth gate |
| `/api/props/shots` | POST | None | No | Yes (body parsing only) | FINDING-005: no auth gate, no rate limit |
| `/api/auth/token` | GET | None (dev tool) | Yes | Yes | Dev-only token generator; intended for local use only |
| `/api/admin/audit` | GET | Yes (hardened — WI-0458) | No | No | ADMIN_API_SECRET header required; NODE_ENV=development secondary guard |
| `/api/admin/odds-ingest` | GET | Yes (hardened — WI-0458) | No | No | ADMIN_API_SECRET header required; NODE_ENV=development secondary guard |

---

## Security Infrastructure

The following security mechanisms are implemented and functional:

### Security Headers (`proxy.ts`)

- Applied to all routes via Next.js proxy
- Content-Security-Policy (CSP): prevents XSS
- Strict-Transport-Security (HSTS): enforces HTTPS
- X-Frame-Options: prevents clickjacking
- X-Content-Type-Options: prevents MIME sniffing
- Referrer-Policy, X-XSS-Protection, Permissions-Policy

**Rate Limiter (`web/src/lib/api-security/rate-limiter.ts`)**
- In-memory rate limiting via `checkRateLimit(request)`
- Wrapped in `performSecurityChecks()` for route use
- Applied to: /api/cards, /api/games, /api/results, /api/team-metrics, /api/auth/token

**Audit Logger (`web/src/lib/api-security/audit-logger.ts`)**
- In-memory event log with severity levels (INFO, WARN, ERROR, CRITICAL)
- Logs auth events: AUTH_MISSING, AUTH_TOKEN_INVALID, AUTH_TOKEN_VALID, AUTH_ROLE_DENIED
- Configurable via `ENABLE_AUDIT_LOGGING` env var

**RBAC Infrastructure (`web/src/lib/api-security/auth.ts`)**
- Three resource types: `CHEDDAR_BOARD`, `FPL_SAGE`, `ADMIN_PANEL`
- Role sets: CHEDDAR_BOARD allows ADMIN/PAID/FREE_ACCOUNT; ADMIN_PANEL allows ADMIN only
- `requireEntitlementForRequest()`: returns `{ ok, error, status }` — call at route handler entry
- `requireAuth()` / `requireRole()`: lower-level helpers
- Controlled by `ENABLE_RBAC` env var (defaults to enforced)

**JWT (`web/src/lib/api-security/jwt.ts`)**
- Tokens verified via jose library
- Extracts: userId, email, role, subscription_status, flags
- `extractTokenFromHeader()` parses Bearer scheme

---

## Findings

### Fixed in this WI (WI-0458)

**FINDING-001: Auth walls disabled on /api/cards, /api/cards/[gameId], /api/games**
- Severity: High
- Status: RESOLVED
- Description: All three routes had `AUTH DISABLED` comment blocks that commented out the `requireEntitlementForRequest` calls, exposing betting data publicly.
- Fix: Uncommented the auth gate in all three routes. Added `requireEntitlementForRequest` and `RESOURCE` exports to auth.ts (they were defined in the interface spec but not yet exported).
- Commit: `fix(43-wi-0458): restore requireEntitlementForRequest auth walls`

**FINDING-002: Admin routes gated only by NODE_ENV**
- Severity: Medium
- Status: RESOLVED
- Description: `/api/admin/audit` and `/api/admin/odds-ingest` used `process.env.NODE_ENV !== 'development'` as their only gate. If NODE_ENV is misconfigured or set to 'development' in a staging environment, internal diagnostics are exposed.
- Fix: Added `ADMIN_API_SECRET` header check before the NODE_ENV check. If `ADMIN_API_SECRET` is unset, all requests return 403 (fail-closed). NODE_ENV check retained as a secondary guard.
- Commit: `fix(43-wi-0458): harden admin route gates with explicit ADMIN_API_SECRET header check`

---

### Residual Findings (require separate WIs)

**FINDING-003: /api/results has no auth gate**
- Severity: Medium
- Description: `/api/results` returns settlement history (wins/losses/P&L by sport and card type). This is paid-tier data exposed publicly. Rate-limited but not authenticated.
- Recommendation: Apply `requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD)` before the security check call.

**FINDING-004: /api/team-metrics has no auth gate**
- Severity: Low
- Description: `/api/team-metrics` returns team performance metrics. Less sensitive than settlement history but still part of the paid Cheddar Board product. Rate-limited but not authenticated.
- Recommendation: Apply `requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD)`.

**FINDING-005: /api/props/shots has no auth gate and no rate limit**
- Severity: Medium
- Description: `POST /api/props/shots` is an internal model endpoint that runs the NHL player shots probability model. It has no authentication, no rate limiting, and no `performSecurityChecks` call. An attacker could drive unbounded model computation.
- Recommendation: Apply `requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD)` and add `performSecurityChecks(request, '/api/props/shots')` at the handler entry.

**FINDING-006: /api/auth/token is a dev-only token generator with no environment gate**
- Severity: Low (informational)
- Description: `GET /api/auth/token` generates signed JWTs for any role/subscription combination. The route comment says "Remove or restrict this endpoint in production!" but there is no `NODE_ENV` guard or secret check. If this route ships to production, it would allow anyone to generate admin tokens.
- Recommendation: Add `if (process.env.NODE_ENV !== 'development') return 403` at handler entry, or remove the route from production builds.

---

## Recommendations Summary

| Priority | Action | Target |
|---|---|---|
| High | Add auth gate | `/api/results` (FINDING-003) |
| High | Add auth gate and rate limit | `/api/props/shots` (FINDING-005) |
| Medium | Add auth gate | `/api/team-metrics` (FINDING-004) |
| Medium | Add NODE_ENV guard | `/api/auth/token` (FINDING-006) |
| Low | ~~Add ops runbook entry~~ ✅ Done | Document `ADMIN_API_SECRET` rotation procedure → see `docs/ops-runbook.md` — **Secrets Rotation** section |

All `requireEntitlementForRequest` calls should use `RESOURCE.CHEDDAR_BOARD` for user-facing data routes. The infrastructure is fully built — each fix is a 5-line addition at the route handler entry point.
