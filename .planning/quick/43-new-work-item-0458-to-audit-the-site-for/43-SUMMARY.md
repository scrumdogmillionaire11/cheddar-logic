---
phase: 43-wi-0458-security-audit
plan: 43
subsystem: web/api-security
tags: [security, auth, rbac, admin-routes, audit]
dependency_graph:
  requires: []
  provides: [requireEntitlementForRequest on /api/cards, /api/cards/[gameId], /api/games; ADMIN_API_SECRET gate on admin routes; security audit report]
  affects: [web/src/lib/api-security/auth.ts, web/src/app/api/cards/route.ts, web/src/app/api/cards/[gameId]/route.ts, web/src/app/api/games/route.ts, web/src/app/api/admin/audit/route.ts, web/src/app/api/admin/odds-ingest/route.ts]
tech_stack:
  added: []
  patterns: [requireEntitlementForRequest RBAC gate, ADMIN_API_SECRET header check]
key_files:
  created: [docs/security-audit-2026-03.md]
  modified:
    - web/src/lib/api-security/auth.ts
    - web/src/app/api/cards/route.ts
    - web/src/app/api/cards/[gameId]/route.ts
    - web/src/app/api/games/route.ts
    - web/src/app/api/admin/audit/route.ts
    - web/src/app/api/admin/odds-ingest/route.ts
    - env.example
decisions:
  - Add RESOURCE constant and requireEntitlementForRequest() to auth.ts (function was in spec but not exported)
  - Admin gate uses fail-closed pattern: if ADMIN_API_SECRET unset, all requests return 403
  - NODE_ENV check retained as secondary guard on admin routes
  - /api/auth/token dev token generator documented as FINDING-006 (no gate) for follow-up
metrics:
  duration: ~20 minutes
  completed: 2026-03-15
  tasks_completed: 3
  files_changed: 8
---

# Quick Task 43: WI-0458 Security Audit and Hardening Summary

**One-liner:** Restored RBAC auth walls on three public API routes and added ADMIN_API_SECRET defense-in-depth gate on both admin diagnostic routes; full written audit report produced.

---

## Tasks Completed

| Task | Description | Commit |
|---|---|---|
| 1 | Restore requireEntitlementForRequest on /api/cards, /api/cards/[gameId], /api/games | bd431ef |
| 2 | Harden admin routes with ADMIN_API_SECRET header check | 8090c5b |
| 3 | Write security audit report (docs/security-audit-2026-03.md) | 412ac07 |

---

## What Was Built

**Task 1 — Auth walls restored:**
- Added `RESOURCE` constant and `requireEntitlementForRequest()` function to `web/src/lib/api-security/auth.ts`. These were referenced in the route files' commented-out blocks but had never been exported.
- `requireEntitlementForRequest` returns `{ ok, error, status }` — wraps token verification and role check. Respects `ENABLE_RBAC` env flag.
- Removed `AUTH DISABLED` comment blocks from all three routes. Each now gates on `RESOURCE.CHEDDAR_BOARD` (allows ADMIN, PAID, FREE_ACCOUNT roles).

**Task 2 — Admin route hardening:**
- Added `ADMIN_API_SECRET` / `x-admin-secret` header check at the top of both admin GET handlers. If the env var is unset, every request returns 403 — fail-closed by design.
- `NODE_ENV !== 'development'` check retained as secondary guard.
- `ADMIN_API_SECRET=` documented in `env.example` with generation command.

**Task 3 — Audit report:**
- `docs/security-audit-2026-03.md` covers all 9 API routes in a table (auth, rate-limit, input validation status).
- Documents security infrastructure: security headers, rate limiter, audit logger, RBAC, JWT.
- Classifies FINDING-001/002 as resolved and FINDING-003/004/005/006 as residual (separate WIs needed).

---

## Deviations from Plan

**1. [Rule 2 - Missing functionality] requireEntitlementForRequest and RESOURCE not yet exported**
- Found during: Task 1
- Issue: The plan assumed these symbols existed in auth.ts. They were specified in the interface doc but had not been implemented — only referenced in the now-removed comments.
- Fix: Implemented `RESOURCE` constant and `requireEntitlementForRequest()` in auth.ts, modeled on the existing `requireRole()` pattern.
- Files modified: `web/src/lib/api-security/auth.ts`
- Commit: bd431ef

---

## Residual Findings (documented in audit report)

| Finding | Route | Severity | Action Needed |
|---|---|---|---|
| FINDING-003 | /api/results | Medium | Add CHEDDAR_BOARD auth gate |
| FINDING-004 | /api/team-metrics | Low | Add CHEDDAR_BOARD auth gate |
| FINDING-005 | /api/props/shots | Medium | Add auth gate + rate limiting |
| FINDING-006 | /api/auth/token | Low | Add NODE_ENV guard or remove in production |

---

## Test Results

- `npm --prefix web run lint`: PASSED (1 pre-existing warning in cards-page-client.tsx, 0 errors)
- `npm --prefix web run test:auth`: BLOCKED — `src/__tests__/auth-refresh-flow.test.js` does not exist. This is a pre-existing gap in the repo (the script references a test file that was never created). Not caused by this WI.

---

## Self-Check

- [x] `web/src/lib/api-security/auth.ts` — FOUND, contains requireEntitlementForRequest and RESOURCE
- [x] `web/src/app/api/cards/route.ts` — FOUND, contains requireEntitlementForRequest call
- [x] `web/src/app/api/games/route.ts` — FOUND, contains requireEntitlementForRequest call
- [x] `web/src/app/api/admin/audit/route.ts` — FOUND, contains ADMIN_API_SECRET check
- [x] `web/src/app/api/admin/odds-ingest/route.ts` — FOUND, contains ADMIN_API_SECRET check
- [x] `docs/security-audit-2026-03.md` — FOUND (116 lines)
- [x] Commit bd431ef — FOUND
- [x] Commit 8090c5b — FOUND
- [x] Commit 412ac07 — FOUND

## Self-Check: PASSED
