---
phase: ui-decision-contract
plan: 02
type: execute
wave: 2
depends_on: [ui-decision-contract-01]
files_modified:
  - web/src/components/cards/GameCardItem.tsx
  - web/src/components/cards/game-card-helpers.tsx
  - web/src/__tests__/ui-pass-gated-model-metrics-contract.test.js
  - web/src/__tests__/ui-cards-smoke.test.js
autonomous: true
requirements: [UI-CONTRACT-03, UI-CONTRACT-04]

must_haves:
  truths:
    - "Primary card body answers one action question with one surfaced status and one surfaced reason"
    - "PASS cards do not display BEST/tier, raw edge%, or fair-vs-market in primary body"
    - "Verification-pending cards can render as SLIGHT EDGE watchlist language without contradicting surfaced status"
    - "No UI path can simultaneously present PASS + BEST + large public edge + verification required unless explicitly internal/debug labeled"
  artifacts:
    - path: "web/src/components/cards/GameCardItem.tsx"
      provides: "decision-first rendering wired to final_market_decision"
      contains: "final_market_decision"
    - path: "web/src/__tests__/ui-pass-gated-model-metrics-contract.test.js"
      provides: "source/runtime regression guard for contradictory PASS+BEST rendering"
      contains: "PASS suppresses model-strength fields"
    - path: "web/src/__tests__/ui-cards-smoke.test.js"
      provides: "updated smoke assertions for canonical surfaced status labels"
      contains: "surfaced_reason"
  key_links:
    - from: "web/src/components/cards/GameCardItem.tsx"
      to: "play.final_market_decision"
      via: "primary status line, context line, details drawer gating"
      pattern: "final_market_decision"
    - from: "web/src/components/cards/GameCardItem.tsx"
      to: "web/src/lib/game-card/display-verdict.ts"
      via: "public status mapping uses surfaced_status"
      pattern: "getDisplayVerdict"
---

<objective>
Replace contradictory UI rendering paths so surfaced status controls primary card output and model-strength fields only render when allowed by canonical decision gating.

Purpose: Enforce the presentation contract: no more PASS + BEST/edge/fair contradictions in public card body.
Output: `GameCardItem` reads `final_market_decision` for status/reason/visibility and legacy contradictory branches are removed.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/ui-decision-contract/ui-decision-contract-01-SUMMARY.md
@web/src/components/cards/GameCardItem.tsx
@web/src/__tests__/ui-cards-smoke.test.js
@web/src/lib/game-card/display-verdict.ts

<interfaces>
From plan 01 output:
```ts
interface FinalMarketDecision {
  surfaced_status: 'PLAY' | 'SLIGHT EDGE' | 'PASS';
  surfaced_reason: string;
  verification_state: 'VERIFIED' | 'PENDING' | 'FAILED';
  certainty_state: 'CONFIRMED' | 'PARTIAL' | 'UNCONFIRMED';
  show_model_context: boolean;
  model_strength: 'BEST' | 'GOOD' | 'WATCH' | null;
  model_edge_pct: number | null;
  fair_price: string | null;
}
```

Current contradictory block to replace in GameCardItem:
```tsx
// currently prints model metrics in visible context lines and pass detail:
`Edge: ... | Tier: ...`
`Fair: <x> vs <y>`
`Model direction: ...`
`Pricing Status: ...`
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Migrate GameCardItem primary rendering to surfaced-status-first contract</name>
  <files>web/src/components/cards/GameCardItem.tsx, web/src/components/cards/game-card-helpers.tsx</files>
  <behavior>
    - PASS + verification gate: primary body shows PASS + surfaced reason, hides raw edge/tier/fair
    - SLIGHT EDGE + pending verification: primary body shows SLIGHT EDGE watch language and reason, no contradictory PASS labels
    - PLAY + verified: edge/fair/tier can render as model context
    - canonical precedence in UI: verification/certainty/market stability cap surfaced output
  </behavior>
  <action>
    1. In `GameCardItem`, read `displayPlay.final_market_decision` as primary decision source for status label and reason text.
    2. Replace direct `contextLine1` model-strength rendering with guarded rendering:
       - if surfaced_status='PASS' => show reason-only context, no edge/tier/fair in primary block
       - if surfaced_status='SLIGHT EDGE' and verification pending => show watchlist copy, optionally model context under explicit "Model context (internal)" label inside details
       - if surfaced_status='PLAY' and show_model_context=true => keep edge/fair context
    3. Remove or rewrite the legacy PASS detail block (`Model direction`, `Pricing Status`) so it cannot conflict with surfaced status.
    4. Keep display-verdict mapping unchanged (PLAY/LEAN/PASS internal), but map surfaced_status 'SLIGHT EDGE' into existing public label path cleanly.
    5. Do not leak internal-only fields in primary body unless explicitly labeled internal/debug.
  </action>
  <verify>
    <automated>node --import tsx/esm web/src/__tests__/ui-pass-gated-model-metrics-contract.test.js</automated>
  </verify>
  <done>GameCardItem primary output is surfaced-status-first and no longer renders contradictory PASS + BEST/edge/fair combinations.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Add regression tests for contradictory output contract and update smoke guards</name>
  <files>web/src/__tests__/ui-pass-gated-model-metrics-contract.test.js, web/src/__tests__/ui-cards-smoke.test.js</files>
  <behavior>
    - Test 1: surfaced_status=PASS due to verification gate => no BEST/edge/fair in primary body
    - Test 2: strong model edge + expected/expected goalies => surfaced status capped and output text coherent
    - Test 3: market sanity downgrade => surfaced label and rationale agree
    - Test 4: no PASS+BEST+large edge+verification-required combo in public block unless explicitly internal/debug labeled
  </behavior>
  <action>
    1. Create `ui-pass-gated-model-metrics-contract.test.js` using source + minimal transform fixture assertions (same style as existing web source-contract tests).
    2. Encode forbidden combination checks against `GameCardItem.tsx` and helper strings so future edits cannot reintroduce the contradiction.
    3. Update `ui-cards-smoke.test.js` contract assertions:
       - remove brittle requirement that legacy `Pricing Status:` must appear
       - assert surfaced reason/status contract terms instead (decision-first + no sharp verdict leakage)
    4. Run existing UI decision authority smoke alongside new tests.
  </action>
  <verify>
    <automated>node --import tsx/esm web/src/__tests__/ui-pass-gated-model-metrics-contract.test.js && node --import tsx/esm web/src/__tests__/ui-cards-smoke.test.js && node --import tsx/esm web/src/__tests__/game-card-decision-authority.test.ts</automated>
  </verify>
  <done>Regression suite prevents PASS/model-strength contradiction and smoke tests reflect the new surfaced-status contract.</done>
</task>

</tasks>

<verification>
Run targeted web checks:

```bash
node --import tsx/esm web/src/__tests__/ui-pass-gated-model-metrics-contract.test.js
node --import tsx/esm web/src/__tests__/ui-cards-smoke.test.js
node --import tsx/esm web/src/__tests__/game-card-decision-authority.test.ts
npm --prefix web run typecheck
```
</verification>

<success_criteria>
- primary card body is controlled by surfaced decision contract only
- PASS cards do not show conflicting BEST/edge/fair in primary UI
- SLIGHT EDGE pending verification is rendered as a coherent watch-state
- legacy contradictory rendering paths are removed or explicitly internal-labeled
- regression tests cover the four required contradiction cases
</success_criteria>

<output>
After completion, create `.planning/phases/ui-decision-contract/ui-decision-contract-02-SUMMARY.md`
</output>
