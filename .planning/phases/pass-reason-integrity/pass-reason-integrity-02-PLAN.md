---
phase: pass-reason-integrity
plan: "02"
type: tdd
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/models/mlb-model.js
  - apps/worker/src/models/__tests__/mlb-model.test.js
autonomous: true
requirements:
  - PRI-MLB-01
  - PRI-MLB-02
  - PRI-MLB-03

must_haves:
  truths:
    - "projectFullGameML with edge=+3.1pp but confidence<gate emits PASS_CONFIDENCE_GATE, not PASS_NO_EDGE"
    - "projectFullGameML with edge below threshold and confidence OK emits PASS_NO_EDGE (legal case)"
    - "projectFullGameML returns pass_reason_code, raw_edge_value, threshold_passed in its return object"
    - "projectF5TotalCard and projectFullGameTotal use priority-ordered selectPassReasonCode, not Array.find fallback"
    - "degraded + positive raw edge emits PASS_MODEL_DEGRADED, not PASS_NO_EDGE"
  artifacts:
    - path: "apps/worker/src/models/mlb-model.js"
      provides: "Fixed projectFullGameML; selectPassReasonCode helper; extended return contract"
      contains: "confidenceGateBlocked"
    - path: "apps/worker/src/models/__tests__/mlb-model.test.js"
      provides: "Scenarios A, B, C, D"
  key_links:
    - from: "projectFullGameML reason code assignment"
      to: "confidenceGateBlocked flag"
      via: "rawBestEdge >= LEAN_EDGE_MIN && confidence < CONFIDENCE_MIN"
      pattern: "confidenceGateBlocked"
    - from: "pass_reason_code in projectF5TotalCard / projectFullGameTotal"
      to: "selectPassReasonCode()"
      via: "priority list lookup before Array.find"
      pattern: "selectPassReasonCode"
---

<objective>
Fix the three bugs in `mlb-model.js` that cause `PASS_NO_EDGE` to be emitted when the real blocker is the confidence gate or degraded model. Add `selectPassReasonCode()` as a priority-ordered selector to replace unsafe `Array.find()` fallbacks. Extend `projectFullGameML` return contract with `pass_reason_code`, `raw_edge_value`, `threshold_required`, `threshold_passed`.

Purpose: The model layer must be honest about _why_ it passed. The card builder (Plan 03) will propagate these values; it cannot do so if the model never computed them.

Output: Bug-free `projectFullGameML`; `selectPassReasonCode` helper; extended return; green test suite for scenarios A/B/C/D.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md

<interfaces>
<!-- Current projectFullGameML: key variables before the return block -->
```javascript
// apps/worker/src/models/mlb-model.js — projectFullGameML (lines ~1981–2024)

const LEAN_EDGE_MIN = 0.025;
const CONFIDENCE_MIN = Math.min(6, Math.max(5, 5 + Math.round((variance.variance_multiplier - 1) * 2)));

let side = 'PASS';
let edge = 0;
if (homeEdge >= LEAN_EDGE_MIN && confidence >= CONFIDENCE_MIN) {
  side = 'HOME'; edge = homeEdge;
} else if (awayEdge >= LEAN_EDGE_MIN && confidence >= CONFIDENCE_MIN) {
  side = 'AWAY'; edge = awayEdge;
}

const isDegraded = proj.projection_source === 'DEGRADED_MODEL';

const reasonCodes = [
  ...(MLB_PURE_SIGNAL_MODE ? ['PURE_SIGNAL_MODE'] : []),
  ...(isDegraded ? ['FULL_GAME_ML_DEGRADED'] : []),
  ...softReasons,
  ...(side === 'PASS' ? ['PASS_NO_EDGE'] : []),  // ← BUG: conflates confidence gate with no-edge
];

// Return object (current — missing pass_reason_code, raw_edge_value, threshold_passed):
return {
  side, prediction: side, edge,
  confidence, projection_source: proj.projection_source,
  status_cap: proj.status_cap,
  reason_codes: reasonCodes,
  flags,
  ev_threshold_passed: side !== 'PASS',
  // ... no pass_reason_code, raw_edge_value, threshold_passed
};
```

