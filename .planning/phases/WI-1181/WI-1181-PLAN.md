---
phase: WI-1181
plan: 01
type: execute
wave: 1
depends_on: ["WI-1179-01", "WI-1180-01"]
files_modified:
  - apps/worker/src/jobs/run_nhl_model.js
  - apps/worker/src/models/nhl-pace-model.js
  - apps/worker/src/jobs/__tests__/run_nhl_model*.test.js
  - apps/worker/src/jobs/potd/__tests__/signal-engine.test.js
autonomous: true
requirements:
  - WI-1181-SIGNAL-01
  - WI-1181-BLOCKERS-01
  - WI-1181-VIS-01
  - WI-1181-REG-01
must_haves:
  truths:
    - "Actionable NHL moneyline producer rows emit normalized model_signal payload fields required by POTD"
    - "Non-actionable NHL rows explicitly encode ineligibility and blockers instead of null-only ambiguity"
    - "PASS/evidence semantics remain operator-visible while actionable rows provide complete POTD model context"
    - "Producer and consumer contract tests validate both actionable and non-actionable variants"
  artifacts:
    - path: "apps/worker/src/jobs/run_nhl_model.js"
      provides: "Normalized NHL model_signal payload assembly for actionable and non-actionable rows"
    - path: "apps/worker/src/models/nhl-pace-model.js"
      provides: "Support helpers for producer payload assembly when required"
    - path: "apps/worker/src/jobs/__tests__/run_nhl_model*.test.js"
      provides: "Producer-level payload contract tests"
    - path: "apps/worker/src/jobs/potd/__tests__/signal-engine.test.js"
      provides: "Consumer fixture contract compatibility checks"
  key_links:
    - from: "apps/worker/src/jobs/run_nhl_model.js"
      to: "apps/worker/src/jobs/__tests__/run_nhl_model*.test.js"
      via: "Actionable and non-actionable model_signal payload assertions"
      pattern: "model_signal|eligible_for_potd|blockers|edge_available"
    - from: "apps/worker/src/jobs/run_nhl_model.js"
      to: "apps/worker/src/jobs/potd/__tests__/signal-engine.test.js"
      via: "Producer-consumer fixture alignment for POTD model-backed NHL path"
      pattern: "model_signal|market_type|selection_side|model_prob"
---

<objective>
Emit actionable NHL model_signal payloads that POTD can consume directly while preserving explicit non-actionable blocker semantics.

Output: NHL producer writes normalized model_signal for actionable rows and deterministic blocker-rich non-actionable payloads, with contract tests proving both paths.
</objective>

<context>
@.planning/ROADMAP.md
@WORK_QUEUE/WI-1181.md
@apps/worker/src/jobs/run_nhl_model.js
@apps/worker/src/models/nhl-pace-model.js
@apps/worker/src/jobs/__tests__/run_nhl_model*.test.js
@apps/worker/src/jobs/potd/__tests__/signal-engine.test.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Normalize actionable NHL producer model_signal payload</name>
  <files>apps/worker/src/jobs/run_nhl_model.js, apps/worker/src/models/nhl-pace-model.js, apps/worker/src/jobs/__tests__/run_nhl_model*.test.js</files>
  <action>Update NHL producer output so actionable rows include normalized model_signal fields required by POTD: eligible_for_potd, market_type, selection_side, selection_team, model_prob, book_price, implied_prob, edge_pct, fair_price, edge_available, source, blockers. Preserve existing producer behavior outside this payload contract.</action>
  <verify>
    <automated>npm --prefix apps/worker run test -- src/jobs/__tests__/run_nhl_model*.test.js --runInBand</automated>
  </verify>
  <done>Actionable NHL rows emit complete model_signal payloads with finite probability and edge context fields.</done>
</task>

<task type="auto">
  <name>Task 2: Encode explicit non-actionable blockers for ineligible NHL rows</name>
  <files>apps/worker/src/jobs/run_nhl_model.js, apps/worker/src/jobs/__tests__/run_nhl_model*.test.js, apps/worker/src/jobs/potd/__tests__/signal-engine.test.js</files>
  <action>For non-actionable rows emit eligible_for_potd=false, edge_available=false, and explicit blockers (for example NO_MARKET_LINE or GOALIE_CONTEXT_MISSING) rather than null-only payloads. Keep PASS/evidence visibility for operators while ensuring POTD consumer fixtures interpret non-actionable rows deterministically.</action>
  <verify>
    <automated>npm --prefix apps/worker run test -- src/jobs/potd/__tests__/signal-engine.test.js --runInBand -t "NHL|model_signal"</automated>
  </verify>
  <done>Non-actionable NHL rows carry explicit blockers and deterministic ineligibility semantics without breaking POTD fixture consumption.</done>
</task>

<task type="auto">
  <name>Task 3: Run producer and POTD regression suites</name>
  <files>apps/worker/src/jobs/__tests__/run_nhl_model*.test.js, apps/worker/src/jobs/potd/__tests__/signal-engine.test.js</files>
  <action>Execute WI-required NHL producer and POTD suites from repo root to validate actionable and non-actionable model_signal contract behavior and ensure no regression in existing candidate selection paths.</action>
  <verify>
    <automated>npm --prefix apps/worker run test -- src/jobs/__tests__/run_nhl_model*.test.js --runInBand && npm --prefix apps/worker run test -- src/jobs/potd/__tests__/signal-engine.test.js --runInBand && npm --prefix apps/worker run test -- src/jobs/potd/ --runInBand</automated>
  </verify>
  <done>Producer and POTD suites pass with normalized model_signal payload contract enforced.</done>
</task>

</tasks>

<success_criteria>
- Actionable NHL rows emit normalized model_signal fields required by POTD.
- Non-actionable rows emit explicit blockers with eligible_for_potd=false and edge_available=false.
- PASS/evidence operator semantics remain available.
- Producer and POTD tests verify both actionable and non-actionable variants.
</success_criteria>
