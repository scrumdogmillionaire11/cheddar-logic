---
phase: mlb-k-harden
plan: "03"
type: execute
wave: 2
depends_on: ["mlb-k-harden-01"]
files_modified:
  - apps/worker/src/jobs/run_mlb_model.js
autonomous: true

must_haves:
  truths:
    - "Pre-model audit block logs pitcher name, starter_skill_status, opponent_contact_status, leash_status, missing_fields, proxy_fields, quality_before_projection — before first k_mean calculation"
    - "classifyMlbPitcherKQuality is called from run_mlb_model.js with real inputs assembled from DB row"
    - "prop_decision in emitted card carries model_quality field with value from classifier"
    - "flags array in emitted payload is deduplicated via dedupeFlags before card write"
    - "No existing tests regress"
  artifacts:
    - path: "apps/worker/src/jobs/run_mlb_model.js"
      provides: "Pre-model completeness block + classifier wiring + flag dedup"
      contains: "classifyMlbPitcherKQuality"
  key_links:
    - from: "apps/worker/src/jobs/run_mlb_model.js"
      to: "apps/worker/src/jobs/mlb-k-input-classifier.js"
      via: "require at top of file"
      pattern: "require.*mlb-k-input-classifier"
    - from: "classifyMlbPitcherKQuality result"
      to: "prop_decision.model_quality"
      via: "spreads result.model_quality into the card prop_decision object"
      pattern: "model_quality.*classif|classif.*model_quality"
---

<objective>
Wire the classifier module (plan 01) into run_mlb_model.js: add a pre-model
completeness audit block per pitcher, set model_quality in prop_decision from
classifier output, and deduplicate all flag arrays before card write.

Purpose: This is where the degradation evidence goes from "smoke" to "traceable instrument."
The pre-model block is how you see exactly where the pipeline falls off for any
given pitcher without waiting for the final card.
Output: run_mlb_model.js with instrumentation wired.
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@WORK_QUEUE/WI-0747.md
@.planning/phases/mlb-k-harden/mlb-k-harden-01-SUMMARY.md
@apps/worker/src/jobs/run_mlb_model.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Require classifier, add pre-model audit block, wire model_quality into prop_decision</name>
  <files>apps/worker/src/jobs/run_mlb_model.js</files>
  <action>
Step A — Add require at top of run_mlb_model.js (alongside existing requires):
  const { classifyMlbPitcherKQuality, buildCompletenessMatrix, dedupeFlags } = require('./mlb-k-input-classifier');

Step B — Locate the MLB pitcher-K path in run_mlb_model.js. Look for the section
where per-pitcher data is assembled from the DB row (around the `swstr_pct` read
at line 1149 based on current code) and before any k_mean calculation.

Add a pre-model audit block immediately after the per-pitcher input assembly:
```js
// PRE-MODEL AUDIT — MLB_PITCHER_K
const _starterInputs = {
  k_pct: row.k_pct ?? null,
  swstr_pct: row.season_swstr_pct ?? null,
  csw_pct: row.csw_pct ?? null,
  pitch_count_avg: row.pitch_count_avg ?? null,
  ip_avg: row.ip_avg ?? null,
  whiff_proxy: row._whiff_proxy ?? null,   // set if ingest used proxy
};
const _opponentInputs = {
  k_pct_vs_hand: row.opp_k_pct_vs_hand ?? null,
  contact_pct_vs_hand: row.opp_contact_pct ?? null,
  chase_pct_vs_hand: row.opp_chase_pct ?? null,
  projected_lineup_status: row.lineup_status ?? 'MISSING',
};
const _leashInputs = {
  pitch_count_avg: row.pitch_count_avg ?? null,
  ip_avg: row.ip_avg ?? null,
  ip_proxy: row._ip_proxy ?? null,          // set if ingest used proxy
};
const _qualityDecision = classifyMlbPitcherKQuality({
  starter: _starterInputs,
  opponent: _opponentInputs,
  leash: _leashInputs,
});
console.log('[MLB_K_AUDIT]', JSON.stringify({
  pitcher: row.pitcher_name ?? row.pitcher_id,
  starter_skill_status: (_starterInputs.k_pct && (_starterInputs.swstr_pct || _starterInputs.csw_pct)) ? 'COMPLETE' : 'PARTIAL',
  opponent_contact_status: (_opponentInputs.k_pct_vs_hand && _opponentInputs.contact_pct_vs_hand) ? 'COMPLETE' : 'PARTIAL',
  leash_status: (_leashInputs.pitch_count_avg || _leashInputs.ip_avg) ? 'COMPLETE' : 'PARTIAL',
  missing_fields: _qualityDecision.hardMissing,
  proxy_fields: _qualityDecision.proxies,
  quality_before_projection: _qualityDecision.model_quality,
}));
```

