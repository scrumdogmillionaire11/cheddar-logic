---
phase: WI-1181
plan: 01
type: execute
wave: 1
depends_on: ["WI-1179-01", "WI-1180-01"]
files_modified:
  - apps/worker/src/jobs/run_nhl_model.js
  - apps/worker/src/jobs/potd/signal-engine.js
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
    - "POTD consumes payload-backed NHL MODEL candidates using model_signal.eligible_for_potd and side-binding to model_signal.selection_side"
    - "Producer and consumer contract tests validate both actionable and non-actionable variants"
  artifacts:
    - path: "apps/worker/src/jobs/run_nhl_model.js"
      provides: "Normalized NHL model_signal payload assembly for actionable and non-actionable rows"
    - path: "apps/worker/src/jobs/potd/signal-engine.js"
      provides: "Consumer-side fail-closed enforcement for eligible_for_potd and selection_side contract"
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
      to: "apps/worker/src/jobs/potd/signal-engine.js"
      via: "Producer model_signal eligibility and selection_side consumed as hard contract gates"
      pattern: "eligible_for_potd|selection_side|MODEL_SIGNAL_INCOMPLETE"
    - from: "apps/worker/src/jobs/potd/signal-engine.js"
      to: "apps/worker/src/jobs/potd/__tests__/signal-engine.test.js"
      via: "Consumer fail-closed behavior for side-mismatch and incomplete signal diagnostics"
      pattern: "MODEL_SIGNAL_INCOMPLETE|SELECTION_SIDE_MISMATCH|eligible_for_potd"
---

<objective>
Emit actionable NHL model_signal payloads that POTD can consume directly while preserving explicit non-actionable blocker semantics.

Output: NHL producer writes normalized model_signal for actionable rows and deterministic blocker-rich non-actionable payloads, with contract tests proving both paths.
</objective>

<context>
@.planning/ROADMAP.md
@WORK_QUEUE/WI-1181.md
@apps/worker/src/jobs/run_nhl_model.js
@apps/worker/src/jobs/potd/signal-engine.js
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
  <name>Task 2: Enforce fail-closed NHL consumer gates for eligibility and side-binding</name>
  <files>apps/worker/src/jobs/run_nhl_model.js, apps/worker/src/jobs/potd/signal-engine.js, apps/worker/src/jobs/__tests__/run_nhl_model*.test.js, apps/worker/src/jobs/potd/__tests__/signal-engine.test.js</files>
  <action>For non-actionable rows emit eligible_for_potd=false, edge_available=false, and explicit blockers (for example NO_MARKET_LINE or GOALIE_CONTEXT_MISSING) rather than null-only payloads. In POTD consumer scoring for payload-backed NHL MODEL candidates, enforce model_signal.eligible_for_potd as the acceptance gate and bind candidate direction to model_signal.selection_side. If model_signal is missing, ineligible, incomplete, or side-mismatched, fail closed with MODEL_SIGNAL_INCOMPLETE diagnostics including blockers (and SELECTION_SIDE_MISMATCH when applicable).</action>
  <verify>
    <automated>npm --prefix apps/worker run test -- src/jobs/potd/__tests__/signal-engine.test.js --runInBand -t "NHL model_signal POTD consumption contract"</automated>
  </verify>
  <done>Non-actionable NHL rows carry explicit blockers and POTD rejects payload-backed NHL MODEL candidates unless eligible_for_potd is true and candidate side matches selection_side.</done>
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
- POTD rejects payload-backed NHL candidates when model_signal is missing/incomplete or when candidate side does not match model_signal.selection_side.
- PASS/evidence operator semantics remain available.
- Producer and POTD tests verify both actionable and non-actionable variants, including side-mismatch fail-closed behavior.
</success_criteria>
