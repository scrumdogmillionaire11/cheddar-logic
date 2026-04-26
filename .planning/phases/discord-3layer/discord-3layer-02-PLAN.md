---
phase: discord-3layer
plan: 02
type: execute
wave: 2
depends_on: [discord-3layer-01]
files_modified:
  - apps/worker/src/jobs/post_discord_cards.js
  - apps/worker/src/jobs/__tests__/post_discord_cards.test.js
autonomous: true
requirements: [DISCORD-LAYER-04, DISCORD-LAYER-05]

must_haves:
  truths:
    - "Canonical payloads are routed using pre-stamped webhook fields (bucket, eligibility, display side, lean eligibility) with no NHL totals model inference in Discord"
    - "classifyDecisionBucket() returns payload.webhook_bucket when present"
    - "isDisplayableWebhookCard() returns payload.webhook_eligible when present"
    - "selectionSummary() returns payload.webhook_display_side as first priority"
    - "passesLeanThreshold() returns payload.webhook_lean_eligible when present"
    - "Discord section placement (PLAY/SLIGHT EDGE/PASS_BLOCKED) matches canonical webhook_bucket values for canonical payloads"
    - "Pre-canonical payloads (no webhook fields) still classify correctly via legacy fallback"
    - "All existing post_discord_cards tests still pass"
  artifacts:
    - path: "apps/worker/src/jobs/post_discord_cards.js"
      provides: "Simplified bucket/eligibility/side/lean functions reading canonical fields"
      contains: "webhook_bucket"
  key_links:
    - from: "buildDiscordSnapshot"
      to: "classifyDecisionBucket"
      via: "called for each card"
      pattern: "classifyDecisionBucket"
    - from: "classifyDecisionBucket"
      to: "payload.webhook_bucket"
      via: "direct read, no model inference"
      pattern: "webhook_bucket"
    - from: "isDisplayableWebhookCard"
      to: "payload.webhook_eligible"
      via: "direct read"
      pattern: "webhook_eligible"
    - from: "selectionSummary"
      to: "payload.webhook_display_side"
      via: "direct read"
      pattern: "webhook_display_side"
    - from: "passesLeanThreshold"
      to: "payload.webhook_lean_eligible"
      via: "direct read"
      pattern: "webhook_lean_eligible"
---

<objective>
Replace the four inference-heavy Discord functions with canonical field reads from the webhook_* fields stamped in Plan 01. Delete `classifyNhlTotalsBucketStatus()` — the only remaining inference function for NHL totals.

Purpose: Layer B of the 3-layer architecture. Discord becomes a read-only formatter that never computes thresholds, buckets, or confidence tiers from model internals.

Output: Simplified `classifyDecisionBucket`, `isDisplayableWebhookCard`, `selectionSummary`, `passesLeanThreshold` in `post_discord_cards.js`. Dead `classifyNhlTotalsBucketStatus` function deleted.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/discord-3layer/discord-3layer-01-SUMMARY.md
@.planning/ROADMAP.md

# Interfaces to replace

## classifyDecisionBucket (current — line 483, ~80 lines)
Current: Runs classifyNhlTotalsBucketStatus(card) for NHL totals, reads nhl_1p_decision for 1P,
then falls through action/classification inference for everything else.

Replace with:
```js
function classifyDecisionBucket(card) {
  const bucket = card?.payloadData?.webhook_bucket;
  if (bucket === 'official' || bucket === 'lean' || bucket === 'pass_blocked') return bucket;
  return classifyDecisionBucketLegacy(card); // renamed from current body
}
```
Keep the ENTIRE current body as `classifyDecisionBucketLegacy(card)` — this is the safety net
for payloads from before Plan 01 was deployed (cards in the DB without webhook_* fields).

## isDisplayableWebhookCard (current — line 263, ~70 lines)
Replace with:
```js
function isDisplayableWebhookCard(card) {
  const eligible = card?.payloadData?.webhook_eligible;
  if (typeof eligible === 'boolean') return eligible;
  return isDisplayableWebhookCardLegacy(card);
}
```
Keep current body as `isDisplayableWebhookCardLegacy(card)`.

## selectionSummary (current — line ~610, descends through 15 payload paths)
Replace top of function with:
```js
function selectionSummary(card) {
  const canonical = card?.payloadData?.webhook_display_side;
  if (canonical) return canonical;
  // ... rest of existing waterfall unchanged ...
}
```
Do NOT remove the existing waterfall — it handles pre-canonical payloads.

## passesLeanThreshold (current — line 951)
Replace with:
```js
function passesLeanThreshold(card) {
  const eligible = card?.payloadData?.webhook_lean_eligible;
  if (typeof eligible === 'boolean') return eligible;
  // ... rest of existing threshold/edge-parsing logic unchanged ...
}
```

