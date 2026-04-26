---
phase: discord-hook-eligibility
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/utils/decision-publisher.js
  - apps/worker/src/utils/__tests__/decision-publisher.v2.test.js
autonomous: true
requirements: [DISCORD-HOOK-01, DISCORD-HOOK-02]
must_haves:
  truths:
    - "Each card kind (game lines, game props, player props) has one canonical webhook publish status field derived at publisher time"
    - "Canonical publish status domain is explicitly constrained to PLAY, SLIGHT_EDGE, PASS_BLOCKED"
    - "Legacy aliases (FIRE/BASE/LEAN/WATCH/HOLD and official/lean/pass_blocked) are normalized once in publisher code, not in Discord formatter"
    - "Cards with canonical status PASS_BLOCKED are marked webhook_eligible=false and cannot be posted"
  artifacts:
    - path: "apps/worker/src/utils/decision-publisher.js"
      provides: "Canonical cross-market webhook publish status field stamping"
      contains: "webhook_publish_status"
    - path: "apps/worker/src/utils/__tests__/decision-publisher.v2.test.js"
      provides: "Cross-market normalization tests for game lines, game props, player props"
      contains: "webhook_publish_status"
  key_links:
    - from: "publishDecisionForCard"
      to: "computeWebhookFields"
      via: "publisher post-processing"
      pattern: "computeWebhookFields"
    - from: "computeWebhookFields"
      to: "payload.webhook_publish_status"
      via: "single canonical status stamp"
      pattern: "webhook_publish_status"
---

<objective>
Define one canonical cross-market gating field for Discord posting so game lines, game props, and player props share the same publish decision semantics.

Purpose: Remove remaining ambiguity between internal statuses and webhook buckets by introducing a single canonical field that decides publishability independent of market family.
Output: Publisher stamps `webhook_publish_status` on all card payloads and tests lock behavior across market families.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/discord-3layer/discord-3layer-02-SUMMARY.md
@apps/worker/src/utils/decision-publisher.js
@apps/worker/src/utils/__tests__/decision-publisher.v2.test.js
@WORK_QUEUE/WI-1160.md
@WORK_QUEUE/WI-1161.md

<interfaces>
From `decision-publisher.js` (existing):

```js
function computeWebhookFields(payload) {
  // currently stamps webhook_bucket/webhook_eligible/webhook_display_side/webhook_lean_eligible/reason_code
}
```

Target contract to add:

```js
payload.webhook_publish_status = 'PLAY' | 'SLIGHT_EDGE' | 'PASS_BLOCKED';
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add canonical webhook publish status contract in publisher</name>
  <files>apps/worker/src/utils/decision-publisher.js</files>
  <behavior>
    - Test 1: Game-line PLAY card stamps `webhook_publish_status=PLAY`.
    - Test 2: Lean/surface-slight-edge card stamps `webhook_publish_status=SLIGHT_EDGE`.
    - Test 3: PASS/blocked card stamps `webhook_publish_status=PASS_BLOCKED` and `webhook_eligible=false`.
    - Test 4: Alias inputs (FIRE/BASE, LEAN/WATCH/HOLD, official/lean/pass_blocked) normalize to canonical domain.
  </behavior>
  <action>
    In `computeWebhookFields(payload)`, add one canonical `webhook_publish_status` field that is always stamped for every card kind and market family.

    Domain rules:
    - `PLAY` = actionable official play
    - `SLIGHT_EDGE` = actionable lean/watch state intended for Discord lean section
    - `PASS_BLOCKED` = not postable (blocked/pass)

    Keep existing `webhook_bucket` fields for backward compatibility in this plan, but make them derived from the canonical status in one place. Avoid adding new fallback branching in Discord code in this task.
  </action>
  <verify>
    <automated>npm --prefix apps/worker test -- src/utils/__tests__/decision-publisher.v2.test.js</automated>
  </verify>
  <done>Publisher stamps `webhook_publish_status` on every payload and existing webhook fields remain backward compatible.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Add cross-market contract tests for lines, game props, and player props</name>
  <files>apps/worker/src/utils/__tests__/decision-publisher.v2.test.js</files>
  <behavior>
    - Test 1: Representative game-line payload maps to PLAY.
    - Test 2: Representative game-prop payload maps to SLIGHT_EDGE.
    - Test 3: Representative player-prop payload maps to PASS_BLOCKED.
    - Test 4: No tested payload emits a status outside PLAY/SLIGHT_EDGE/PASS_BLOCKED.
  </behavior>
  <action>
    Extend publisher tests with explicit fixtures for game lines, game props, and player props to validate canonical status stamping and bucket derivation.

    Ensure tests assert both:
    - canonical `webhook_publish_status`
    - legacy compatibility (`webhook_bucket`, `webhook_eligible`) derived from canonical status.
  </action>
  <verify>
    <automated>npm --prefix apps/worker test -- src/utils/__tests__/decision-publisher.v2.test.js</automated>
  </verify>
  <done>Regression tests prove one canonical publish-status contract works across all three market families.</done>
</task>

</tasks>

<verification>
- Run publisher test suite and confirm all canonical publish-status assertions pass.
- Confirm no production code path in publisher writes non-canonical status values.
</verification>

<success_criteria>
- `webhook_publish_status` exists for all newly published cards.
- Canonical domain is locked to PLAY/SLIGHT_EDGE/PASS_BLOCKED.
- Legacy bucket fields remain stable and fully derived from canonical status.
</success_criteria>

<output>
After completion, create `.planning/phases/discord-hook-eligibility/discord-hook-eligibility-01-SUMMARY.md`
</output>
