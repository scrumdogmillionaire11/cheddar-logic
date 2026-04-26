---
phase: discord-3layer
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/utils/decision-publisher.js
  - apps/worker/src/utils/__tests__/decision-publisher.v2.test.js
autonomous: true
requirements: [DISCORD-LAYER-01, DISCORD-LAYER-02, DISCORD-LAYER-03]

must_haves:
  truths:
    - "NHL total card with nhl_totals_status.status=PLAY → webhook_bucket='official'"
    - "NHL total card with goalie unconfirmed (nhl_totals_status caps to SLIGHT EDGE) → webhook_bucket='lean'"
    - "NHL 1P card with nhl_1p_decision.surfaced_status='SLIGHT EDGE' → webhook_bucket='lean'"
    - "Any card with action=PASS or classification=PASS → webhook_bucket='pass_blocked'"
    - "NBA TOTAL card with decision_v2.official_status=LEAN → webhook_bucket='lean'"
    - "Prop card with play.action=FIRE → webhook_bucket='official'"
    - "webhook_eligible=false when and only when webhook_bucket='pass_blocked'"
    - "webhook_display_side resolves: nhl_1p_decision.projection.side first, then selection.side, then prediction"
    - "webhook_lean_eligible=false when |edge| < 0.15; true when edge absent"
    - "webhook_reason_code populated for pass_blocked; null for official/lean"
  artifacts:
    - path: "apps/worker/src/utils/decision-publisher.js"
      provides: "computeWebhookFields export + called from publishDecisionForCard"
      contains: "computeWebhookFields"
    - path: "apps/worker/src/utils/__tests__/decision-publisher.v2.test.js"
      provides: "webhook field tests"
      contains: "webhook_bucket"
  key_links:
    - from: "publishDecisionForCard"
      to: "computeWebhookFields"
      via: "called after applyUiActionFields returns"
      pattern: "computeWebhookFields\\(payload\\)"
    - from: "computeWebhookFields"
      to: "payload.nhl_totals_status"
      via: "direct read"
      pattern: "nhl_totals_status\\.status"
    - from: "computeWebhookFields"
      to: "payload.nhl_1p_decision"
      via: "direct read"
      pattern: "nhl_1p_decision\\.surfaced_status"
---

<objective>
Stamp five canonical webhook fields onto every card payload at publish time, so the Discord formatter never needs to infer bucket, eligibility, side, or lean threshold from model internals again.

Purpose: Layer A of the 3-layer architecture. All downstream logic (Discord, any future surface) reads these fields directly — no sport-specific inference outside the publisher.

Output: `computeWebhookFields(payload)` function exported from `decision-publisher.js` and called in `publishDecisionForCard()` after `applyUiActionFields()` resolves.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/STATE.md

# Codebase interfaces the executor needs

## decision-publisher.js — key entry points

```js
// publishDecisionForCard({ card, oddsSnapshot, options }) — line 631
// Calls applyUiActionFields(card.payloadData) then returns.
// THIS is where computeWebhookFields should be called, after applyUiActionFields.
// Works for ALL card kinds including props.

// applyUiActionFields(payload, context) — line 446
// Guard: returns early if payload.kind !== 'PLAY'
// So props with kind != 'PLAY' are NOT touched by finalizeDecisionFields.
// computeWebhookFields must NOT be inside finalizeDecisionFields — put it in
// publishDecisionForCard instead, so it runs for every card kind.

// Exports (line 827+):
module.exports = { publishDecisionForCard, applyUiActionFields, finalizeDecisionFields, ... }
```

## nhl_totals_status (already on NHL total payloads — stamped by run_nhl_model.js)

```js
// Structure stamped on NHL total card payloads:
payload.nhl_totals_status = {
  status: 'PLAY' | 'SLIGHT EDGE' | 'PASS',
  delta: Number,
  absDelta: Number,
  reasonCodes: string[],
}
// classifyNhlTotalsStatus() already called in run_nhl_model.js applyNhlSettlementMarketContext() (line 1051-1084)
// and written onto every nhl-totals card payload (line 1857).
// DO NOT call classifyNhlTotalsStatus() again in the publisher — just read nhl_totals_status.status.
```

## nhl_1p_decision (already on NHL 1P payloads — built by buildNhl1PDecision())

```js
// Structure stamped on nhl-pace-1p payloads:
payload.nhl_1p_decision = {
  projection: { exists, total, line, side, model_label, confidence },
  execution: { market_available, price_available, is_executable, execution_reason },
  surfaced_status: 'PLAY' | 'SLIGHT EDGE' | 'PASS',
  surfaced_reason_code: string,
}
```

## Prop card shape (nhl-player-shots etc.)

