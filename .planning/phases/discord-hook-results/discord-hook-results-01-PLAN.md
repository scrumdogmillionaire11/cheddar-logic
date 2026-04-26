---
phase: discord-hook-results
plan: 01
type: execute
wave: 3
depends_on: [discord-hook-eligibility-02]
files_modified:
  - apps/worker/src/jobs/post_discord_cards.js
  - apps/worker/src/jobs/__tests__/post_discord_cards.test.js
  - .planning/ROADMAP.md
  - .planning/phases/discord-hook-results/discord-hook-results-01-PLAN.md
  - .planning/phases/discord-hook-results/discord-hook-results-01-SUMMARY.md
  - WORK_QUEUE/WI-1164.md
autonomous: true
status: complete
completed_at: "2026-04-24T19:52:57Z"
requirements: [WI-1164-DISCORD-RESULTS-01, WI-1164-DISCORD-RESULTS-02, WI-1164-DISCORD-RESULTS-03]
must_haves:
  truths:
    - "Operators can see each Discord webhook target's final send outcome without opening runtime logs"
    - "Successful, failed, and retried webhook attempts are summarized in one operator-readable block"
    - "A run with mixed outcomes is marked as partial failure without hiding successful sends"
    - "Failed target label and failure reason are visible in both returned job data and operator-facing summary output"
  artifacts:
    - path: "apps/worker/src/jobs/post_discord_cards.js"
      provides: "Structured per-target transport results and operator-facing summary output"
      contains: "deliveryResults"
    - path: "apps/worker/src/jobs/__tests__/post_discord_cards.test.js"
      provides: "Discord transport result regression coverage for success, partial failure, and retry flows"
      contains: "partial failure"
  key_links:
    - from: "post_discord_cards job"
      to: "returned job payload"
      via: "deterministic transport results key"
      pattern: "deliveryResults|transportResults"
    - from: "post_discord_cards job"
      to: "operator-facing summary output"
      via: "final result block"
      pattern: "partialFailure|failed|retried"
---

<objective>
Surface structured Discord webhook delivery results in both the returned job payload and the operator-facing summary output.

Purpose: Make webhook transport outcomes debuggable and operationally visible without requiring operators to inspect raw runtime logs.
Output: The Discord posting job reports per-target delivery results, aggregate transport counts, and explicit partial-failure details with regression coverage.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/discord-hook-eligibility/discord-hook-eligibility-02-PLAN.md
@apps/worker/src/jobs/post_discord_cards.js
@apps/worker/src/jobs/__tests__/post_discord_cards.test.js
@WORK_QUEUE/WI-1163.md
@WORK_QUEUE/WI-1164.md

<interfaces>
From the canonical eligibility phase:

```js
payload.webhook_publish_status = 'PLAY' | 'SLIGHT_EDGE' | 'PASS_BLOCKED';
```

Transport result contract to add for this plan:

```js
{
  targetLabel: string,
  status: 'success' | 'failed',
  attemptCount: number,
  retryCount: number,
  elapsedMs: number,
  httpStatus: number | null,
  error: string | null,
  postedCardCount: number | null,
}
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Record structured per-target Discord delivery results in the posting path</name>
  <files>apps/worker/src/jobs/post_discord_cards.js</files>
  <behavior>
    - Test 1: A successful webhook target emits one structured result with success status, attempt counts, elapsed time, and posted card count.
    - Test 2: A failed webhook target emits one structured result with failed status, attempt counts, elapsed time, and HTTP status or error token.
    - Test 3: A retry-then-success target records retry count and final success in the returned transport results.
  </behavior>
  <action>
    Extend the webhook sender path to collect deterministic per-target transport results for every attempted Discord webhook target.

    Include target label, final status, attempt count, retry count, elapsed milliseconds, HTTP status when present, error token/message when present, and posted card count when successful.

    Return these results under a deterministic transport-results key in the job payload so downstream callers can inspect outcomes programmatically.
  </action>
  <verify>
    <automated>npm --prefix apps/worker test -- src/jobs/__tests__/post_discord_cards.test.js</automated>
  </verify>
  <done>Returned job payload exposes structured delivery results for each attempted Discord webhook target.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Add operator-facing transport summary and partial-failure reporting</name>
  <files>apps/worker/src/jobs/post_discord_cards.js, apps/worker/src/jobs/__tests__/post_discord_cards.test.js</files>
  <behavior>
    - Test 1: All-success delivery renders success, failure, and retry counts with per-target success lines.
    - Test 2: Mixed success/failure delivery marks the run as partial failure and renders failed target label plus failure reason.
    - Test 3: Retry-then-success delivery reports the retry count without marking the run as failed.
  </behavior>
  <action>
    Add an operator-readable transport results block to the job completion output with aggregate counts for success, failed, and retried targets plus one compact per-target line showing target label, final status, attempts, and posted card count or failure reason.

    When any target fails, expose a deterministic partial-failure flag or summary field in the returned result and render failed target label plus failure reason in the operator-facing result block.

    Lock the final output contract in tests by asserting summary counts, partial-failure marker, failed target detail lines, and retry reporting rather than only asserting helper state.
  </action>
  <verify>
    <automated>npm --prefix apps/worker test -- src/jobs/__tests__/post_discord_cards.test.js</automated>
  </verify>
  <done>Operators can read one transport-results block and immediately understand what was sent, what failed, why it failed, and whether the run ended in partial failure.</done>
</task>

</tasks>

<verification>
- Run the Discord posting test slice and confirm the structured transport-results contract passes for success, mixed-outcome, and retry scenarios.
- Verify the final result block reports success, failed, and retried counts plus failed target label and reason when applicable.
</verification>

<success_criteria>
- Every attempted Discord webhook target produces a structured transport result.
- Operator-facing job output includes one readable transport-results block with aggregate counts and per-target outcome lines.
- Mixed-outcome runs are explicitly marked as partial failure without hiding successful sends.
- Tests lock the returned payload contract and final result block content for all-success, partial-failure, and retry-then-success scenarios.
</success_criteria>

<output>
After completion, create `.planning/phases/discord-hook-results/discord-hook-results-01-SUMMARY.md`
</output>
