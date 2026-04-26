---
phase: nhl-odds-backed-01
plan: "02"
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/jobs/run_nhl_model.js
  - apps/worker/src/jobs/__tests__/run_nhl_model.market-calls.test.js
  - apps/worker/src/models/__tests__/cross-market.test.js
autonomous: true
requirements: [NHR-ML-01, NHR-ML-02]

must_haves:
  truths:
    - "nhl-moneyline-call cards with live h2h prices and non-null model win probability produce decision_v2.sharp_price_status != UNPRICED"
    - "nhl-moneyline-call cards with valid fair_prob and edge are emitted with execution_status EXECUTABLE unless explicitly vetoed by execution gate"
    - "moneyline payload decision_v2 is produced by publishDecisionForCard/buildDecisionV2, not preserved as a static stub"
  artifacts:
    - path: "apps/worker/src/jobs/run_nhl_model.js"
      provides: "moneyline payload hygiene before publishDecisionForCard"
      contains: "generateNHLMarketCallCards"
    - path: "apps/worker/src/jobs/__tests__/run_nhl_model.market-calls.test.js"
      provides: "moneyline decision_v2 executable-state regression tests"
    - path: "apps/worker/src/models/__tests__/cross-market.test.js"
      provides: "ML market p_fair/p_implied invariants for non-flat model scenarios"
  key_links:
    - from: "apps/worker/src/jobs/run_nhl_model.js"
      to: "apps/worker/src/utils/decision-publisher.js"
      via: "publishDecisionForCard -> buildDecisionV2"
      pattern: "publishDecisionForCard\\("
    - from: "payload.price/model_prob/edge"
      to: "decision_v2.sharp_price_status"
      via: "buildDecisionV2 pricing decision"
      pattern: "sharp_price_status"
---

<objective>
Harden NHL moneyline market-call payload construction so that wave-1 decision_v2 generation consistently resolves to executable pricing states when live h2h odds and model probability are available.

Purpose: NHL moneyline cards can degrade into UNPRICED/BLOCKED despite live h2h odds when upstream payload fields are incomplete or ambiguous. This prevents executable moneyline plays from surfacing as intended.

Output:
- Moneyline payload fields (`price`, `model_prob`, `p_fair`, `p_implied`, `edge`) are populated deterministically from decision data when available
- Static stub values that bias execution status toward UNPRICED are removed or neutralized before publishDecisionForCard builds canonical decision_v2
- Regression tests proving live-odds ML cards generate usable decision_v2 and executable status path
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/ime-01-independent-market-eval/ime-01-04-SUMMARY.md
@apps/worker/src/models/__tests__/cross-market.test.js
</context>

<interfaces>
From apps/worker/src/jobs/run_nhl_model.js (moneyline payload build):

```js
const moneylinePrice =
  side === 'HOME'
    ? (oddsSnapshot?.h2h_home ?? null)
    : side === 'AWAY'
      ? (oddsSnapshot?.h2h_away ?? null)
      : null;

const payloadData = {
  market_type: 'MONEYLINE',
  kind: 'PLAY',
  selection: { side, team: teamName },
  price: moneylinePrice,
  edge: moneylineDecision.edge ?? null,
  edge_pct: moneylineDecision.edge ?? null,
  p_fair: moneylineDecision.p_fair ?? null,
  p_implied: moneylineDecision.p_implied ?? null,
  model_prob: moneylineDecision.p_fair ?? null,
  projection: {
    margin_home: moneylineDecision?.projection?.projected_margin ?? null,
    win_prob_home: moneylineDecision?.projection?.win_prob_home ?? null,
  },
  decision_v2: {
    official_status: mlInitStatus,
    sharp_price_status: 'UNPRICED',   // legacy stub; publishDecisionForCard should replace
  },
};
```

From apps/worker/src/utils/decision-publisher.js:

```js
if (isWave1EligiblePayload(payload)) {
  const decisionV2 = buildDecisionV2(payload, context);
  if (decisionV2) {
    payload.decision_v2 = decisionV2;
    payload.execution_status = resolveExecutionStatus(payload);
    syncCanonicalDecisionEnvelope(payload);
    return payload;
  }
}
```

From packages/models/src/decision-pipeline-v2.js:

