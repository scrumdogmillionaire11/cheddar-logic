---
phase: discord-hook-eligibility
plan: 02
type: execute
wave: 2
depends_on: [discord-hook-eligibility-01]
files_modified:
  - apps/worker/src/jobs/post_discord_cards.js
  - apps/worker/src/jobs/__tests__/post_discord_cards.test.js
autonomous: true
requirements: [DISCORD-HOOK-03, DISCORD-HOOK-04]
must_haves:
  truths:
    - "Discord posting eligibility is decided from one field: webhook_publish_status"
    - "Only PLAY and SLIGHT_EDGE cards are eligible to render/post"
    - "PASS_BLOCKED cards are excluded from posting output"
    - "Legacy pre-canonical payloads still have fallback behavior until backfill window ends"
  artifacts:
    - path: "apps/worker/src/jobs/post_discord_cards.js"
      provides: "Canonical publish-status based routing/filtering"
      contains: "webhook_publish_status"
    - path: "apps/worker/src/jobs/__tests__/post_discord_cards.test.js"
      provides: "Discord snapshot tests for PLAY and SLIGHT_EDGE-only output"
      contains: "webhook_publish_status"
  key_links:
    - from: "buildDiscordSnapshot"
      to: "classifyDecisionBucket"
      via: "canonical publish status path"
      pattern: "webhook_publish_status"
    - from: "buildDiscordSnapshot"
      to: "sectionLines"
      via: "PLAY and SLIGHT_EDGE only rendering"
      pattern: "PLAY|Slight Edge"
---

<objective>
Move Discord routing/filtering to the canonical publish-status field so only PLAY and SLIGHT EDGE appear in webhook output.

Purpose: Enforce one clear posting rule at the formatter layer while preserving temporary fallbacks for historical payloads lacking canonical status.
Output: Formatter classifies and renders from `webhook_publish_status`; tests lock PLAY + SLIGHT_EDGE only behavior.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/discord-hook-eligibility/discord-hook-eligibility-01-SUMMARY.md
@apps/worker/src/jobs/post_discord_cards.js
@apps/worker/src/jobs/__tests__/post_discord_cards.test.js
@apps/worker/src/utils/decision-publisher.js

<interfaces>
From plan 01 canonical contract:

```js
payload.webhook_publish_status = 'PLAY' | 'SLIGHT_EDGE' | 'PASS_BLOCKED';
```

Formatter mapping target:

```js
PLAY -> official section
SLIGHT_EDGE -> lean section
PASS_BLOCKED -> excluded from outgoing posted lines
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Switch Discord classification/filtering to canonical publish status</name>
  <files>apps/worker/src/jobs/post_discord_cards.js</files>
  <behavior>
    - Test 1: `webhook_publish_status=PLAY` renders under PLAY section.
    - Test 2: `webhook_publish_status=SLIGHT_EDGE` renders under Slight Edge section.
    - Test 3: `webhook_publish_status=PASS_BLOCKED` is not rendered/posted.
    - Test 4: Missing canonical field still uses existing legacy fallback logic.
  </behavior>
  <action>
    Update `classifyDecisionBucket`, displayability checks, and lean-threshold gate integration to prefer `webhook_publish_status` as the first decision source.

    Canonical mapping:
    - PLAY -> official bucket
    - SLIGHT_EDGE -> lean bucket
    - PASS_BLOCKED -> pass_blocked bucket (excluded from posted lines)

    Keep current legacy fallback helpers for old payload rows with no canonical field. Do not remove fallback in this plan.
  </action>
  <verify>
    <automated>npm --prefix apps/worker test -- src/jobs/__tests__/post_discord_cards.test.js</automated>
  </verify>
  <done>Discord posting path is canonical-first and deterministically enforces PLAY + SLIGHT_EDGE-only output.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Add regression tests proving only PLAY and SLIGHT_EDGE are posted</name>
  <files>apps/worker/src/jobs/__tests__/post_discord_cards.test.js</files>
  <behavior>
    - Test 1: Mixed fixture with PLAY/SLIGHT_EDGE/PASS_BLOCKED posts only PLAY and SLIGHT_EDGE lines.
    - Test 2: PASS_BLOCKED rows contribute zero posted lines and zero section counts for outgoing cards.
    - Test 3: Legacy no-canonical fixture still posts according to legacy inference rules.
  </behavior>
  <action>
    Add snapshot/structured assertions in Discord job tests to verify outgoing content, section counts, and per-card inclusion against canonical publish status.

    Include at least one fixture from each market family (game lines, game props, player props) to guarantee cross-market consistency of posting behavior.
  </action>
  <verify>
    <automated>npm --prefix apps/worker test -- src/jobs/__tests__/post_discord_cards.test.js</automated>
  </verify>
  <done>Tests guarantee webhook output contains only PLAY and SLIGHT_EDGE cards when canonical status is present.</done>
</task>

</tasks>

<verification>
- Run Discord posting tests and verify canonical-status fixtures pass.
- Validate generated messages contain PLAY and Slight Edge sections only for canonical payloads.
</verification>

<success_criteria>
- Discord job posting eligibility is controlled by `webhook_publish_status`.
- Canonical payloads post only PLAY and SLIGHT_EDGE cards.
- PASS_BLOCKED is consistently excluded from outgoing content.
- Legacy payload compatibility is retained for rollout safety.
</success_criteria>

<output>
After completion, create `.planning/phases/discord-hook-eligibility/discord-hook-eligibility-02-SUMMARY.md`
</output>
