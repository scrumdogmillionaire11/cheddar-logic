---
phase: quick-101
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - web/src/components/cards/CardsPageContext.tsx
  - web/src/__tests__/cards-transient-error-preserves-games.test.js
autonomous: true
requirements: [WI-0701]

must_haves:
  truths:
    - "Games state is preserved (not cleared) when fetch returns 5xx"
    - "Games state is preserved when fetch times out or is aborted"
    - "Games state is cleared only on non-recoverable errors (malformed JSON, auth)"
    - "Error message is still shown to user on all error paths"
    - "New test file passes: transient 5xx and timeout preserve games, malformed JSON clears games"
  artifacts:
    - path: "web/src/components/cards/CardsPageContext.tsx"
      provides: "Updated error handling with recoverable/non-recoverable classification"
      contains: "isRecoverableHttpError"
    - path: "web/src/__tests__/cards-transient-error-preserves-games.test.js"
      provides: "Source-assertion tests for WI-0701 acceptance criteria"
  key_links:
    - from: "CardsPageContext.tsx fetch error path (!response.ok)"
      to: "isRecoverableHttpError(status)"
      via: "helper function called before setGames([])"
      pattern: "isRecoverableHttpError"
    - from: "CardsPageContext.tsx catch block"
      to: "abort/timeout detection"
      via: "isAbort check already present — no setGames([]) in catch"
      pattern: "isAbort.*setGames"
---

<objective>
Fix CardsPageContext.tsx to preserve games state on transient backend failures (5xx, timeout, abort). Currently all error paths that execute while `isInitialLoad.current === true` call `setGames([])`, wiping plays from the UI. The fix introduces a recoverable/non-recoverable classification so only auth and malformed-response errors clear state.

Purpose: Stop plays from disappearing during transient outages (502, timeouts) — both on initial load and lifecycle-triggered refetches.
Output: Updated CardsPageContext.tsx + regression test that asserts the correct behavior by inspecting source.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@WORK_QUEUE/WI-0701-frontend-preserve-games-on-transient-errors.md

<interfaces>
<!-- Key error-path lines in CardsPageContext.tsx (from current source). -->
<!-- Executor must update these callsites, not add new logic elsewhere. -->

Line 713-725  (!response.ok branch):
  - Calls setGames([]) unconditionally when isInitialLoad.current === true
  - Status codes 5xx (502, 503, 504) are transient — SHOULD NOT clear games
  - Status codes 401, 400, 404 are non-recoverable — SHOULD clear games

Line 728-737  (non-JSON body branch):
  - Calls setGames([]) unconditionally when isInitialLoad.current === true
  - Content-type mismatch is non-recoverable — SHOULD clear games (keep as-is)

Line 740-747  (!data.success branch):
  - Calls setGames([]) unconditionally when isInitialLoad.current === true
  - data.success=false is non-recoverable (bad response shape) — SHOULD clear games (keep as-is)

