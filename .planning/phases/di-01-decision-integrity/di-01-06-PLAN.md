---
phase: di-01-decision-integrity
plan: "06"
type: execute
wave: 2
depends_on: ["di-01-01"]
files_modified:
  - packages/models/src/decision-pipeline-v2-edge-config.js
  - packages/models/src/__tests__/threshold-registry-completeness.test.js
autonomous: true

must_haves:
  truths:
    - "NHL:SPREAD has an explicit entry in SPORT_MARKET_THRESHOLDS_V2 with calibrated play_edge_min and lean_edge_min"
    - "NHL:PUCKLINE has an explicit entry in SPORT_MARKET_THRESHOLDS_V2"
    - "A new exhaustive test confirms every entry in SUPPORTED_MARKETS (or equivalent) has a corresponding threshold profile"
    - "The test fails if any supported sport+market combination is missing from the threshold map"
  artifacts:
    - path: "packages/models/src/decision-pipeline-v2-edge-config.js"
      provides: "NHL:SPREAD and NHL:PUCKLINE threshold entries"
      contains: "NHL.*SPREAD|SPREAD.*NHL"
    - path: "packages/models/src/__tests__/threshold-registry-completeness.test.js"
      provides: "exhaustive threshold coverage test"
      min_lines: 40
  key_links:
    - from: "SPORT_MARKET_THRESHOLDS_V2"
      to: "NHL:SPREAD entry"
      via: "key like 'NHL:SPREAD' or nested structure"
      pattern: "NHL.*SPREAD|SPREAD.*play_edge_min"
---

<objective>
Complete the threshold registry so every supported sport+market combination has explicit calibrated thresholds. With ENABLE_MARKET_THRESHOLDS_V2=true (default), any missing market falls through to generic defaults — NHL spread and puckline were falling to NBA-calibrated generic values.

Purpose: CF-010 from the hardening audit. Threshold gaps are silent miscalibrations.

Output:
- NHL:SPREAD and NHL:PUCKLINE entries with calibrated values
- Exhaustive coverage test that fails on any future gap
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/codebase/HARDENING_AUDIT.md
@packages/models/src/decision-pipeline-v2-edge-config.js
@packages/models/src/decision-pipeline-v2.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add NHL:SPREAD and NHL:PUCKLINE entries to SPORT_MARKET_THRESHOLDS_V2</name>
  <files>packages/models/src/decision-pipeline-v2-edge-config.js</files>
  <action>
Open `decision-pipeline-v2-edge-config.js` and find the `SPORT_MARKET_THRESHOLDS_V2` object. Current entries include NHL:TOTAL, NHL:MONEYLINE, NHL:FIRST_PERIOD, NBA:TOTAL, NBA:SPREAD, NBA:MONEYLINE. Missing: `NHL:SPREAD` and `NHL:PUCKLINE`.

**Calibration rationale for NHL spread/puckline:**
- NHL puckline is a -1.5 runs spread at roughly -120/-150 odds, meaning the vig is heavier than normal spreads. The effective edge requirement should be slightly higher than NHL MONEYLINE (0.058).
- NHL spread (alternate spread, -0.5 to -2.5 range) should mirror the NHL MONEYLINE calibration as a reasonable starting point until empirical data is available.

Add the following entries (between the existing NHL entries):

```javascript
'NHL:SPREAD': {
  play_edge_min: 0.058,        // mirrors NHL ML calibration; no separate spread data yet
  lean_edge_min: 0.029,
  note: 'Calibrated 2026-04 at NHL:MONEYLINE parity — update when NHL spread sample N >= 200'
},
'NHL:PUCKLINE': {
  play_edge_min: 0.065,        // heavier vig on PL (-1.5) warrants higher edge floor
  lean_edge_min: 0.032,
  note: 'Calibrated 2026-04 — puckline vig premium adds ~0.007 to PLAY floor vs NHL:ML'
},
```

After adding, verify the structure is syntactically valid (no comma errors). Run a quick Node.js require check:
```bash
node -e "const cfg = require('./packages/models/src/decision-pipeline-v2-edge-config.js'); console.log(Object.keys(cfg?.SPORT_MARKET_THRESHOLDS_V2 ?? {}).filter(k=>k.startsWith('NHL')))"
```
Expected: `['NHL:TOTAL', 'NHL:FIRST_PERIOD', 'NHL:MONEYLINE', 'NHL:SPREAD', 'NHL:PUCKLINE']` (or similar order).
  </action>
  <verify>
    node -e "const cfg=require('./packages/models/src/decision-pipeline-v2-edge-config.js'); const keys=Object.keys(cfg?.SPORT_MARKET_THRESHOLDS_V2??{}); console.log(keys.filter(k=>k.startsWith('NHL')))"
    grep -n "PUCKLINE\|NHL.*SPREAD" packages/models/src/decision-pipeline-v2-edge-config.js | head -5
  </verify>
  <done>NHL:SPREAD and NHL:PUCKLINE keys present in SPORT_MARKET_THRESHOLDS_V2. Node require succeeds. Both have play_edge_min and lean_edge_min fields with calibration notes.</done>