## classifyNhlTotalsBucketStatus (current — line ~430, ~55 lines)
DELETE entirely. It is only called from classifyDecisionBucket.
After this plan, classifyDecisionBucket reads webhook_bucket first (canonical),
and falls back to classifyDecisionBucketLegacy which does NOT call classifyNhlTotalsBucketStatus
(the legacy path uses action/classification/1P reason logic, same as existing lines 483-565 minus the NHL-total branch).

IMPORTANT: classifyNhlTotalsBucketStatus was the ONLY caller of classifyNhlTotalsStatus from Discord.
After deleting it, the `classifyNhlTotalsStatus` import at line 16 can also be removed.

## classifyNhlTotalsStatus import (line 16)
```js
const { classifyNhlTotalsStatus } = require('../models/nhl-totals-status');
```
Remove this import after classifyNhlTotalsBucketStatus is deleted.
```
</context>

<tasks>

<task type="auto">
  <name>Task 1: Replace four inference functions with canonical reads; delete classifyNhlTotalsBucketStatus</name>
  <files>apps/worker/src/jobs/post_discord_cards.js</files>
  <action>
    Make the following changes in order:

    **STEP 1 — Remove nhl-totals-status import (line ~16):**
    Delete: `const { classifyNhlTotalsStatus } = require('../models/nhl-totals-status');`

    **STEP 2 — Delete classifyNhlTotalsBucketStatus function (lines ~430–490):**
    The entire `function classifyNhlTotalsBucketStatus(card) { ... }` block. It is the source
    of all NHL model knowledge in Discord. After Plan 01, this knowledge is in webhook_bucket.

    **STEP 3 — Rename existing classifyDecisionBucket → classifyDecisionBucketLegacy:**
    Rename the function signature only: `function classifyDecisionBucketLegacy(card) {`
    Keep every line of the body intact — it is the safety net for pre-deploy cards.

    In classifyDecisionBucketLegacy, remove the NHL-total branch that called
    classifyNhlTotalsBucketStatus (the `if (normalizeToken(card?.sport) === 'NHL'...)` check at top),
    since classifyNhlTotalsBucketStatus is now deleted. For those old cards, fall through to
    action/classification inference — acceptable degradation for pre-deploy payloads.

    **STEP 4 — Add new classifyDecisionBucket (canonical first):**
    ```js
    function classifyDecisionBucket(card) {
      const bucket = card?.payloadData?.webhook_bucket;
      if (bucket === 'official' || bucket === 'lean' || bucket === 'pass_blocked') return bucket;
      return classifyDecisionBucketLegacy(card);
    }
    ```

    **STEP 5 — Rename existing isDisplayableWebhookCard → isDisplayableWebhookCardLegacy:**
    Rename function signature only, keep entire body intact.

    **STEP 6 — Add new isDisplayableWebhookCard (canonical first):**
    ```js
    function isDisplayableWebhookCard(card) {
      const eligible = card?.payloadData?.webhook_eligible;
      if (typeof eligible === 'boolean') return eligible;
      return isDisplayableWebhookCardLegacy(card);
    }
    ```

    **STEP 7 — Prepend canonical read to selectionSummary:**
    At the very start of the existing `selectionSummary(card)` body, add:
    ```js
    const webhookSide = card?.payloadData?.webhook_display_side;
    if (webhookSide) return webhookSide;
    ```
    Leave all existing waterfall lines below it untouched.

    **STEP 8 — Prepend canonical read to passesLeanThreshold:**
    At the very start of the existing `passesLeanThreshold(card)` body, add:
    ```js
    const eligible = card?.payloadData?.webhook_lean_eligible;
    if (typeof eligible === 'boolean') return eligible;
    ```
    Leave all existing threshold/parsing logic below it untouched.

    **STEP 9 — Check exports:**
    `isDisplayableWebhookCard` and `buildDiscordSnapshot` are exported at the bottom.
    Ensure `isDisplayableWebhookCard` export still points to the NEW canonical wrapper,
    not the legacy function.

    CAUTION: Do not remove classifyDecisionBucketLegacy or isDisplayableWebhookCardLegacy.
    They are the backward-compat layer for cards in the DB that predate Plan 01.
  </action>
  <verify>
    <automated>npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/post_discord_cards.test.js 2>&1 | tail -20</automated>
  </verify>
  <done>
    Test suite green. grep confirms:
    - `classifyNhlTotalsBucketStatus` no longer exists in post_discord_cards.js
    - `classifyNhlTotalsStatus` import removed
    - `webhook_bucket` appears in classifyDecisionBucket
    - `webhook_eligible` appears in isDisplayableWebhookCard
    - `webhook_display_side` appears in selectionSummary
    - `webhook_lean_eligible` appears in passesLeanThreshold
  </done>
</task>

<task type="auto">
  <name>Task 2: Add canonical-path tests to post_discord_cards.test.js</name>
  <files>apps/worker/src/jobs/__tests__/post_discord_cards.test.js</files>
  <action>
    Add a new describe block `'canonical webhook fields path'` that exercises the NEW code paths,
    distinct from the existing legacy-path tests.

    For each of the four simplified functions, add at least one test that pre-stamps
    `webhook_*` fields on the payload and confirms the function reads them directly:

    ```js
    describe('canonical webhook fields path', () => {
      // classifyDecisionBucket reads webhook_bucket
      it('classifyDecisionBucket returns official when webhook_bucket=official', () => {
        const card = { payloadData: { webhook_bucket: 'official' }, sport: 'NHL', cardType: 'nhl-pace' };
        expect(classifyDecisionBucket(card)).toBe('official');
      });
      it('classifyDecisionBucket returns lean when webhook_bucket=lean', () => {
        const card = { payloadData: { webhook_bucket: 'lean' } };
        expect(classifyDecisionBucket(card)).toBe('lean');
      });
      it('classifyDecisionBucket returns pass_blocked when webhook_bucket=pass_blocked', () => {
        const card = { payloadData: { webhook_bucket: 'pass_blocked' } };
        expect(classifyDecisionBucket(card)).toBe('pass_blocked');
      });
      it('classifyDecisionBucket falls back to legacy when no webhook_bucket', () => {
        const card = { payloadData: { action: 'FIRE', classification: 'BASE' }, sport: 'NBA', cardType: 'nba-pace' };
        expect(classifyDecisionBucket(card)).toBe('official');
      });

      // isDisplayableWebhookCard reads webhook_eligible
      it('isDisplayableWebhookCard returns true when webhook_eligible=true', () => {
        const card = { payloadData: { webhook_eligible: true } };
        expect(isDisplayableWebhookCard(card)).toBe(true);
      });
      it('isDisplayableWebhookCard returns false when webhook_eligible=false', () => {
        const card = { payloadData: { webhook_eligible: false } };
        expect(isDisplayableWebhookCard(card)).toBe(false);
      });

      // passesLeanThreshold reads webhook_lean_eligible
      it('passesLeanThreshold returns false when webhook_lean_eligible=false', () => {
        const card = { payloadData: { webhook_lean_eligible: false } };
        expect(passesLeanThreshold(card)).toBe(false);
      });
      it('passesLeanThreshold returns true when webhook_lean_eligible=true', () => {
        const card = { payloadData: { webhook_lean_eligible: true } };
        expect(passesLeanThreshold(card)).toBe(true);
      });

      // selectionSummary reads webhook_display_side
      it('selectionSummary returns webhook_display_side when present', () => {
        const card = { payloadData: { webhook_display_side: 'OVER' } };
        expect(selectionSummary(card)).toBe('OVER');
      });
    });
    ```

    These functions need to be importable by the test. Check the test file's existing import
    and add any missing exports if `classifyDecisionBucket`, `isDisplayableWebhookCard`,
    `passesLeanThreshold`, `selectionSummary` are not already exported for testing.
    If they are only tested indirectly via `buildDiscordSnapshot`, test them via that path
    by building minimal card fixtures with webhook_* fields and asserting output section placement.
  </action>
  <verify>
    <automated>npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/post_discord_cards.test.js 2>&1 | tail -20</automated>
  </verify>
  <done>
    All new canonical-path tests pass. All pre-existing tests pass. Total test count <= prior count + 9.
  </done>
</task>

</tasks>

<verification>
Run both affected test suites together to confirm no cross-contamination:

```bash
npm --prefix apps/worker run test -- --runInBand \
  src/utils/__tests__/decision-publisher.v2.test.js \
  src/jobs/__tests__/post_discord_cards.test.js \
  2>&1 | tail -20
```

Confirm classifyNhlTotalsBucketStatus is gone:
```bash
grep -n "classifyNhlTotalsBucketStatus\|classifyNhlTotalsStatus" \
  apps/worker/src/jobs/post_discord_cards.js
```
Expected: no output.

Confirm all four canonical reads exist:
```bash
grep -n "webhook_bucket\|webhook_eligible\|webhook_display_side\|webhook_lean_eligible" \
  apps/worker/src/jobs/post_discord_cards.js | head -10
```
Expected: each field appears at least once.
</verification>

<success_criteria>
- `classifyDecisionBucket` reads `payload.webhook_bucket` first
- `isDisplayableWebhookCard` reads `payload.webhook_eligible` first
- `selectionSummary` reads `payload.webhook_display_side` first
- `passesLeanThreshold` reads `payload.webhook_lean_eligible` first
- `classifyNhlTotalsBucketStatus` deleted
- `classifyNhlTotalsStatus` import removed
- Legacy fallback functions retained for pre-deploy payloads
- All existing post_discord_cards tests pass
- 9 new canonical-path tests pass
</success_criteria>

<output>
After completion, create `.planning/phases/discord-3layer/discord-3layer-02-SUMMARY.md`
</output>
