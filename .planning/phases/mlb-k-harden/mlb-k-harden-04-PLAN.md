---
phase: mlb-k-harden
plan: "04"
type: execute
wave: 3
depends_on: ["mlb-k-harden-01", "mlb-k-harden-03"]
files_modified:
  - apps/worker/src/audit/audit_invariants.js
  - apps/worker/src/audit/compare_audit_snapshot.js
  - apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_clean_01.json
  - apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_proxy_degraded_01.json
  - apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_missing_data_01.json
autonomous: true

must_haves:
  truths:
    - "INV-007 exists in audit_invariants.js and asserts model_quality in FULL_MODEL|DEGRADED_MODEL|FALLBACK"
    - "INV-007 asserts FALLBACK when proxy_fields is non-empty in the MLB_PITCHER_K card"
    - "mlb_pitcher_k_clean_01.json carries model_quality: FULL_MODEL and passes INV-007"
    - "mlb_pitcher_k_proxy_degraded_01.json carries model_quality: FALLBACK with proxy_fields populated and passes INV-007"
    - "All audit tests pass after changes"
  artifacts:
    - path: "apps/worker/src/audit/audit_invariants.js"
      provides: "INV-007: MLB_PITCHER_K model_quality required + proxy-exclusion rule"
      contains: "INV-007"
    - path: "apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_clean_01.json"
      provides: "Clean fixture with model_quality: FULL_MODEL"
      contains: "FULL_MODEL"
    - path: "apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_proxy_degraded_01.json"
      provides: "Proxy fixture with model_quality: FALLBACK"
      contains: "FALLBACK"
  key_links:
    - from: "apps/worker/src/audit/audit_invariants.js"
      to: "apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_clean_01.json"
      via: "fixture loaded by audit test harness"
      pattern: "mlb_pitcher_k_clean_01"
---

<objective>
Add INV-007 to audit_invariants.js, update compare_audit_snapshot.js to check
model_quality tolerances, update the clean fixture to carry model_quality: FULL_MODEL,
and create a proxy-degraded fixture (model_quality: FALLBACK).

Purpose: Audit invariants are how the system enforces the contract at runtime.
Without INV-007, a broken classifier silently produces wrong quality tiers.
Output: INV-007 wired, two MLB_PITCHER_K fixtures updated/created, audit tests green.
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@WORK_QUEUE/WI-0747.md
@WORK_QUEUE/COMPLETE/WI-0742.md
@.planning/phases/mlb-k-harden/mlb-k-harden-01-SUMMARY.md
@.planning/phases/mlb-k-harden/mlb-k-harden-03-SUMMARY.md
@apps/worker/src/audit/audit_invariants.js
@apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_clean_01.json
@apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_missing_data_01.json
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add INV-007 to audit_invariants.js and update compare_audit_snapshot.js model_quality check</name>
  <files>apps/worker/src/audit/audit_invariants.js, apps/worker/src/audit/compare_audit_snapshot.js</files>
  <action>
In audit_invariants.js, add INV-007 following the exact pattern of existing invariants.

Read the existing invariant structure first:
  grep -n 'INV-00\|invariant\|function check\|module.exports' apps/worker/src/audit/audit_invariants.js | head -30

INV-007 should check MLB_PITCHER_K cards only (filter by card_family or prop type).
For each MLB_PITCHER_K card payload:

1. Assert `prop_decision.model_quality` is one of: 'FULL_MODEL', 'DEGRADED_MODEL', 'FALLBACK'
   Fail: "[INV-007] MLB_PITCHER_K card missing or invalid model_quality: {actual}"

2. Assert: if `prop_decision.proxy_fields` is non-empty array, then `model_quality` must be 'FALLBACK'
   Fail: "[INV-007] MLB_PITCHER_K card has proxy_fields but model_quality is {actual}, expected FALLBACK"

3. Assert: `prop_decision.degradation_reasons` is an array (may be empty)
   Fail: "[INV-007] MLB_PITCHER_K card missing degradation_reasons array"