<!-- Current pass_reason_code fallback in projectF5TotalCard + projectFullGameTotal -->
```javascript
// Bug 2 — Array.find() is order-dependent:
pass_reason_code: status !== 'PASS'
  ? null
  : (reasonCodes.find((code) => code.startsWith('PASS_')) ?? 'PASS_NO_EDGE'),
```

<!-- New CONFIDENCE_MIN is computed, not a constant — important for tests -->
// CONFIDENCE_MIN for full-game ML = Math.min(6, Math.max(5, ...)) — always 5 or 6
// F5 ML uses hardcoded CONFIDENCE_MIN = 6

<!-- Existing PASS_DEGRADED_TOTAL_MODEL in mlb-model.js (line 1445) — for reference -->
// Used in projectF5TotalCard when inputs are degraded and lean edge fails
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Fix projectFullGameML reason code assignment + extend return contract</name>
  <files>apps/worker/src/models/mlb-model.js, apps/worker/src/models/__tests__/mlb-model.test.js</files>
  <behavior>
    - After computing `side`, derive three new variables BEFORE building `reasonCodes`:
      - `rawBestEdge = Math.max(homeEdge, awayEdge)` — always finite (edges computed from valid inputs)
      - `rawEdgeCleared = rawBestEdge >= LEAN_EDGE_MIN` — was the raw edge above threshold?
      - `confidenceGateBlocked = rawEdgeCleared && confidence < CONFIDENCE_MIN` — positive edge, confidence gate fired
    - Replace `...(side === 'PASS' ? ['PASS_NO_EDGE'] : [])` in `reasonCodes` with:
      ```javascript
      ...(confidenceGateBlocked ? ['PASS_CONFIDENCE_GATE'] : []),
      ...(side === 'PASS' && !confidenceGateBlocked && isDegraded && rawEdgeCleared
            ? ['PASS_MODEL_DEGRADED']
            : []),
      ...(side === 'PASS' && !confidenceGateBlocked && !rawEdgeCleared ? ['PASS_NO_EDGE'] : []),
      ```
    - Add to return object:
      - `pass_reason_code`: `null` if side !== 'PASS'; else `'PASS_CONFIDENCE_GATE'` if confidenceGateBlocked; else `'PASS_MODEL_DEGRADED'` if isDegraded && rawEdgeCleared; else `'PASS_NO_EDGE'`
      - `raw_edge_value`: `rawBestEdge`
      - `threshold_required`: `LEAN_EDGE_MIN`
      - `threshold_passed`: `rawEdgeCleared`
    - Test A: inputs complete, homeEdge=0.010 (< 0.025), confidence=8 → `side='PASS'`, `reason_codes` includes `'PASS_NO_EDGE'`, does NOT include `'PASS_CONFIDENCE_GATE'`
    - Test C: inputs complete, homeEdge=0.031 (>= 0.025), confidence=4 (< CONFIDENCE_MIN=5) → `side='PASS'`, `reason_codes` includes `'PASS_CONFIDENCE_GATE'`, does NOT include `'PASS_NO_EDGE'`, `raw_edge_value=0.031`, `threshold_passed=true`
    - Test D: `proj.projection_source='DEGRADED_MODEL'`, homeEdge=0.028 (>= 0.025), confidence=4 → `reason_codes` includes both `'FULL_GAME_ML_DEGRADED'` and `'PASS_MODEL_DEGRADED'` (or `'PASS_CONFIDENCE_GATE'` if confidence gate fires first); does NOT include `'PASS_NO_EDGE'`; `pass_reason_code` is NOT `'PASS_NO_EDGE'`
  </behavior>
  <action>
    Locate the `reasonCodes` array construction in `projectFullGameML` (near line 2024 in current file). Insert the three derived variables immediately after the `side`/`edge` assignment block. Replace the single `...(side === 'PASS' ? ['PASS_NO_EDGE'] : [])` spread with the three-way spread as specified above. Add the four new fields to the return object.

    Do NOT change any other function. Do NOT change `projectF5ML` (the F5 moneyline function — different function). Only touch `projectFullGameML`.
  </action>
  <verify>
    <automated>npx jest --testPathPattern="mlb-model" --no-coverage 2>&1 | tail -20</automated>
  </verify>
  <done>Scenarios A/C/D pass; projectFullGameML return object has pass_reason_code, raw_edge_value, threshold_required, threshold_passed; existing tests unbroken</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: selectPassReasonCode() helper + fix projectF5TotalCard and projectFullGameTotal fallbacks</name>
  <files>apps/worker/src/models/mlb-model.js, apps/worker/src/models/__tests__/mlb-model.test.js</files>
  <behavior>
    - Add `selectPassReasonCode(reasonCodes)` as a module-level helper function (not exported):
      ```javascript
      const PASS_REASON_PRIORITY = [
        'PASS_DEGRADED_TOTAL_MODEL',
        'PASS_CONFIDENCE_GATE',
        'PASS_MODEL_DEGRADED',
        'PASS_INPUTS_INCOMPLETE',
        'PASS_SYNTHETIC_FALLBACK',
        'PASS_NO_DISTRIBUTION',
        'PASS_NO_EDGE',
      ];
      function selectPassReasonCode(reasonCodes) {
        for (const code of PASS_REASON_PRIORITY) {
          if (reasonCodes.includes(code)) return code;
        }
        return reasonCodes.find((c) => c.startsWith('PASS_')) ?? null;
      }
      ```
    - Replace BOTH occurrences of `reasonCodes.find((code) => code.startsWith('PASS_')) ?? 'PASS_NO_EDGE'` in `projectF5TotalCard` (line ~1658) and `projectFullGameTotal` (line ~1497) with `selectPassReasonCode(reasonCodes)` — note the fallback becomes `null` not `'PASS_NO_EDGE'`, since `selectPassReasonCode` returns `null` when no PASS_ code found
    - Test B: `projectF5TotalCard` or `projectFullGameTotal` called with `reasonCodes = ['PASS_NO_EDGE', 'PASS_CONFIDENCE_GATE']` → `pass_reason_code` must be `'PASS_CONFIDENCE_GATE'` (higher priority wins)
    - Test B2: `reasonCodes = ['PASS_NO_EDGE']` → `pass_reason_code` is `'PASS_NO_EDGE'`
    - Test B3: `reasonCodes = []` → `pass_reason_code` is `null` (not `'PASS_NO_EDGE'`)
  </behavior>
  <action>
    Add `selectPassReasonCode` function and `PASS_REASON_PRIORITY` constant near the top of the module, after the existing constants block. Grep for both occurrences of `reasonCodes.find((code) => code.startsWith('PASS_')) ?? 'PASS_NO_EDGE'` in mlb-model.js and replace with `selectPassReasonCode(reasonCodes)`. Verify no other `Array.find` pass-reason fallback patterns remain (grep for `startsWith('PASS_')`) in this file.
  </action>
  <verify>
    <automated>npx jest --testPathPattern="mlb-model" --no-coverage 2>&1 | tail -15</automated>
  </verify>
  <done>selectPassReasonCode exists; both Array.find fallbacks replaced; priority ordering test B passes; all mlb-model tests green</done>
</task>

</tasks>

<verification>
```bash
npx jest --testPathPattern="mlb-model" --no-coverage 2>&1 | grep -E "Tests:|PASS|FAIL"
grep -n "confidenceGateBlocked\|selectPassReasonCode\|pass_reason_code.*null\|raw_edge_value" apps/worker/src/models/mlb-model.js | head -15
```
</verification>

<success_criteria>
- `npx jest --testPathPattern="mlb-model"` passes with 0 failures
- `projectFullGameML` never emits `PASS_NO_EDGE` when `rawBestEdge >= LEAN_EDGE_MIN`
- `selectPassReasonCode` exists and is used in all `pass_reason_code` fallback sites in this file
- `projectFullGameML` return object includes `pass_reason_code`, `raw_edge_value`, `threshold_required`, `threshold_passed`
</success_criteria>

<output>
After completion, create `.planning/phases/pass-reason-integrity/pass-reason-integrity-02-SUMMARY.md`
</output>
