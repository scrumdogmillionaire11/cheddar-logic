---
phase: mlb-k-harden
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/jobs/mlb-k-input-classifier.js
  - apps/worker/src/jobs/__tests__/mlb-k-input-classifier.test.js
autonomous: true

must_haves:
  truths:
    - "classifyMlbPitcherKQuality(inputs) returns FULL_MODEL only when all core fields are real numbers (no proxies)"
    - "starter_whiff_proxy present → model_quality is FALLBACK, never FULL_MODEL"
    - "IP_PROXY present → model_quality is FALLBACK, never FULL_MODEL"
    - "contact_pct_vs_hand missing → model_quality is never FULL_MODEL"
    - "dedupeFlags(['A','A','B']) returns ['A','B'] (length 2)"
    - "All 5 unit tests pass without any DB or model imports"
  artifacts:
    - path: "apps/worker/src/jobs/mlb-k-input-classifier.js"
      provides: "Pure functions: classifyMlbPitcherKQuality, buildCompletenessMatrix, dedupeFlags"
      exports: ["classifyMlbPitcherKQuality", "buildCompletenessMatrix", "dedupeFlags"]
    - path: "apps/worker/src/jobs/__tests__/mlb-k-input-classifier.test.js"
      provides: "5 unit tests: full model, whiff proxy, opp contact missing, IP proxy, flag dedup"
      min_lines: 80
  key_links:
    - from: "apps/worker/src/jobs/mlb-k-input-classifier.js"
      to: "apps/worker/src/jobs/run_mlb_model.js"
      via: "require in run_mlb_model.js — wired in plan 03"
      pattern: "classifyMlbPitcherKQuality"
---

<objective>
Create a standalone, pure-function classifier module that encodes the explicit
MLB pitcher-K input contract. This replaces all scattered ad hoc proxy checks
in run_mlb_model.js with a single deterministic function.

Purpose: run_mlb_model.js becomes a consumer of the quality decision, not the
arbiter of it. Tests are dependency-free.
Output: mlb-k-input-classifier.js + 5 passing unit tests.
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@WORK_QUEUE/WI-0747.md
@WORK_QUEUE/COMPLETE/WI-0742.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create mlb-k-input-classifier.js with classifyMlbPitcherKQuality, buildCompletenessMatrix, dedupeFlags</name>
  <files>apps/worker/src/jobs/mlb-k-input-classifier.js</files>
  <action>
Create a CommonJS module. Zero imports. No DB. No model code.

Exports: classifyMlbPitcherKQuality, buildCompletenessMatrix, dedupeFlags.

buildCompletenessMatrix(starter, opponent, leash):
  Returns { starter_profile: { k_pct, swstr_pct, csw_pct, pitch_count_avg, ip_avg }, opponent_profile: { k_pct_vs_hand, contact_pct_vs_hand, projected_lineup } }
  Each field = (typeof v === 'number' && isFinite(v))

classifyMlbPitcherKQuality(inputs) -- inputs: { starter, opponent, leash }:
  hardMissing = [], proxies = [], degraded = []

  FALLBACK triggers:
  - !starter?.k_pct                                        -> hardMissing.push('starter_k_pct')
  - !(starter?.swstr_pct || starter?.csw_pct):
      if starter?.whiff_proxy                              -> proxies.push('starter_whiff_proxy')
      else                                                 -> hardMissing.push('starter_whiff_metric')
  - !(leash?.pitch_count_avg || leash?.ip_avg):
      if leash?.ip_proxy                                   -> proxies.push('ip_proxy')
      else                                                 -> hardMissing.push('leash_metric')
  - !opponent?.k_pct_vs_hand                               -> hardMissing.push('opp_k_pct_vs_hand')
  - !opponent?.contact_pct_vs_hand                         -> hardMissing.push('opp_contact_profile')

  DEGRADED_MODEL triggers (push to degraded only):
  - !opponent?.chase_pct_vs_hand
  - opponent?.projected_lineup_status === 'PROJECTED'

  Decision:
    if (hardMissing.length > 0 || proxies.length > 0)
      return { model_quality: 'FALLBACK', hardMissing, proxies, degraded }
    if (degraded.length > 0)
      return { model_quality: 'DEGRADED_MODEL', hardMissing, proxies, degraded }
    return { model_quality: 'FULL_MODEL', hardMissing, proxies, degraded }