Step C — Find where `prop_decision` is assembled for MLB_PITCHER_K cards.
Add `model_quality: _qualityDecision.model_quality` to the prop_decision object.
Also spread `degradation_reasons: [..._qualityDecision.hardMissing, ..._qualityDecision.proxies]`.

IMPORTANT: Do not remove or change any existing prop_decision fields. Add the
new fields alongside existing ones. If prop_decision is built across multiple
steps, add model_quality at the final assembly point.

Grep the file for `prop_decision` to find exact location before editing:
  grep -n 'prop_decision' apps/worker/src/jobs/run_mlb_model.js | head -30
  </action>
  <verify>grep -n 'classifyMlbPitcherKQuality\|MLB_K_AUDIT\|model_quality' apps/worker/src/jobs/run_mlb_model.js | head -10</verify>
  <done>grep returns at least 3 lines: the require, the audit log, and the model_quality assignment in prop_decision</done>
</task>

<task type="auto">
  <name>Task 2: Deduplicate flags array at card payload assembly point</name>
  <files>apps/worker/src/jobs/run_mlb_model.js</files>
  <action>
Find the place in run_mlb_model.js where the final card payload is assembled
or returned for MLB_PITCHER_K cards — where `flags` (or equivalent) is written
into the payload object.

Grep first to find it:
  grep -n 'flags\|missing_inputs' apps/worker/src/jobs/run_mlb_model.js | head -20

At the point where flags/missing_inputs are written into the card payload,
apply deduplication:
  payload.flags = dedupeFlags(payload.flags ?? []);                  // or
  card.missing_inputs = dedupeFlags(card.missing_inputs ?? []);      // match existing shape

Apply the same dedup to whatever field holds the card-level flag array.
Do NOT rename the field — just wrap the existing value in dedupeFlags(...).

After this change, verify the existing test suite still passes:
  npm --prefix apps/worker test -- --runInBand src/jobs/__tests__/run_mlb_model.test.js 2>&1 | tail -10

If that test file does not exist, run the audit tests instead:
  npm --prefix apps/worker test -- --runInBand src/audit/__tests__/ 2>&1 | tail -10
  </action>
  <verify>grep -n 'dedupeFlags' apps/worker/src/jobs/run_mlb_model.js</verify>
  <done>grep returns at least 2 lines: the require(destructure) and the dedupeFlags call at payload assembly</done>
</task>

</tasks>

<verification>
grep -c 'classifyMlbPitcherKQuality\|MLB_K_AUDIT\|dedupeFlags' apps/worker/src/jobs/run_mlb_model.js
npm --prefix apps/worker test -- --runInBand src/audit/__tests__/ 2>&1 | tail -5
</verification>

<success_criteria>
- run_mlb_model.js requires mlb-k-input-classifier.js
- Pre-model audit block emits JSON log per pitcher before k_mean—confirms starter/opponent/leash completeness + quality tier
- prop_decision carries model_quality from classifier result
- flags/missing_inputs array deduplicated before card write
- Existing audit tests pass
</success_criteria>

<output>
After completion, create `.planning/phases/mlb-k-harden/mlb-k-harden-03-SUMMARY.md`
</output>
