---
phase: WI-1181
plan: 01
subsystem: api
tags: [nhl, potd, model-signal, contracts, testing]
requires:
  - phase: WI-1179
    provides: NHL payload extractor compatibility for actionable model fields
  - phase: WI-1180
    provides: MODEL_SIGNAL_INCOMPLETE diagnostics in POTD runner
provides:
  - normalized NHL moneyline model_signal payload contract with explicit blockers
  - producer wiring for nhl-model-output and nhl-moneyline-call payloads
  - producer and consumer contract test coverage for actionable and non-actionable variants
affects: [potd, nhl-model, run-nhl-model, signal-engine]
tech-stack:
  added: []
  patterns: [normalized payload contract, blocker-first ineligibility semantics]
key-files:
  created: []
  modified:
    - apps/worker/src/jobs/run_nhl_model.js
    - apps/worker/src/jobs/__tests__/run_nhl_model.test.js
    - apps/worker/src/jobs/potd/__tests__/signal-engine.test.js
    - WORK_QUEUE/WI-1181.md
key-decisions:
  - "Model-backed NHL producer rows now carry a canonical model_signal object with eligibility and blockers as first-class fields."
  - "nhl-model-output payloads are enriched with MONEYLINE signal context without changing existing PASS/evidence status semantics."
patterns-established:
  - "When POTD needs deterministic ineligibility handling, emit explicit blockers instead of implicit null-only payloads."
  - "Attach model_signal at producer write-time so downstream consumers do not infer contract state heuristically."
requirements-completed: [WI-1181-SIGNAL-01, WI-1181-BLOCKERS-01, WI-1181-VIS-01, WI-1181-REG-01]
duration: 9min
completed: 2026-04-25
---

# Phase WI-1181 Plan 01: Actionable NHL model_signal Payload Summary

**NHL producer payloads now emit a normalized MONEYLINE model_signal contract with explicit eligibility/blocker semantics for POTD consumption paths.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-04-25T20:13:18Z
- **Completed:** 2026-04-25T20:21:57Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- Added a normalized NHL model_signal builder in the producer with all required fields: eligibility, market/selection context, probability/price/edge metrics, source, and blockers.
- Wired model_signal emission into both nhl-moneyline-call and nhl-model-output producer payload paths.
- Added and passed producer + consumer contract tests covering actionable and non-actionable model_signal variants.

## Task Commits

Each task was committed atomically:

1. **Task 1: Normalize actionable NHL producer model_signal payload** - `1c556379` (feat)
2. **Task 2: Encode explicit non-actionable blockers for ineligible NHL rows** - `2776ffaf` (test)
3. **Task 3: Run producer and POTD regression suites** - no code diff (verification-only task)

**Plan metadata:** pending final docs commit

## Files Created/Modified

- `apps/worker/src/jobs/run_nhl_model.js` - Added model_signal normalization and card-level signal wiring for NHL producer outputs.
- `apps/worker/src/jobs/__tests__/run_nhl_model.test.js` - Added WI-1181 producer contract tests for actionable and blocker-rich model_signal behavior.
- `apps/worker/src/jobs/potd/__tests__/signal-engine.test.js` - Updated NHL payload fixture to include modern model_signal shape compatibility.
- `WORK_QUEUE/WI-1181.md` - Claimed work item ownership for execution traceability.

## Decisions Made

- Producer payloads now explicitly encode ineligibility with blocker codes such as NO_MARKET_LINE and GOALIE_CONTEXT_MISSING.
- nhl-model-output rows are enriched with moneyline signal context while preserving existing visibility semantics and without changing scheduler/orchestration behavior.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Shell glob expansion rejected the unquoted producer test glob (`run_nhl_model*.test.js`); resolved by quoting the jest path argument.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- NHL producer now emits deterministic model_signal payloads suitable for downstream model-backed gating and diagnostics.
- No blockers identified for follow-up verification or integration work.

---
*Phase: WI-1181*
*Completed: 2026-04-25*

## Self-Check: PASSED

- FOUND: .planning/phases/WI-1181/WI-1181-01-SUMMARY.md
- FOUND: 1c556379
- FOUND: 2776ffaf