```js
// Props do NOT have kind: 'PLAY' at root
// Their action lives at: payload.play.action, payload.play.classification
// OR at payload.action, payload.classification (varies)
// Selection is at payload.play.selection
```

## Existing normalizeMarketType + normalizePeriod (from @cheddar-logic/models)

```js
// Already imported in decision-publisher.js at top
const { normalizeMarketType, normalizePeriod } = require('@cheddar-logic/models');
// normalizePeriod(payload) returns 'full_game' | '1p' | 'half' | etc.
// normalizeMarketType(market_type, recommended_bet_type) returns 'total'|'moneyline'|'spread'|etc.
```
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add computeWebhookFields to decision-publisher.js</name>
  <files>apps/worker/src/utils/decision-publisher.js</files>
  <behavior>
    - NHL total (sport=NHL, market_type resolved to 'total', period='full_game') with nhl_totals_status.status='PLAY' → webhook_bucket='official'
    - NHL total with nhl_totals_status.status='SLIGHT EDGE' → webhook_bucket='lean'
    - NHL total with nhl_totals_status.status='PASS' → webhook_bucket='pass_blocked'
    - NHL 1P (normalizePeriod='1p') with nhl_1p_decision.surfaced_status='SLIGHT EDGE' → webhook_bucket='lean'
    - Card with decision_v2.official_status='PLAY' → webhook_bucket='official'
    - Card with decision_v2.official_status='LEAN' → webhook_bucket='lean'
    - Card with action='FIRE' or classification='BASE' (no nhl_totals_status, no decision_v2) → webhook_bucket='official'
    - Card with action='HOLD'/'WATCH'/'LEAN' or classification='LEAN' → webhook_bucket='lean'
    - Card with action='PASS' or classification='PASS' → webhook_bucket='pass_blocked' (overrides any other bucket)
    - Prop card with play.action='FIRE' and no root action → webhook_bucket='official'
    - webhook_eligible = (webhook_bucket !== 'pass_blocked')
    - webhook_display_side: nhl_1p_decision?.projection?.side first, then selection?.side, then prediction, then null. Always normalized to uppercase.
    - webhook_lean_eligible: |edge| >= 0.15 when edge present; true when edge absent/non-finite
    - edge read from: payload.edge ?? payload.edge_pct ?? payload.edge_over_pp
    - webhook_reason_code: pass_reason_code ?? nhl_totals_status.reasonCodes[0] ?? nhl_1p_decision.surfaced_reason_code ?? 'PASS_NO_EDGE' — only set when webhook_bucket='pass_blocked', otherwise null
    - null/non-object payload: no-op, return immediately
  </behavior>
  <action>
    In `decision-publisher.js`:

    1. Add module-level constant after existing `require` block:
       ```js
       const WEBHOOK_MIN_LEAN_EDGE = Number(process.env.DISCORD_MIN_LEAN_EDGE ?? 0.15);
       ```

    2. Add `computeWebhookFields(payload)` function before `publishDecisionForCard`. Logic:

       a) Guard: if (!payload || typeof payload !== 'object') return;

       b) Detect card type:
          - `isNhlTotal`: sport=NHL + normalizePeriod(payload)='full_game' + normalizeMarketType(payload.market_type, payload.recommended_bet_type)='total'
          - `is1P`: normalizePeriod(payload) === '1p'

       c) Resolve bucket (before PASS override):
          - If isNhlTotal && payload.nhl_totals_status?.status:
            const s = String(payload.nhl_totals_status.status).toUpperCase();
            bucket = s==='PLAY' ? 'official' : s==='SLIGHT EDGE' ? 'lean' : 'pass_blocked';
          - Else if is1P && payload.nhl_1p_decision?.surfaced_status:
            const s = String(payload.nhl_1p_decision.surfaced_status).toUpperCase();
            bucket = s==='PLAY' ? 'official' : (s.includes('SLIGHT') || s==='LEAN') ? 'lean' : 'pass_blocked';
          - Else:
            const dv2Status = String(payload.decision_v2?.official_status || '').toUpperCase();
            const rootAction = String(payload.action || payload.play?.action || payload.status || '').toUpperCase();
            const rootClass = String(payload.classification || payload.play?.classification || '').toUpperCase();
            if (dv2Status==='PLAY' || rootAction==='FIRE' || rootClass==='BASE') bucket = 'official';
            else if (dv2Status==='LEAN' || ['HOLD','WATCH','LEAN','EVIDENCE'].includes(rootAction) || rootClass==='LEAN') bucket = 'lean';
            else bucket = 'pass_blocked';

       d) PASS override (always wins, regardless of bucket derivation path):
          const forcePassAction = String(payload.action || payload.play?.action || '').toUpperCase();
          const forcePassClass = String(payload.classification || payload.play?.classification || '').toUpperCase();
          if (forcePassAction==='PASS' || forcePassClass==='PASS') bucket = 'pass_blocked';

       e) Resolve webhook_display_side:
          const rawSide = payload.nhl_1p_decision?.projection?.side
            || payload.selection?.side
            || payload.prediction
            || null;
          const displaySide = rawSide ? String(rawSide).toUpperCase() : null;

       f) Resolve webhook_lean_eligible:
          const edgeRaw = payload.edge ?? payload.edge_pct ?? payload.edge_over_pp;
          const leanEligible = (edgeRaw !== null && edgeRaw !== undefined && Number.isFinite(Number(edgeRaw)))
            ? Math.abs(Number(edgeRaw)) >= WEBHOOK_MIN_LEAN_EDGE
            : true;

       g) Resolve webhook_reason_code (only for pass_blocked):
          const reasonCode = bucket === 'pass_blocked'
            ? (payload.pass_reason_code
               || payload.nhl_totals_status?.reasonCodes?.[0]
               || payload.nhl_1p_decision?.surfaced_reason_code
               || 'PASS_NO_EDGE')
            : null;

       h) Stamp fields:
          payload.webhook_bucket = bucket;
          payload.webhook_eligible = bucket !== 'pass_blocked';
          payload.webhook_display_side = displaySide;
          payload.webhook_lean_eligible = leanEligible;
          payload.webhook_reason_code = reasonCode;

    3. In `publishDecisionForCard`, after `applyUiActionFields(card?.payloadData, ...)` call (around line 634), add:
       ```js
       computeWebhookFields(card?.payloadData);
       ```
       Also in the second `applyUiActionFields` call path (line 812):
       ```js
       computeWebhookFields(card.payloadData);
       ```

    4. Export `computeWebhookFields` in `module.exports`.

    DO NOT call `classifyNhlTotalsStatus()` inside `computeWebhookFields` — the status is already stamped by
    the model runner. Just read `payload.nhl_totals_status.status`.
  </action>
  <verify>
    <automated>npm --prefix apps/worker run test -- --runInBand src/utils/__tests__/decision-publisher.v2.test.js 2>&1 | tail -15</automated>
  </verify>
  <done>computeWebhookFields exported; all test cases for the 9 behavior items above pass; npm test green</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Add webhook field tests to decision-publisher.v2.test.js</name>
  <files>apps/worker/src/utils/__tests__/decision-publisher.v2.test.js</files>
  <behavior>
    Tests must cover all 9 behavior cases from Task 1. Each test:
    1. Builds a minimal payload with the right fields
    2. Calls computeWebhookFields(payload)
    3. Asserts specific webhook_* field values
  </behavior>
  <action>
    Add a new describe block `'computeWebhookFields'` to the existing test file.

    Import `computeWebhookFields` from `'../decision-publisher.js'`.

    Test cases to add (write these BEFORE Task 1 implementation — RED first):

    ```js
    describe('computeWebhookFields', () => {
      it('stamps official for NHL total with nhl_totals_status=PLAY', () => {
        const p = { sport: 'NHL', kind: 'PLAY', market_type: 'total', recommended_bet_type: 'total',
          selection: { side: 'OVER' }, edge: 1.2,
          nhl_totals_status: { status: 'PLAY', reasonCodes: [] } };
        computeWebhookFields(p);
        expect(p.webhook_bucket).toBe('official');
        expect(p.webhook_eligible).toBe(true);
        expect(p.webhook_reason_code).toBeNull();
      });

      it('stamps lean for NHL total capped by goalie uncertainty', () => {
        const p = { sport: 'NHL', kind: 'PLAY', market_type: 'total', recommended_bet_type: 'total',
          selection: { side: 'OVER' }, edge: 1.1,
          nhl_totals_status: { status: 'SLIGHT EDGE', reasonCodes: ['CAP_GOALIES_UNCONFIRMED'] } };
        computeWebhookFields(p);
        expect(p.webhook_bucket).toBe('lean');
        expect(p.webhook_eligible).toBe(true);
      });

      it('stamps pass_blocked for NHL total with nhl_totals_status=PASS', () => {
        const p = { sport: 'NHL', kind: 'PLAY', market_type: 'total', recommended_bet_type: 'total',
          selection: { side: 'OVER' },
          nhl_totals_status: { status: 'PASS', reasonCodes: ['PASS_INTEGRITY_BLOCK'] } };
        computeWebhookFields(p);
        expect(p.webhook_bucket).toBe('pass_blocked');
        expect(p.webhook_eligible).toBe(false);
        expect(p.webhook_reason_code).toBe('PASS_INTEGRITY_BLOCK');
      });

      it('stamps lean for NHL 1P with surfaced_status=SLIGHT EDGE', () => {
        const p = { sport: 'NHL', kind: 'PLAY', market_type: 'total', period: '1p',
          prediction: 'OVER',
          nhl_1p_decision: { projection: { side: 'OVER' }, surfaced_status: 'SLIGHT EDGE', surfaced_reason_code: 'FIRST_PERIOD_PRICE_UNAVAILABLE' } };
        computeWebhookFields(p);
        expect(p.webhook_bucket).toBe('lean');
        expect(p.webhook_display_side).toBe('OVER');
      });

      it('stamps official for NBA total via decision_v2.official_status=PLAY', () => {
        const p = { sport: 'NBA', kind: 'PLAY', market_type: 'total',
          selection: { side: 'OVER' }, edge: 0.5,
          decision_v2: { official_status: 'PLAY' }, action: 'FIRE', classification: 'BASE' };
        computeWebhookFields(p);
        expect(p.webhook_bucket).toBe('official');
      });

      it('stamps lean for card with action=HOLD', () => {
        const p = { sport: 'MLB', kind: 'PLAY', market_type: 'total',
          action: 'HOLD', classification: 'LEAN', edge: 0.4 };
        computeWebhookFields(p);
        expect(p.webhook_bucket).toBe('lean');
        expect(p.webhook_lean_eligible).toBe(true);
      });

      it('stamps pass_blocked when action override is PASS regardless of dv2', () => {
        const p = { sport: 'NHL', kind: 'PLAY', market_type: 'total',
          action: 'PASS', classification: 'PASS',
          decision_v2: { official_status: 'PLAY' }, // contradictory — PASS wins
          nhl_totals_status: { status: 'PLAY', reasonCodes: [] } };
        computeWebhookFields(p);
        expect(p.webhook_bucket).toBe('pass_blocked');
      });

      it('stamps official for prop card via play.action=FIRE', () => {
        const p = { sport: 'NHL', card_type: 'nhl-player-shots',
          play: { action: 'FIRE', classification: 'BASE', selection: 'OVER 3.5' } };
        computeWebhookFields(p);
        expect(p.webhook_bucket).toBe('official');
      });

      it('webhook_lean_eligible false when |edge| < 0.15', () => {
        const p = { sport: 'NBA', action: 'HOLD', classification: 'LEAN', edge: 0.08 };
        computeWebhookFields(p);
        expect(p.webhook_lean_eligible).toBe(false);
      });

      it('webhook_lean_eligible true when edge absent', () => {
        const p = { sport: 'NBA', action: 'HOLD', classification: 'LEAN' };
        computeWebhookFields(p);
        expect(p.webhook_lean_eligible).toBe(true);
      });

      it('webhook_display_side from nhl_1p_decision.projection.side beats selection.side', () => {
        const p = { selection: { side: 'UNDER' },
          nhl_1p_decision: { projection: { side: 'over' }, surfaced_status: 'PLAY' },
          action: 'FIRE' };
        computeWebhookFields(p);
        expect(p.webhook_display_side).toBe('OVER');
      });

      it('no-op for null payload', () => {
        expect(() => computeWebhookFields(null)).not.toThrow();
        expect(() => computeWebhookFields(undefined)).not.toThrow();
      });
    });
    ```

    Write these tests FIRST (they will fail), then implement Task 1, then verify green.
  </action>
  <verify>
    <automated>npm --prefix apps/worker run test -- --runInBand src/utils/__tests__/decision-publisher.v2.test.js 2>&1 | tail -20</automated>
  </verify>
  <done>All new computeWebhookFields describe block tests pass; existing tests in that file unaffected</done>
</task>

</tasks>

<verification>
Run full publisher test suite to confirm no regressions:

```bash
npm --prefix apps/worker run test -- --runInBand src/utils/__tests__/decision-publisher.v2.test.js src/utils/__tests__/decision-publisher.tier-vocab.test.js 2>&1 | tail -20
```

Spot-check: grep that computeWebhookFields is called in publishDecisionForCard:
```bash
grep -n "computeWebhookFields" apps/worker/src/utils/decision-publisher.js
```
</verification>

<success_criteria>
- `computeWebhookFields` exported from `decision-publisher.js`
- Called in `publishDecisionForCard` after `applyUiActionFields`  
- All 12 new test cases pass
- Existing publisher tests unbroken
- No call to `classifyNhlTotalsStatus` inside `computeWebhookFields`
</success_criteria>

<output>
After completion, create `.planning/phases/discord-3layer/discord-3layer-01-SUMMARY.md`
</output>
