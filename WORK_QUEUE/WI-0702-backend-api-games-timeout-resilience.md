---
ID: WI-0702
Goal: |
  Add explicit query timeout to /api/games route and fail gracefully on slow queries.
  Prevent Cloudflare from returning 502 due to backend hanging;
  return partial or cached data instead.
Status: ready
Priority: high
Scope: |
  - web/src/lib/games/route-handler.ts
    - GET function main query execution
    - Add query timeout assertion/abort signal
    - Return strategy on timeout (partial vs cached vs empty)
  - web/src/lib/db-init.ts
    - Verify read-only DB doesn't have multi-second hangs
  - Possibly: packages/data/src/db/query-builder.ts
    - If query builder needs timeout hints
Out of scope: |
  - Worker snapshot mechanism (separate WI)
  - Frontend error handling (WI-0701)
  - Database locking/WAL config
Acceptance: |
  ✓ /api/games query completes within 5 seconds (user-visible timeout)
  ✓ If query hangs past 5s, route returns 200 with partial/previous data (not 500/502)
  ✓ Error logging captures slow query attempts
  ✓ Cloudflare no longer sees 502 on DB contention
  ✓ Load tests show query completes <5s consistently
Owner agent: (claim required)
Time window: 3-4 hours
Coordination flag: needs-sync (modifies shared API contract)
Tests to run: |
  npm run test -- web/src/lib/games/route-handler.test.ts
  npm run test:load -- /api/games (if load test suite exists)
Manual validation: |
  1. Deploy to staging with simulated slow DB query
  2. Verify /api/games returns 200 with data (not timeout/502)
  3. Monitor production logs for slow query warnings after deploy
Decision link: false
PR requirements: |
  - Linked to debug session: .planning/debug/resolved/prod-plays-disappear-reappear.md
  - Performance test shows query <5s under load
  - ErrorLog records query slower than 3s (warn threshold)
  - Coordinate with team on partial data strategy
---

# Backend: Add Query Timeout to /api/games Route

## Problem
/api/games route can hang indefinitely on slow/locked DB queries, causing Cloudflare to return 502 after ~30s timeout. Users see playable disappear and reappear as backend struggles.

## Root Cause
No explicit query timeout in route handler. Large or complex queries can block for extended periods during DB contention (e.g., worker snapshot rotation).

## Solution
Add query timeout to /api/games route:
1. Wrap main query execution with AbortSignal timeout (5-10 seconds)
2. If query times out:
   - Log warning with query duration
   - Return 200 with partial/cached games instead of 500 error
   - Preserve user experience over perfect data freshness
3. Monitor slow queries (>3s) for operational visibility

## Implementation Notes
- Use existing `createTimeoutSignal` pattern if available, or implement server-side timeout
- Consider returning last N games if fresh query fails
- Add performance logging: queryDuration, rowCount, timeoutOccurred
- Route should return `{success: true, data: [...], meta: {timeout_fallback: true}}`

## Testing Strategy
- Inject slow DB mock, verify timeout handling
- Load test with concurrent requests
- Monitor error logs for slow query warnings

## Related
- Debug session: .planning/debug/resolved/prod-plays-disappear-reappear.md
- Root cause: DB contention during worker snapshot + no query timeout
- See also: WI-0703 (investigating worker snapshot contention)
