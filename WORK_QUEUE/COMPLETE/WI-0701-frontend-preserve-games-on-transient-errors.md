---
ID: WI-0701
Goal: |
  Prevent plays from disappearing from UI during transient backend failures.
  Ensure games data is preserved when fetch fails due to 5xx errors or timeouts,
  even on initial page load.
Status: ready
Priority: high
Scope: |
  - web/src/components/cards/CardsPageContext.tsx
    - Error handlers for HTTP failures
    - isInitialLoad conditional logic in setGames([]) branches
    - All error paths that currently clear games state
  - web/src/components/cards/shared.ts
    - Related constants for fetch behavior
Out of scope: |
  - Backend API route changes
  - Worker snapshot mechanism
  - Route handler timeout logic
Acceptance: |
  ✓ Games data is preserved (not cleared) when fetch fails with 5xx status
  ✓ Games data is preserved when fetch times out or aborts
  ✓ Games data is cleared only on non-recoverable errors (auth, malformed response)
  ✓ Error message is still displayed to user
  ✓ All existing tests pass
  ✓ New test added: transient 5xx error preserves games on initial load
Owner agent: (claim required)
Time window: 2-3 hours
Coordination flag: false
Tests to run: |
  npm run test -- web/src/components/cards/CardsPageContext.test.tsx
  npm run test:e2e -- cards-transient-error
Manual validation: |
  1. Start web server in dev mode
  2. Open cards page
  3. Mock API to return 502 on /api/games
  4. Verify: error message shown, but last known games remain visible
  5. Stop mock; verify next poll succeeds and games stay visible
Decision link: false
PR requirements: |
  - Linked to debug session: .planning/debug/resolved/prod-plays-disappear-reappear.md
  - Tests pass including new transient error case
  - Code review focused on error handling logic change
---

# Frontend: Preserve Games on Transient Fetch Failures

## Problem
When `/api/games` returns a transient error (502/timeout), the cards UI clears the games state completely, making plays appear to disappear. Even though the interval poll recovers minutes later, the user sees a jarring empty state.

## Root Cause
CardsPageContext.tsx sets `setGames([])` on error when `isInitialLoad.current === true`, clearing all data. While subsequent interval refreshes preserve data (due to `isInitialLoad` staying false), the initial page load or lifecycle-triggered refetch can wipe games.

## Solution
Change error handling to ONLY clear games on non-recoverable errors (auth, malformed response). Preserve last-known data on transient failures (5xx, timeout, abort).

**Key changes:**
1. In error paths: differentiate recoverable (5xx, timeout, abort) vs non-recoverable (400, 401, malformed JSON)
2. Only call `setGames([])` for non-recoverable errors
3. Always preserve or show last-known games on 5xx/timeout

## Implementation Notes
- Look for all `setGames([])` callsites in error branches (lines ~586, ~722, ~734, ~744, ~782)
- Add helper to classify error as recoverable or not
- Ensure `setError()` is still called so user sees error message
- Update loading state appropriately

## Testing Strategy
- Unit: mock fetch to return 502, verify setGames NOT called
- Unit: mock fetch malformed JSON, verify setGames IS called
- E2E: simulate transient outage, verify games remain visible

## Related
- Debug session: .planning/debug/resolved/prod-plays-disappear-reappear.md
- Root cause: worker snapshot contention + frontend clears state too aggressively
- Merge of WI-0701 unblocks WI-0702 backend timeout resilience work.
