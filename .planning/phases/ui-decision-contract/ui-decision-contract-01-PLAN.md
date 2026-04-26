---
phase: ui-decision-contract
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - web/src/lib/types/game-card.ts
  - web/src/lib/game-card/transform/index.ts
  - web/src/lib/game-card/transform/decision-surface.ts
  - web/src/__tests__/game-card-pass-surface-contract.test.js
autonomous: true
requirements: [UI-CONTRACT-01, UI-CONTRACT-02]

must_haves:
  truths:
    - "When surfaced_status resolves to PASS from verification/integrity gates, primary card decision remains PASS regardless of raw model edge/tier"
    - "A single canonical decision surface object exists on transformed plays and is the only source for public status/reason"
    - "Model-strength visibility is explicitly gated by surfaced_status + verification_state, not inferred ad hoc in UI"
    - "Legacy consumers can still read prior fields during migration, but new renderer reads final_market_decision first"
  artifacts:
    - path: "web/src/lib/game-card/transform/decision-surface.ts"
      provides: "canonical builder + precedence rules"
      contains: "buildFinalMarketDecision"
    - path: "web/src/lib/types/game-card.ts"
      provides: "FinalMarketDecision contract"
      contains: "interface FinalMarketDecision"
    - path: "web/src/lib/game-card/transform/index.ts"
      provides: "transformed play includes final_market_decision"
      contains: "final_market_decision"
    - path: "web/src/__tests__/game-card-pass-surface-contract.test.js"
      provides: "contract regression tests for capped PASS/SLIGHT EDGE semantics"
      contains: "PASS status suppresses model-strength exposure"
  key_links:
    - from: "web/src/lib/game-card/transform/index.ts"
      to: "web/src/lib/game-card/transform/decision-surface.ts"
      via: "buildFinalMarketDecision(play, decision_v2, reason codes, goalie certainty, verification fields)"
      pattern: "buildFinalMarketDecision"
    - from: "web/src/lib/game-card/transform/decision-surface.ts"
      to: "web/src/lib/types/game-card.ts"
      via: "typed return object"
      pattern: "FinalMarketDecision"
---

<objective>
Define one canonical public decision surface for non-total and total cards so model conviction, execution gating, and verification state are not mixed in downstream rendering.

Purpose: Eliminate contradictory PASS + BEST/edge/fair output by moving precedence logic into one transform-layer contract.
Output: `final_market_decision` added to transformed plays with explicit visibility policy for model-strength fields.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/di-01-decision-integrity/di-01-01-SUMMARY.md
@.planning/phases/di-01-decision-integrity/di-01-04-SUMMARY.md
@web/src/lib/game-card/transform/index.ts
@web/src/lib/types/game-card.ts

<interfaces>
From web/src/lib/types/game-card.ts:
```ts
export interface DecisionV2 {
  official_status: 'PLAY' | 'LEAN' | 'PASS';
  play_tier: 'BEST' | 'GOOD' | 'OK' | 'BAD';
  primary_reason_code: string;
  fair_prob?: number | null;
  implied_prob?: number | null;
  edge_pct?: number | null;
  edge_delta_pct?: number | null;
  pricing_trace?: {
    market_line?: number | null;
    market_price?: number | null;
    line_source?: string | null;
    price_source?: string | null;
  };
  sharp_price_status?: string | null;
}
```

