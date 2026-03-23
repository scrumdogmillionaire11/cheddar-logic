---
phase: 65-follow-sprint-plan-in-state
plan: 01
subsystem: auth/jwt
tags: [security, jwt, hs256, auth-secret, tdd, wI-0559, wi-0560]
dependency_graph:
  requires: []
  provides: [RFC-compliant JWT signatures, fail-closed prod auth guard]
  affects: [web/src/lib/api-security/jwt.ts, all callers of createAccessToken/verifyToken]
tech_stack:
  added: []
  patterns: [node:test + assert TDD, digest('base64url') direct HMAC output]
key_files:
  created:
    - web/src/lib/api-security/__tests__/jwt.test.ts
  modified:
    - web/src/lib/api-security/jwt.ts
    - env.example
    - .env.production.example
decisions:
  - "Use digest('base64url') directly from HMAC Buffer — no intermediate toString('binary') or base64UrlEncode wrapper needed for the signature segment"
  - "Throw AUTH_SECRET_MISCONFIGURED in production on missing/default secret; retain warn-only path in development"
metrics:
  duration: 132s
  completed_date: 2026-03-23
  tasks_completed: 2
  tests_added: 8
---

# Quick Task 65: JWT Security Fixes (WI-0559 + WI-0560)

**One-liner:** RFC-compliant HS256 signatures via `digest('base64url')` direct output + fail-closed `AUTH_SECRET_MISCONFIGURED` throw in production when secret is missing or equals the known default.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Fix createSignature base64url encoding (WI-0559) | bfbacb2 | jwt.ts |
| 2 | Fail closed on missing/default AUTH_SECRET in production (WI-0560) | c656a20 | jwt.ts, env.example, .env.production.example |
| RED | Failing test scaffolding (Tests 1-8) | 7721b8f | jwt.test.ts |

## What Changed

### WI-0559: createSignature fix

**Bug:** `createSignature()` called `.digest().toString('binary')` which corrupts non-ASCII bytes during the binary string roundtrip, producing non-standard HS256 signatures that fail standard verifiers.

**Fix:** Replaced with `crypto.createHmac('sha256', secret).update(message).digest('base64url')` — yields correct base64url directly from the HMAC Buffer with no intermediate conversion.

**Test vector used:**
- Message: `header.payload` (base64url-encoded `{"alg":"HS256","typ":"JWT"}` + `{"userId":"u1","iat":1000,"exp":9999}`)
- Secret: `rfc-parity-test-secret`
- Expected signature: `T_MGd_AfnoEl20N71NlIMY1ew0QP9-KxRYTgD9JxZbU`

### WI-0560: getAuthSecret fail-closed

**Bug:** `getAuthSecret()` fell back to `'dev-auth-secret-change-me'` in production with only a console.warn, allowing any actor with the known default to forge valid tokens.

**Fix:**
```typescript
function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET || process.env.CHEDDAR_AUTH_SECRET;
  const isInsecure = !secret || secret === 'dev-auth-secret-change-me';
  if (isInsecure) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'AUTH_SECRET_MISCONFIGURED: AUTH_SECRET is missing or set to the insecure default. ' +
          'Set a strong AUTH_SECRET in your production environment variables.'
      );
    }
    console.warn('⚠️  WARNING: Using default AUTH_SECRET. This is insecure in production.');
  }
  return secret || 'dev-auth-secret-change-me';
}
```

### Env example documentation

- `env.example`: Added comment marking AUTH_SECRET as REQUIRED in production with `openssl rand -hex 32` generation instruction and note about AUTH_SECRET_MISCONFIGURED error.
- `.env.production.example`: Added `AUTH_SECRET=<generate-with-openssl-rand-hex-32>` with required-in-production comment.

## Test Results

All 8 tests pass via `node --experimental-strip-types web/src/lib/api-security/__tests__/jwt.test.ts`:

| Test | Description | Result |
|------|-------------|--------|
| 1 | Signature matches `digest('base64url')` for fixed vector | PASS |
| 2 | verifyToken accepts token from createAccessToken | PASS |
| 3 | verifyToken rejects tampered token | PASS |
| 4 | verifyToken returns null for expired token | PASS |
| 5 | NODE_ENV=production + no secret → throws AUTH_SECRET_MISCONFIGURED | PASS |
| 6 | NODE_ENV=production + default secret → throws AUTH_SECRET_MISCONFIGURED | PASS |
| 7 | NODE_ENV=production + real secret → succeeds | PASS |
| 8 | NODE_ENV=development + no secret → warns but does not throw | PASS |

`npm --prefix web run lint` — exits 0 (2 pre-existing warnings in card.tsx, unrelated)
`npm --prefix web run test:decision:canonical` — 32/32 passed

## Deviations from Plan

None — plan executed exactly as written. The `.ts` extension in the import was required by `node --experimental-strip-types` ESM resolver (not mentioned in plan but a trivial mechanical requirement, handled inline).

## Work Items Closed

- WI-0559 moved to `WORK_QUEUE/COMPLETE/WI-0559.md`
- WI-0560 moved to `WORK_QUEUE/COMPLETE/WI-0560.md`

## Self-Check: PASSED

- `web/src/lib/api-security/__tests__/jwt.test.ts` — FOUND
- `web/src/lib/api-security/jwt.ts` — FOUND (modified)
- Commit `7721b8f` — FOUND (test RED)
- Commit `bfbacb2` — FOUND (WI-0559 fix GREEN)
- Commit `c656a20` — FOUND (WI-0560 fix GREEN)
