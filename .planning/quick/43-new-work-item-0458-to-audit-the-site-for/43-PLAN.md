---
phase: 43-wi-0458-security-audit
plan: 43
type: execute
wave: 1
depends_on: []
files_modified:
  - WORK_QUEUE/WI-0458.md
  - web/src/app/api/cards/route.ts
  - web/src/app/api/cards/[gameId]/route.ts
  - web/src/app/api/games/route.ts
  - web/src/app/api/admin/audit/route.ts
  - web/src/app/api/admin/odds-ingest/route.ts
  - docs/security-audit-2026-03.md
autonomous: true
requirements: [WI-0458]

must_haves:
  truths:
    - "/api/cards without a valid token returns 401, not 200"
    - "/api/games without a valid token returns 401, not 200"
    - "/api/cards/[gameId] without a valid token returns 401, not 200"
    - "Admin routes are not accessible without an explicit secret or restricted to dev env AND a secret"
    - "A written audit report documents every API route's auth posture"
  artifacts:
    - path: "web/src/app/api/cards/route.ts"
      provides: "Restored requireEntitlementForRequest gate"
      contains: "requireEntitlementForRequest"
    - path: "web/src/app/api/games/route.ts"
      provides: "Restored requireEntitlementForRequest gate"
      contains: "requireEntitlementForRequest"
    - path: "web/src/app/api/cards/[gameId]/route.ts"
      provides: "Restored requireEntitlementForRequest gate"
      contains: "requireEntitlementForRequest"
    - path: "docs/security-audit-2026-03.md"
      provides: "Full surface audit report"
  key_links:
    - from: "web/src/app/api/cards/route.ts"
      to: "web/src/lib/api-security/auth.ts"
      via: "requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD)"
      pattern: "requireEntitlementForRequest"
    - from: "web/src/app/api/admin/audit/route.ts"
      to: "ADMIN_API_SECRET env var"
      via: "x-admin-secret header check"
      pattern: "ADMIN_API_SECRET"
---

<objective>
Audit the site for security vulnerabilities and fix the confirmed gaps identified during discovery.

Purpose: Three API routes have explicitly disabled auth walls ("AUTH DISABLED" comments). Admin routes rely solely on NODE_ENV which is a fragile gate. The RBAC infrastructure is fully built but unused on the main data surfaces.

Output: Restored auth enforcement on /api/cards, /api/cards/[gameId], /api/games; hardened admin route gates; written audit report covering every route.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@WORK_QUEUE/WI-0458.md

<interfaces>
<!-- Auth infrastructure already built — use these exactly. No new files needed. -->

From web/src/lib/api-security/auth.ts:
```typescript
export type ResourceType = 'CHEDDAR_BOARD' | 'FPL_SAGE' | 'ADMIN_PANEL';

export const RESOURCE: Record<ResourceType, ResourceType> = {
  CHEDDAR_BOARD: 'CHEDDAR_BOARD',
  FPL_SAGE: 'FPL_SAGE',
  ADMIN_PANEL: 'ADMIN_PANEL',
};

// Role sets per resource
// CHEDDAR_BOARD: ADMIN, PAID, FREE_ACCOUNT
// ADMIN_PANEL: ADMIN only

export function requireAuth(request: NextRequest): { context: AuthContext; error: NextResponse | null }

export function requireEntitlementForRequest(
  request: NextRequest,
  resource: ResourceType,
): { ok: boolean; error: string; status: number }
```

The commented-out pattern (restore exactly this):
```typescript
// Currently commented out in cards/route.ts, cards/[gameId]/route.ts, games/route.ts:
const access = requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD);
if (!access.ok) {
  return NextResponse.json(
    { success: false, error: access.error },
    { status: access.status }
  );
}
```