</task>

<task type="auto">
  <name>Task 2: Add exhaustive threshold registry coverage test</name>
  <files>packages/models/src/__tests__/threshold-registry-completeness.test.js</files>
  <action>
Create `packages/models/src/__tests__/threshold-registry-completeness.test.js`.

The test iterates over all supported sport+market combinations and asserts each one has a threshold profile. This test will fail if any future market is added to the supported set without a corresponding threshold entry.

**Approach — read the WAVE1_SPORTS and WAVE1_MARKETS constants from decision-pipeline-v2.js:**

```javascript
const config = require('../decision-pipeline-v2-edge-config');

// These must match what the decision pipeline considers supported
// Read from decision-pipeline-v2.js WAVE1_SPORTS + WAVE1_MARKETS or define them inline
const WAVE1_SPORTS = ['NBA', 'NHL'];  // adjust to match actual constants
const WAVE1_MARKETS = ['MONEYLINE', 'SPREAD', 'TOTAL', 'PUCKLINE', 'TEAM_TOTAL', 'FIRST_PERIOD'];

describe('Threshold registry exhaustive coverage', () => {
  const thresholds = config.SPORT_MARKET_THRESHOLDS_V2 ?? {};

  function getThreshold(sport, market) {
    // Match resolveThresholdProfile() logic
    return thresholds[`${sport}:${market}`]
      ?? thresholds[`${sport}:DEFAULT`]
      ?? thresholds['DEFAULT']
      ?? null;
  }

  for (const sport of WAVE1_SPORTS) {
    for (const market of WAVE1_MARKETS) {
      test(`${sport}:${market} has an explicit threshold profile`, () => {
        const key = `${sport}:${market}`;
        const explicit = thresholds[key];
        expect(explicit).toBeTruthy();  // must be explicitly defined, not falling to DEFAULT
        expect(typeof explicit.play_edge_min).toBe('number');
        expect(typeof explicit.lean_edge_min).toBe('number');
        expect(explicit.play_edge_min).toBeGreaterThan(0);
        expect(explicit.lean_edge_min).toBeGreaterThan(0);
        expect(explicit.play_edge_min).toBeGreaterThan(explicit.lean_edge_min);
      });
    }
  }
});
```

If `TEAM_TOTAL` or `FIRST_PERIOD` are not in the threshold map for both sports, the test will reveal the gaps. Gaps that exist but are intentional (e.g., MLB markets excluded from V2) should be excluded from the `WAVE1_MARKETS` list with a comment explaining why.

Run: `npm --prefix packages/models test -- --testPathPattern=threshold-registry-completeness 2>&1 | tail -15`
  </action>
  <verify>
    npm --prefix packages/models test -- --testPathPattern=threshold-registry-completeness 2>&1 | tail -15
  </verify>
  <done>
    Test file exists. All tests for sports/markets that have explicit entries pass. Any failing test reveals a real gap (either add the entry or exclude the market with a comment). Final state: all tests pass with no unexplained gaps.
  </done>
</task>

</tasks>

<verification>
1. `node -e "const c=require('./packages/models/src/decision-pipeline-v2-edge-config.js');console.log(JSON.stringify(c.SPORT_MARKET_THRESHOLDS_V2['NHL:SPREAD']))"` — non-null result
2. `node -e "const c=require('./packages/models/src/decision-pipeline-v2-edge-config.js');console.log(JSON.stringify(c.SPORT_MARKET_THRESHOLDS_V2['NHL:PUCKLINE']))"` — non-null result
3. `npm --prefix packages/models test -- --testPathPattern=threshold-registry-completeness` — all pass
4. `npm --prefix apps/worker test --no-coverage` — no regressions from config change
</verification>

<success_criteria>
- NHL:SPREAD and NHL:PUCKLINE have explicit calibrated threshold entries
- Exhaustive test exists that will fail if a supported market is added without thresholds
- All passing tests — no regressions
</success_criteria>

<output>
After completion, create `.planning/phases/di-01-decision-integrity/di-01-06-SUMMARY.md`
</output>
