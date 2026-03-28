---
phase: quick-86
plan: 86
subsystem: security/auth
tags: [jwt, revocation, sqlite, security, wi-0608]
dependency_graph:
  requires: [packages/data/src/db.js, packages/data/index.js]
  provides: [persistent JWT revocation, revokeToken export, jti claim in every token]
  affects: [web/src/lib/api-security/jwt.ts]
tech_stack:
  added: [better-sqlite3 revoked_tokens table]
  patterns: [INSERT OR IGNORE for idempotent revocation, sync DB read in verifyToken hot path]
key_files:
  created:
    - packages/data/db/migrations/049_create_revoked_tokens.sql
  modified:
    - packages/data/src/db.js
    - packages/data/index.js
    - web/src/lib/api-security/jwt.ts
    - web/src/lib/api-security/__tests__/jwt.test.ts
    - web/tsconfig.json
decisions:
  - Used INSERT OR IGNORE for insertRevokedToken to make revocation idempotent
  - Used default import + destructure for @cheddar-logic/data (CJS/ESM interop in Node 24 ESM)
  - Excluded __tests__ dirs from tsconfig — production build does not need test files in type check
  - pruneRevoked called at module load (best-effort, catches errors silently)
metrics:
  duration: ~20 minutes
  completed: 2026-03-28
  tasks_completed: 2
  tasks_total: 2
  files_modified: 6
---

# Phase quick-86 Plan 86: WI-0608 JWT Revocation Persistence Summary

JWT revocation moved from an in-memory Set to a persistent SQLite `revoked_tokens` table — revoked tokens remain invalid across server restarts and deploys.

## What Was Built

**Migration 049** — `packages/data/db/migrations/049_create_revoked_tokens.sql`

Creates `revoked_tokens(jti TEXT PK, revoked_at INTEGER, expires_at INTEGER)` with an index on `expires_at` to bound prune cost.

**Three DB functions** — `packages/data/src/db.js` + `packages/data/index.js`

- `insertRevokedToken(jti, expiresAt)` — INSERT OR IGNORE (idempotent)
- `isTokenRevoked(jti)` — sync SELECT, returns boolean
- `pruneExpiredRevokedTokens()` — DELETE WHERE expires_at < now, returns row count

All three exported from `packages/data/index.js`.

**jwt.ts changes** — `web/src/lib/api-security/jwt.ts`

- `AuthToken` interface gains optional `jti?: string`
- `createAccessToken` embeds `jti: crypto.randomUUID()` in every token payload
- `verifyToken` calls `isTokenRevoked(payload.jti)` after signature + expiry checks — returns `null` if revoked
- New `revokeToken(token: string): void` export — decodes without sig verify, calls `insertRevokedToken`
- `pruneRevoked()` called at module load (best-effort, catches silently)

**Tests** — `web/src/lib/api-security/__tests__/jwt.test.ts`

Added 3 tests in `WI-0608: DB revocation persistence` describe block:
- Test 9: `createAccessToken` embeds a non-empty `jti` field
- Test 10: `revokeToken` + `verifyToken` returns null for the revoked token
- Test 11: revoking token-A does not affect token-B (different jti — isolation)

All 11 tests pass (8 pre-existing + 3 new).

## Verification Results

```
✔ WI-0559: createSignature RFC parity (4 tests)
✔ WI-0560: getAuthSecret fail-closed in production (4 tests)
✔ WI-0608: DB revocation persistence (3 tests)
tests: 11 pass, 0 fail

npx tsc --noEmit --project web/tsconfig.json → exit 0
```

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 | 03f3ed9 | feat(quick-86): add revoked_tokens migration + DB revocation functions |
| Task 2 | 34adcd7 | feat(quick-86): wire jti + DB revocation into jwt.ts; 3 new WI-0608 tests |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed test runner ESM module resolution**

- **Found during:** Task 2 verification
- **Issue:** `node --experimental-strip-types` with `type: module` in `web/package.json` cannot resolve bare `.ts` imports (`from '../jwt'`) — requires explicit `.ts` extension. This was a pre-existing failure: the test was broken before this task.
- **Fix:** Changed test import to `from '../jwt.ts'`; excluded `src/**/__tests__` from `web/tsconfig.json` (tsc with `moduleResolution: bundler` does not allow `.ts` extensions in imports, but the test runner requires them).
- **Files modified:** `web/src/lib/api-security/__tests__/jwt.test.ts`, `web/tsconfig.json`

**2. [Rule 3 - Blocking] CJS/ESM named export interop for @cheddar-logic/data**

- **Found during:** Task 2 — first test run
- **Issue:** Node 24 ESM cannot use named import syntax for CommonJS modules (`import { fn } from 'cjs-pkg'` fails with "Named export 'fn' not found").
- **Fix:** Changed jwt.ts import to default import + destructure: `import cheddarData from '@cheddar-logic/data'; const { insertRevokedToken, ... } = cheddarData as { ... }`. Also added the three revocation functions to `packages/data/index.js` exports (they existed in db.js but were not re-exported from the package entry point).
- **Files modified:** `web/src/lib/api-security/jwt.ts`, `packages/data/index.js`

## Self-Check: PASSED

- FOUND: packages/data/db/migrations/049_create_revoked_tokens.sql
- FOUND: web/src/lib/api-security/jwt.ts
- FOUND: WORK_QUEUE/COMPLETE/WI-0608.md
- FOUND: commit 03f3ed9
- FOUND: commit 34adcd7