Target interface to add:
```ts
export interface FinalMarketDecision {
  surfaced_status: 'PLAY' | 'SLIGHT EDGE' | 'PASS';
  surfaced_reason: string;
  model_strength: 'BEST' | 'GOOD' | 'WATCH' | null;
  model_edge_pct: number | null;
  fair_price: string | null;
  verification_state: 'VERIFIED' | 'PENDING' | 'FAILED';
  certainty_state: 'CONFIRMED' | 'PARTIAL' | 'UNCONFIRMED';
  market_stable: boolean;
  line_verified: boolean;
  show_model_context: boolean;
}
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Define canonical final market decision contract and precedence helper</name>
  <files>web/src/lib/types/game-card.ts, web/src/lib/game-card/transform/decision-surface.ts</files>
  <behavior>
    - Case 1: decision_v2 official_status='PASS' with EDGE_VERIFICATION_REQUIRED shows surfaced_status='PASS' and show_model_context=false
    - Case 2: strong model edge + goalies expected/expected resolves surfaced_status='SLIGHT EDGE' (or PASS when reason is blocking), never PLAY
    - Case 3: unstable line / verification pending marks verification_state='PENDING' and can cap surfaced status
    - Case 4: surfaced_status='PLAY' with verified + confirmed certainty sets show_model_context=true
  </behavior>
  <action>
    1. Add `FinalMarketDecision` to `game-card.ts` and thread it into the transformed Play type as `final_market_decision?: FinalMarketDecision`.
    2. Create `decision-surface.ts` with exported `buildFinalMarketDecision(input)` and a small internal reason-code mapper for human surfaced reasons.
    3. Enforce canonical public precedence in helper:
       - integrity/verification gate
       - certainty gate (goalie/injury certainty)
       - market-stability gate
       - surfaced status
       - optional model context
    4. Implement model-context visibility rule:
       - PASS => `show_model_context=false`
       - SLIGHT EDGE + verification pending => model context optional but downgraded labeling only
       - PLAY + verified => model context visible
    5. Keep backward compatibility by not removing legacy fields in this plan.
  </action>
  <verify>
    <automated>node --import tsx/esm web/src/__tests__/game-card-pass-surface-contract.test.js</automated>
  </verify>
  <done>Helper exists, compiles, and returns deterministic `final_market_decision` for PASS/SLIGHT EDGE/PLAY cases with explicit model-context visibility.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Wire final_market_decision into transform pipeline and add contract tests</name>
  <files>web/src/lib/game-card/transform/index.ts, web/src/__tests__/game-card-pass-surface-contract.test.js</files>
  <behavior>
    - transformed play object includes `final_market_decision`
    - PASS from verification gate does not carry public model-strength visibility
    - market sanity downgrade and surfaced rationale agree in output object
  </behavior>
  <action>
    1. In transform path where `decision_v2`, reason codes, pricing status, and goalie certainty are available, call `buildFinalMarketDecision(...)` and set `play.final_market_decision`.
    2. Add regression tests for the exact failure class:
       - PASS due to verification gate => no public BEST/edge/fair visibility
       - strong raw model edge + expected/expected goalies => surfaced status capped per NHL policy
       - market sanity downgrade => surfaced_status and surfaced_reason remain coherent
    3. Keep existing decision-authority tests green; this contract layers on top of ADR-0003 authority, not beside it.
  </action>
  <verify>
    <automated>node --import tsx/esm web/src/__tests__/game-card-pass-surface-contract.test.js && node --import tsx/esm web/src/__tests__/game-card-decision-authority.test.ts</automated>
  </verify>
  <done>Transformed plays carry canonical `final_market_decision`; all new contract tests pass and legacy authority tests still pass.</done>
</task>

</tasks>

<verification>
Run web transform and contract tests together:

```bash
node --import tsx/esm web/src/__tests__/game-card-pass-surface-contract.test.js
node --import tsx/esm web/src/__tests__/game-card-decision-authority.test.ts
```

Then run typecheck:

```bash
npm --prefix web run typecheck
```
</verification>

<success_criteria>
- `final_market_decision` exists on transformed play objects and is deterministic
- precedence order is encoded in one helper, not spread across UI branches
- PASS due to gating suppresses public model-strength exposure flags
- no existing decision authority regression
</success_criteria>

<output>
After completion, create `.planning/phases/ui-decision-contract/ui-decision-contract-01-SUMMARY.md`
</output>
