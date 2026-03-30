---
ID: WI-0702
Goal: |
  Add explicit query timeout to /api/games route and fail gracefully on slow queries.
  Prevent Cloudflare from returning 502 due to backend hanging;
  return partial or cached data instead.
Status: queued
Dependency: Start only after WI-0701 PR review is complete and WI-0701 is merged to main
Priority: high
Scope: |
  - web/src/lib/games/route-handler.ts
    - GET function main query execution
    - Add stage-level request budget and degraded response modes
    - Apply read-only busy_timeout and stale-cache fallback
  - web/src/__tests__/api-games-timeout-resilience.test.js
    - Route-level timeout/degraded response coverage
  - web/src/__tests__/api-games-repair-budget.test.js
    - Source contract coverage for timeout meta fields
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
Owner agent: gsd-executor
CLAIM: gsd-executor 2026-03-29T23:47:39Z
Time window: 3-4 hours
Coordination flag: needs-sync (modifies shared API contract)
Tests to run: |
  node web/src/__tests__/api-games-timeout-resilience.test.js
  npm --prefix web run test:api:games:repair-budget
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
1. Use stage-level request budget checks plus SQLite read-only busy_timeout (5 seconds default)
2. If query times out:
   - Log warning with query duration
   - Return 200 with degraded base-game rows or stale cached payload instead of 500 error
   - Preserve user experience over perfect data freshness
3. Monitor slow queries (>3s) for operational visibility

## Implementation Notes
- Queue behind WI-0701 merge so backend timeout behavior is evaluated on top of the preserved-games UX already in place.
- Do not use `AbortSignal` for DB query cancellation; read path is synchronous `better-sqlite3`
- Prefer response modes `full`, `degraded_base_games`, and `stale_cache`
- Add performance logging: queryDuration, rowCount, timeoutOccurred, timeoutStage, responseMode
- Route should return `{success: true, data: [...], meta: {response_mode, timeout_fallback}}`

## Testing Strategy
- Inject slow DB mock, verify timeout handling
- Load test with concurrent requests
- Monitor error logs for slow query warnings

## Related
- Debug session: .planning/debug/resolved/prod-plays-disappear-reappear.md
- Root cause: DB contention during worker snapshot + no query timeout
- See also: WI-0703 (investigating worker snapshot contention)