```js
function buildDecisionV2(payload, context = {}) {
  // MONEYLINE fair prob fallback:
  let fair_prob =
    asNumber(payload?.model_prob) ??
    asNumber(payload?.p_fair) ??
    (market_type === 'MONEYLINE' && winProbHome !== null
      ? direction === 'AWAY' ? 1 - winProbHome : winProbHome
      : null);

  // sharp_price_status returns UNPRICED when fair_prob/implied_prob/edge are missing
}
```
</interfaces>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Remove ML decision_v2 stub bias and backfill model_prob from win_prob_home fallback</name>
  <files>apps/worker/src/jobs/run_nhl_model.js</files>
  <behavior>
    - Test 1: ML payload includes model_prob via p_fair when available
    - Test 2: If p_fair is null but projection.win_prob_home is present, model_prob is derived from win_prob_home + side
    - Test 3: Generated ML payload does not hardcode sharp_price_status='UNPRICED' before publishDecisionForCard
    - Test 4: publishDecisionForCard produces canonical decision_v2 with non-null sharp_price_status for live-odds ML sample
  </behavior>
  <action>
    In `generateNHLMarketCallCards` moneyline payload section:

    1. Compute `resolvedModelProb` before payload object creation:
    - Start with `moneylineDecision.p_fair`
    - If null and `moneylineDecision.projection.win_prob_home` is finite:
      - HOME side => `resolvedModelProb = win_prob_home`
      - AWAY side => `resolvedModelProb = 1 - win_prob_home`
    - Clamp to [0,1] and round to 4 decimals for consistency

    2. Set payload fields to use `resolvedModelProb`:
    - `model_prob: resolvedModelProb`
    - `p_fair: moneylineDecision.p_fair ?? resolvedModelProb ?? null`

    3. Remove static `decision_v2` stub fields that force `sharp_price_status: 'UNPRICED'` in pre-publish payload.
    Keep minimal compatibility only if required (`official_status` can remain), but do not set `sharp_price_status` in the pre-publish stub.

    4. Keep existing `pricing_trace` and `market_context.wager` fields unchanged.

    Why: canonical decision_v2 must be built in one place (`publishDecisionForCard` -> `buildDecisionV2`). The payload should provide sufficient inputs (price/model_prob/edge), not pre-bias outcome to UNPRICED.
  </action>
  <verify>
    <automated>npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/run_nhl_model.market-calls.test.js 2>&1 | tail -30</automated>
  </verify>
  <done>
    Moneyline payload has deterministic model_prob fallback. Pre-publish decision_v2 no longer sets sharp_price_status='UNPRICED'. Existing market-calls tests pass.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Add ML executable-path regression tests for live h2h odds cases</name>
  <files>apps/worker/src/jobs/__tests__/run_nhl_model.market-calls.test.js, apps/worker/src/models/__tests__/cross-market.test.js</files>
  <behavior>
    - Test 1: generateNHLMarketCallCards + publishDecisionForCard with live h2h odds and non-flat win_prob emits decision_v2.sharp_price_status in {CHEDDAR, COTTAGE, PENDING_VERIFICATION} (not UNPRICED)
    - Test 2: resolveExecutionStatus for that card is not PROJECTION_ONLY
    - Test 3: cross-market ML decision sample has non-null p_fair and p_implied when h2h_home/h2h_away are present
  </behavior>
  <action>
    Extend `run_nhl_model.market-calls.test.js`:

    - Add a test that constructs ML card via `generateNHLMarketCallCards` with base odds snapshot (`h2h_home`, `h2h_away`) and decisions carrying edge/p_fair.
    - Pass the card through `publishDecisionForCard`.
    - Assert:
      - `payloadData.decision_v2` exists
      - `payloadData.decision_v2.sharp_price_status !== 'UNPRICED'`
      - `payloadData.execution_status !== 'PROJECTION_ONLY'`

    Extend `cross-market.test.js` (or tighten existing ML test):
    - Assert ML decision returns non-null `p_fair` and `p_implied` in the calibrated win-prob scenario already present.

    Keep tests deterministic and avoid broad fixture rewrites.
  </action>
  <verify>
    <automated>npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/run_nhl_model.market-calls.test.js src/models/__tests__/cross-market.test.js 2>&1 | tail -40</automated>
  </verify>
  <done>
    New ML tests pass and prove live-odds moneyline cards are built with enough data for canonical decision_v2 pricing resolution.
  </done>
</task>

</tasks>

<verification>
```bash
npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/run_nhl_model.market-calls.test.js
npm --prefix apps/worker run test -- --runInBand src/models/__tests__/cross-market.test.js
```

Expected:
- No test regressions
- New assertions pass: ML `decision_v2.sharp_price_status` is not `UNPRICED` in live-odds calibrated scenario.
</verification>

<success_criteria>
1. Moneyline payload sets `model_prob` using deterministic fallback from `projection.win_prob_home` when `p_fair` is absent.
2. Pre-publish ML `decision_v2` no longer hardcodes `sharp_price_status='UNPRICED'`.
3. Regression tests prove live-odds ML cards produce canonical decision_v2 with priced status and non-PROJECTION_ONLY execution status.
4. No regressions in existing NHL market-call tests.
</success_criteria>

<output>
After completion, create `.planning/phases/nhl-odds-backed-01/nhl-odds-backed-01-02-SUMMARY.md`
</output>