dedupeFlags(flags): return [...new Set(flags)]
  </action>
  <verify>node -e "const m=require('./apps/worker/src/jobs/mlb-k-input-classifier');const r=m.classifyMlbPitcherKQuality({starter:{k_pct:0.28,swstr_pct:0.13},opponent:{k_pct_vs_hand:0.22,contact_pct_vs_hand:0.76},leash:{pitch_count_avg:93}});console.assert(r.model_quality==='FULL_MODEL',r);console.log('PASS',r.model_quality)"</verify>
  <done>Node prints "PASS FULL_MODEL" with exit 0</done>
</task>

<task type="auto">
  <name>Task 2: Write 5 unit tests in mlb-k-input-classifier.test.js</name>
  <files>apps/worker/src/jobs/__tests__/mlb-k-input-classifier.test.js</files>
  <action>
Create Jest test file. No require except the classifier module itself.

Test 1 — FULL_MODEL when all core fields present:
  starter: { k_pct: 0.28, swstr_pct: 0.13 }, opponent: { k_pct_vs_hand: 0.22, contact_pct_vs_hand: 0.76 }, leash: { pitch_count_avg: 93 }
  expect(result.model_quality).toBe('FULL_MODEL')
  expect(result.hardMissing).toHaveLength(0)
  expect(result.proxies).toHaveLength(0)

Test 2 — FALLBACK when whiff proxy used:
  starter: { k_pct: 0.28, whiff_proxy: 0.18 } (swstr_pct and csw_pct missing), opponent: { k_pct_vs_hand: 0.22, contact_pct_vs_hand: 0.76 }, leash: { pitch_count_avg: 93 }
  expect(result.model_quality).toBe('FALLBACK')
  expect(result.proxies).toContain('starter_whiff_proxy')
  expect(result.model_quality).not.toBe('FULL_MODEL')  // explicit guard

Test 3 — FALLBACK when opponent contact missing:
  starter all present, opponent: { k_pct_vs_hand: 0.22, contact_pct_vs_hand: null }, leash all present
  expect(result.model_quality).toBe('FALLBACK')
  expect(result.hardMissing).toContain('opp_contact_profile')
  expect(result.model_quality).not.toBe('FULL_MODEL')

Test 4 — FALLBACK when IP proxy used:
  starter all present, opponent all present, leash: { ip_proxy: 5.5 } (pitch_count_avg and ip_avg missing)
  expect(result.model_quality).toBe('FALLBACK')
  expect(result.proxies).toContain('ip_proxy')
  expect(result.model_quality).not.toBe('FULL_MODEL')

Test 5 — Duplicate flags deduplicated:
  const flags = ['DEGRADED_INPUT:starter_whiff_proxy','FLAG_A','DEGRADED_INPUT:starter_whiff_proxy','FLAG_A','FLAG_B']
  const result = dedupeFlags(flags)
  expect(result).toHaveLength(3)
  expect(new Set(result).size).toBe(result.length)
  </action>
  <verify>npm --prefix apps/worker test -- --runInBand src/jobs/__tests__/mlb-k-input-classifier.test.js 2>&1 | tail -8</verify>
  <done>Output shows "Tests: 5 passed, 5 total"</done>
</task>

</tasks>

<verification>
npm --prefix apps/worker test -- --runInBand src/jobs/__tests__/mlb-k-input-classifier.test.js
</verification>

<success_criteria>
- mlb-k-input-classifier.js exports classifyMlbPitcherKQuality, buildCompletenessMatrix, dedupeFlags
- 5/5 unit tests pass
- classifyMlbPitcherKQuality is a pure function with zero side effects
- Proxy presence → FALLBACK (never FULL_MODEL); missing opponent contact → FALLBACK (never FULL_MODEL)
</success_criteria>

<output>
After completion, create `.planning/phases/mlb-k-harden/mlb-k-harden-01-SUMMARY.md`
</output>