In compare_audit_snapshot.js, add a tolerant check for numeric projection fields
(model_quality is a string enum — compare exact equality, not numeric tolerance):
  grep -n 'numeric_projection\|model_quality\|toleran' apps/worker/src/audit/compare_audit_snapshot.js | head -20

Add a check that model_quality in current snapshot matches expected model_quality from baseline,
or flag as a quality regression if current is FULL_MODEL but baseline was FALLBACK (or vice versa).
  </action>
  <verify>grep -n 'INV-007' apps/worker/src/audit/audit_invariants.js</verify>
  <done>grep returns at least 3 lines covering the INV-007 function definition and both assertions</done>
</task>

<task type="auto">
  <name>Task 2: Update mlb_pitcher_k_clean_01.json + create mlb_pitcher_k_proxy_degraded_01.json + verify mlb_pitcher_k_missing_data_01.json emits FALLBACK</name>
  <files>apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_clean_01.json, apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_proxy_degraded_01.json, apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_missing_data_01.json</files>
  <action>
First read the existing clean fixture to understand the shape:
  cat apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_clean_01.json

Step A — mlb_pitcher_k_clean_01.json:
In the `prop_decision` object, add:
  "model_quality": "FULL_MODEL",
  "degradation_reasons": [],
  "proxy_fields": []
Do not change any other fields. The fixture represents a pitcher with real whiff,
real opponent contact, and real leash metrics.

Step B — Create mlb_pitcher_k_proxy_degraded_01.json:
Copy the basic shape from clean_01, then adjust `prop_decision` to represent a
FALLBACK card due to whiff proxy + missing opponent contact:
  "model_quality": "FALLBACK",
  "degradation_reasons": ["opp_contact_profile"],
  "proxy_fields": ["starter_whiff_proxy"]
Set `numeric_projection` to a value (e.g. 5.2) with tighter confidence band
(per WI-0742 FALLBACK behavior: play_range boundaries narrowed, no STRONG edge claims).
Set `edge_stability: "FRAGILE"` and `recommended_direction: "LEAN_OVER"` (not STRONG_OVER).

Step C — mlb_pitcher_k_missing_data_01.json (read-only verify):
Read the file and confirm it has or can have `model_quality: "FALLBACK"`.
If model_quality is missing, add it.
  cat apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_missing_data_01.json

Then run audit tests to confirm all fixtures pass INV-007:
  npm --prefix apps/worker test -- --runInBand src/audit/__tests__/ 2>&1 | tail -15
  </action>
  <verify>npm --prefix apps/worker test -- --runInBand src/audit/__tests__/ 2>&1 | tail -10</verify>
  <done>All audit tests pass; grep "FAILED\|FALLBACK" confirms proxy fixture carries FALLBACK tier</done>
</task>

</tasks>

<verification>
grep -c 'INV-007' apps/worker/src/audit/audit_invariants.js
grep 'model_quality' apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_clean_01.json
grep 'model_quality' apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_proxy_degraded_01.json
npm --prefix apps/worker test -- --runInBand src/audit/__tests__/ 2>&1 | tail -5
npm --prefix apps/worker test -- --runInBand src/jobs/__tests__/mlb-k-input-classifier.test.js 2>&1 | tail -5
</verification>

<success_criteria>
- INV-007 added to audit_invariants.js with model_quality enum check and proxy-exclusion assertion
- mlb_pitcher_k_clean_01.json carries model_quality: FULL_MODEL
- mlb_pitcher_k_proxy_degraded_01.json is a valid fixture carrying model_quality: FALLBACK and proxy_fields: ["starter_whiff_proxy"]
- mlb_pitcher_k_missing_data_01.json carries model_quality: FALLBACK
- All audit tests and classifier unit tests pass
</success_criteria>

<output>
After completion, create `.planning/phases/mlb-k-harden/mlb-k-harden-04-SUMMARY.md`
</output>