Admin routes currently use:
```typescript
if (process.env.NODE_ENV !== 'development') {
  return NextResponse.json({ success: false, error: '...' }, { status: 403 });
}
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Restore auth walls on /api/cards, /api/cards/[gameId], /api/games</name>
  <files>
    web/src/app/api/cards/route.ts,
    web/src/app/api/cards/[gameId]/route.ts,
    web/src/app/api/games/route.ts
  </files>
  <action>
In each of the three files, find the "AUTH DISABLED" comment block and restore the auth enforcement.

In web/src/app/api/cards/route.ts (around line 221):
- Remove the "AUTH DISABLED" comment
- Uncomment the requireEntitlementForRequest block: `const access = requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD); if (!access.ok) { return NextResponse.json({ success: false, error: access.error }, { status: access.status }); }`
- Ensure RESOURCE is imported from `../../../../lib/api-security/auth` (check existing imports; add if missing)
- Ensure requireEntitlementForRequest is imported from the same path

In web/src/app/api/cards/[gameId]/route.ts (around line 208):
- Same pattern as above

In web/src/app/api/games/route.ts (around line 1222):
- Same pattern as above

Do NOT change any other logic. These are isolated uncomments. Do not alter rate limiting, query handling, or response shape.

After editing all three files, run: npm --prefix web run lint
Fix any lint errors before proceeding.
  </action>
  <verify>
    <automated>npm --prefix web run lint && grep -n "requireEntitlementForRequest" web/src/app/api/cards/route.ts web/src/app/api/cards/[gameId]/route.ts web/src/app/api/games/route.ts</automated>
  </verify>
  <done>
    All three files call requireEntitlementForRequest before processing query params. No "AUTH DISABLED" comment block remains active. Lint passes.
  </done>
</task>

<task type="auto">
  <name>Task 2: Harden admin route gates with explicit secret check</name>
  <files>
    web/src/app/api/admin/audit/route.ts,
    web/src/app/api/admin/odds-ingest/route.ts
  </files>
  <action>
Both admin routes currently use `if (process.env.NODE_ENV !== 'development')` as their only gate. This is fragile: if NODE_ENV is misconfigured in production, these routes expose internal diagnostics publicly.

Add a defense-in-depth secret header check BEFORE the NODE_ENV check in both routes:

```typescript
// Admin secret gate (defense-in-depth — do not rely on NODE_ENV alone)
const adminSecret = process.env.ADMIN_API_SECRET;
const providedSecret = request.headers.get('x-admin-secret');
if (!adminSecret || providedSecret !== adminSecret) {
  return NextResponse.json(
    { success: false, error: 'Forbidden' },
    { status: 403 }
  );
}
```

Place this block at the very top of each GET handler, before the existing NODE_ENV check. Keep the NODE_ENV check as a secondary guard.

Add ADMIN_API_SECRET to env.example with a comment:
```
# Admin API secret for /api/admin/* routes (required in production)
# Generate: openssl rand -hex 32
ADMIN_API_SECRET=
```

Do NOT add a default value for ADMIN_API_SECRET. If it is unset, the gate must reject all requests.
  </action>
  <verify>
    <automated>grep -n "ADMIN_API_SECRET\|x-admin-secret" web/src/app/api/admin/audit/route.ts web/src/app/api/admin/odds-ingest/route.ts && grep "ADMIN_API_SECRET" env.example</automated>
  </verify>
  <done>
    Both admin routes check x-admin-secret header against ADMIN_API_SECRET env var before any other logic. env.example documents the variable. If ADMIN_API_SECRET is unset, all requests return 403.
  </done>
</task>

<task type="auto">
  <name>Task 3: Write security audit report</name>
  <files>docs/security-audit-2026-03.md</files>
  <action>
Create docs/security-audit-2026-03.md (create docs/ directory if it does not exist).

The report must cover:

## Header
- Date: 2026-03-15
- Auditor: Claude (automated review)
- Scope: web/src/app/api/**, web/src/lib/api-security/**, web/src/middleware.ts

## API Route Inventory
For each route, record: path, HTTP methods, auth enforced (yes/no/partially), rate limited (yes/no), input validation (yes/no), notes.

Routes to cover (based on actual codebase):
- GET /api/cards — auth: restored by this WI, rate limited: yes, input validated: yes
- GET /api/cards/[gameId] — auth: restored by this WI, rate limited: yes, input validated: yes
- GET /api/games — auth: restored by this WI, rate limited: yes, input validated: yes
- GET /api/results — auth: none (document as finding), rate limited: yes, input validated: yes
- GET /api/team-metrics — auth: none (document as finding), rate limited: yes, input validated: yes
- POST /api/props/shots — auth: none, rate limited: unknown (investigate and document actual state), input validated: yes
- POST /api/auth/token — auth: N/A (login endpoint), rate limited: yes, input validated: yes
- GET /api/admin/audit — auth: hardened by this WI, dev-only gate: yes
- GET /api/admin/odds-ingest — auth: hardened by this WI, dev-only gate: yes

## Security Infrastructure
Document what IS working: security headers (CSP, HSTS, X-Frame-Options, etc.), rate limiter, audit logger, RBAC infrastructure (RESOURCE, requireEntitlementForRequest), JWT with jose.

## Findings

### Fixed in this WI (WI-0458)
- FINDING-001: Auth walls disabled on /api/cards, /api/cards/[gameId], /api/games — RESOLVED
- FINDING-002: Admin routes gated only by NODE_ENV — RESOLVED (added ADMIN_API_SECRET gate)

### Residual Findings (require separate WIs)
- FINDING-003: /api/results has no auth gate — PAID/FREE_ACCOUNT data exposed publicly. Severity: medium.
- FINDING-004: /api/team-metrics has no auth gate. Severity: low (less sensitive).
- FINDING-005: /api/props/shots has no auth gate — internal model endpoint exposed publicly. Severity: medium.

## Recommendations
- Apply requireEntitlementForRequest(RESOURCE.CHEDDAR_BOARD) to /api/results and /api/team-metrics in a follow-up WI
- Apply requireEntitlementForRequest(RESOURCE.CHEDDAR_BOARD) to /api/props/shots
- Consider adding ADMIN_API_SECRET rotation documentation to ops runbook

Keep the report factual and concise. No padding. Base all claims on actual code reviewed (not assumptions).
  </action>
  <verify>
    <automated>test -f docs/security-audit-2026-03.md && wc -l docs/security-audit-2026-03.md</automated>
  </verify>
  <done>
    docs/security-audit-2026-03.md exists, covers all 9 routes in a table, documents fixed findings and residual findings, references WI-0458.
  </done>
</task>

</tasks>

<verification>
After all tasks complete:

1. Lint passes: `npm --prefix web run lint`
2. Auth test passes: `npm --prefix web run test:auth`
3. Auth walls present: `grep -c "requireEntitlementForRequest" web/src/app/api/cards/route.ts web/src/app/api/cards/\[gameId\]/route.ts web/src/app/api/games/route.ts` — each returns 1
4. Admin gate present: `grep -c "ADMIN_API_SECRET" web/src/app/api/admin/audit/route.ts web/src/app/api/admin/odds-ingest/route.ts` — each returns at least 1
5. Report exists: `test -f docs/security-audit-2026-03.md`
</verification>

<success_criteria>
- Zero "AUTH DISABLED" comment blocks remain in production code paths
- All three main data routes (/api/cards, /api/cards/[gameId], /api/games) reject unauthenticated requests with 401
- Admin routes require explicit ADMIN_API_SECRET header in addition to NODE_ENV gate
- Written audit report documents every route's security posture and residual findings
- lint and test:auth pass
</success_criteria>

<output>
After completion, create `.planning/quick/43-new-work-item-0458-to-audit-the-site-for/43-SUMMARY.md` using the standard summary template.
</output>