Line 770-783  (catch block):
  - Already has isAbort check: if (!cancelled && !isAbort) { setError; if (isInitialLoad) setGames([]) }
  - AbortError/TimeoutError paths already skip setGames (isAbort guard)
  - Non-abort network errors (e.g. fetch() threw) could be transient — classify as recoverable
  - Best: skip setGames([]) for ALL caught errors (abort already skipped; any thrown error is transient)
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add isRecoverableHttpError helper and fix !response.ok + catch error paths</name>
  <files>web/src/components/cards/CardsPageContext.tsx</files>
  <behavior>
    - isRecoverableHttpError(status: number): boolean returns true for 429, 5xx (status >= 500 || status === 429); returns false for 400, 401, 403, 404
    - The !response.ok branch (line ~721): only calls setGames([]) when !isRecoverableHttpError(response.status) AND isInitialLoad.current
    - The catch block (line ~781): removes the setGames([]) call entirely — all thrown fetch errors are transient (abort already guarded; network errors should not wipe state)
    - The non-JSON body branch (line ~733) and !data.success branch (line ~743) are non-recoverable — keep setGames([]) unchanged
    - setError() is called on ALL error paths regardless of recoverability — error message always shown
  </behavior>
  <action>
    Add a pure helper function `isRecoverableHttpError(status: number): boolean` near the top of the component file (alongside other helpers or in the same module block) that returns true when `status >= 500 || status === 429`.

    Then apply three targeted changes in the `fetchGames` function:

    1. In the `!response.ok` branch (currently lines ~719-725): wrap the `setGames([])` call so it only executes when `isInitialLoad.current && !isRecoverableHttpError(response.status)`. The `setError(nonJsonDetail)` call is unchanged — always runs.

    2. In the `catch` block (currently lines ~779-783): remove the `if (isInitialLoad.current) { setGames([]); }` block entirely. The `setError(message)` call stays — always runs for non-abort errors. The existing `!isAbort` guard on `setError` stays as-is.

    3. Do NOT modify the non-JSON body branch (line ~733) or the !data.success branch (line ~743) — those remain recoverable.

    Note: The 429 rate-limit branch (line ~684-696) never calls setGames — that is already correct and should not be touched.

    After edits, run: cd /Users/ajcolubiale/projects/cheddar-logic/web && npx tsc --noEmit 2>&1 | head -30
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic/web && npx tsc --noEmit 2>&1 | head -20 && echo "TSC_OK"</automated>
  </verify>
  <done>
    - `isRecoverableHttpError` function exists in CardsPageContext.tsx
    - `!response.ok` branch only calls `setGames([])` for non-recoverable statuses (e.g. 401, 404) — not for 5xx or 429
    - `catch` block no longer calls `setGames([])` under any condition
    - `setError()` still called on every error path
    - TypeScript compiles with no errors
  </done>
</task>

<task type="auto">
  <name>Task 2: Write regression test asserting transient-error behavior</name>
  <files>web/src/__tests__/cards-transient-error-preserves-games.test.js</files>
  <action>
    Create a new source-assertion test file following the project pattern (see `cards-lifecycle-fetch-race.test.js` for style). Read the CardsPageContext.tsx source and assert:

    1. `isRecoverableHttpError` function is defined and exported/used
    2. The `!response.ok` block contains a call to `isRecoverableHttpError` that guards `setGames([])`
    3. The catch block does NOT contain `setGames([])` (assert absence)
    4. `setError(` still appears in the `!response.ok` block and the `catch` block (error messages preserved)

    Test file header comment: "WI-0701: Transient fetch errors preserve games state"
    Run command: `node --import tsx/esm web/src/__tests__/cards-transient-error-preserves-games.test.js`

    The test file should use `import assert from 'node:assert'` and `import fs from 'node:fs'`, read the CardsPageContext.tsx source, then make string-based assertions. Each assertion should have a clear failure message.
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && node --import tsx/esm web/src/__tests__/cards-transient-error-preserves-games.test.js</automated>
  </verify>
  <done>
    Test file exists and all assertions pass. Output ends with a summary line confirming all WI-0701 tests passed.
  </done>
</task>

</tasks>

<verification>
1. TypeScript: `cd /Users/ajcolubiale/projects/cheddar-logic/web && npx tsc --noEmit` — exits 0
2. New test: `node --import tsx/esm web/src/__tests__/cards-transient-error-preserves-games.test.js` — all pass
3. Spot-check: `grep -n "isRecoverableHttpError\|setGames(\[\])" /Users/ajcolubiale/projects/cheddar-logic/web/src/components/cards/CardsPageContext.tsx` — `setGames([])` only appears under non-JSON and !data.success branches; never in catch; never in !response.ok without the guard
</verification>

<success_criteria>
- 5xx responses: `setGames([])` is NOT called; error message IS shown; games state is preserved
- Timeout / abort: `setGames([])` is NOT called (catch block drops it entirely)
- 401 / malformed JSON / data.success=false: `setGames([])` IS called (non-recoverable)
- TypeScript compiles clean
- New test file passes
</success_criteria>

<output>
After completion, create `.planning/quick/101-wi-0701/101-SUMMARY.md` with what was changed, the line numbers modified, and confirmation that acceptance criteria are met.
</output>
