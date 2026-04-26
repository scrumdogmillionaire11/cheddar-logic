---
phase: WI-1180
plan: 01
type: execute
wave: 1
depends_on: ["WI-1179-01"]
files_modified:
  - apps/worker/src/jobs/potd/signal-engine.js
  - apps/worker/src/jobs/potd/run_potd_engine.js
  - apps/worker/src/jobs/potd/__tests__/signal-engine.test.js
  - apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js
autonomous: true
requirements:
  - WI-1180-MODEL-01
  - WI-1180-CONSENSUS-01
  - WI-1180-MLB-01
  - WI-1180-NHL-01
  - WI-1180-REG-01
must_haves:
  truths:
    - "Contract-MODEL markets with present-but-incomplete model payloads emit explicit rejection diagnostics instead of silently becoming normal consensus candidates"
    - "Consensus fallback is only allowed where edge-source contract explicitly permits CONSENSUS_FALLBACK"
    - "Modern actionable MLB model rows remain eligible for MODEL scoring"
    - "NHL PASS/evidence rows remain non-actionable and are surfaced with explicit rejection diagnostics"
  artifacts:
    - path: "apps/worker/src/jobs/potd/signal-engine.js"
      provides: "Model-incomplete rejection path and fallback gate enforcement"
    - path: "apps/worker/src/jobs/potd/run_potd_engine.js"
      provides: "Runner-level propagation of explicit rejection diagnostics"
    - path: "apps/worker/src/jobs/potd/__tests__/signal-engine.test.js"
      provides: "Signal-engine regressions for no-silent-fallback behavior"
    - path: "apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js"
      provides: "Runner regression coverage for rejection visibility"
  key_links:
    - from: "apps/worker/src/jobs/potd/signal-engine.js"
      to: "apps/worker/src/jobs/potd/__tests__/signal-engine.test.js"
      via: "Assertions that incomplete MODEL payloads emit explicit diagnostics and skip normal consensus scoring"
      pattern: "MODEL_SIGNAL_INCOMPLETE|CONSENSUS_FALLBACK|edgeSourceTag"
    - from: "apps/worker/src/jobs/potd/run_potd_engine.js"
      to: "apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js"
      via: "Runner-level rejection reason surfacing and nominee eligibility checks"
      pattern: "rejection|reason|candidatePool"
---

<objective>
Prevent silent consensus fallback for incomplete model payloads in POTD by making failure reasons explicit and preserving edge-source contract semantics.

Output: Signal-engine and runner diagnostics are explicit for model-incomplete paths, with regression tests proving no silent downgrade.
</objective>

<context>
@.planning/ROADMAP.md
@WORK_QUEUE/WI-1180.md
@apps/worker/src/jobs/potd/signal-engine.js
@apps/worker/src/jobs/potd/run_potd_engine.js
@apps/worker/src/jobs/potd/__tests__/signal-engine.test.js
@apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add explicit MODEL-incomplete rejection path in signal engine</name>
  <files>apps/worker/src/jobs/potd/signal-engine.js, apps/worker/src/jobs/potd/__tests__/signal-engine.test.js</files>
  <action>Detect when a model payload exists but required model extraction/actionability fields are incomplete for contract-MODEL markets. Emit an explicit rejection diagnostic (for example MODEL_SIGNAL_INCOMPLETE) and prevent ordinary consensus scoring on that path. Keep contract-defined CONSENSUS_FALLBACK behavior unchanged for markets that allow it.</action>
  <verify>
    <automated>npm --prefix apps/worker run test -- src/jobs/potd/__tests__/signal-engine.test.js --runInBand -t "MODEL_SIGNAL_INCOMPLETE|fallback"</automated>
  </verify>
  <done>MODEL-contract markets with incomplete model payloads are explicitly rejected and do not silently follow normal consensus candidate flow.</done>
</task>

<task type="auto">
  <name>Task 2: Surface rejection diagnostics through POTD runner eligibility flow</name>
  <files>apps/worker/src/jobs/potd/run_potd_engine.js, apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js</files>
  <action>Wire signal-engine rejection diagnostics through runner candidate filtering and reporting so model-incomplete rows are visibly rejected with reason detail. Preserve existing orchestration behavior and avoid changes to bankroll, scheduler, or posting policies.</action>
  <verify>
    <automated>npm --prefix apps/worker run test -- src/jobs/potd/__tests__/run-potd-engine.test.js --runInBand</automated>
  </verify>
  <done>Runner outputs show explicit model-incomplete rejection diagnostics and no silent fallback for contract-MODEL markets.</done>
</task>

<task type="auto">
  <name>Task 3: Run full POTD suite regression for contract safety</name>
  <files>apps/worker/src/jobs/potd/__tests__/signal-engine.test.js, apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js</files>
  <action>Run WI-required POTD test commands from repo root to validate incomplete-model rejection diagnostics, fallback constraints, and non-regression in existing eligibility gates.</action>
  <verify>
    <automated>npm --prefix apps/worker run test -- src/jobs/potd/__tests__/signal-engine.test.js --runInBand && npm --prefix apps/worker run test -- src/jobs/potd/__tests__/run-potd-engine.test.js --runInBand && npm --prefix apps/worker run test -- src/jobs/potd/ --runInBand</automated>
  </verify>
  <done>All targeted and suite-level POTD tests pass with explicit diagnostic behavior locked.</done>
</task>

</tasks>

<success_criteria>
- Incomplete model payloads for contract-MODEL markets emit explicit diagnostics and do not silently become normal consensus candidates.
- Consensus fallback remains available only where contract permits CONSENSUS_FALLBACK.
- MLB modern actionable rows can still score as MODEL.
- NHL PASS/evidence rows remain non-actionable with explicit rejection visibility.
</success_criteria>
