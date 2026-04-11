---
phase: quick-147
plan: 01
subsystem: potd-mlb
tags: [potd, mlb, signal-engine, runtime-augmentation]
dependency_graph:
  requires: [WI-0871, WI-0872, WI-0873]
  provides: [mlb-signal-aware candidate construction, moneyline-only model override]
  affects: [run_potd_engine, signal-engine]
tech_stack:
  added: []
  patterns: [runtime snapshot hydration, candidate-level model signal injection, regression coverage]
key_files:
  created:
    - .planning/quick/147-wi-0874-potd-mlb-integration-wire-mlb-ed/147-SUMMARY.md
  modified:
    - WORK_QUEUE/WI-0874.md
    - apps/worker/src/jobs/potd/signal-engine.js
    - apps/worker/src/jobs/potd/run_potd_engine.js
    - apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js
decisions:
  - "Kept `resolveMLBModelSignal()` in `mlb-model.js` as the source of truth; this branch only wired it into POTD."
  - "Applied the MLB override only to moneyline candidates so totals/spreads do not inherit an unrelated win-probability signal."
  - "Hydrated MLB games with `getLatestOdds(gameId)` inside `gatherBestCandidate()` so the default POTD runner can supply `oddsSnapshot.raw_data.mlb` without changing external job inputs."
  - "Skipped `.planning/STATE.md` update because quick task numbers 147 and 148 are already consumed on mainline after this branch diverged; adding a duplicate row here would corrupt the shared quick-task ledger."
metrics:
  completed: "2026-04-11"
  tasks_completed: 3
  files_modified: 4
  tests:
    - "npm --prefix apps/worker test -- --runInBand --testPathPattern=\"signal-engine|run-potd-engine|mlb-model\" --no-coverage"
    - "npm --prefix apps/worker test -- --runInBand --no-coverage"
---

# Quick Task 147: WI-0874 — POTD MLB Integration

**One-liner:** Wired MLB model signal into POTD candidate scoring by hydrating MLB games with persisted odds snapshots, injecting `mlbSignal` during candidate construction, and applying the model override only on moneyline scoring.

## Summary

This branch already contained the `resolveMLBModelSignal()` helper and the direct `scoreCandidate()` override path, but the runtime handoff was incomplete: POTD never supplied MLB candidates with the persisted `oddsSnapshot` payload that contains `raw_data.mlb`, so the override could not actually activate outside manual test objects.

Implemented the missing path in two places:

- `run_potd_engine.js` now augments MLB games with `getLatestOdds(gameId)` before candidate construction.
- `signal-engine.js` now resolves and attaches `mlbSignal` during `buildCandidates(game)` when the game is MLB and a persisted snapshot is present.

The scoring override remains backward compatible:

- Only moneyline candidates use the MLB model signal.
- Spread and total candidates still use the existing consensus fair-pair path.
- If no persisted snapshot or no valid MLB signal is available, behavior falls back to the current consensus-only path.

## Tasks Completed

| Task | Name | Files |
|------|------|-------|
| 1 | Claim WI-0874 for this branch | `WORK_QUEUE/WI-0874.md` |
| 2 | Hydrate MLB POTD games with persisted snapshot + inject `mlbSignal` in candidate construction | `apps/worker/src/jobs/potd/run_potd_engine.js`, `apps/worker/src/jobs/potd/signal-engine.js` |
| 3 | Add runtime regression coverage for MLB snapshot hydration | `apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js` |

## Verification

- Focused POTD/MLB regression run passed:
  `npm --prefix apps/worker test -- --runInBand --testPathPattern="signal-engine|run-potd-engine|mlb-model" --no-coverage`
- Full worker suite passed:
  `npm --prefix apps/worker test -- --runInBand --no-coverage`

Result summary from the full run:

- `120` test suites passed
- `1515` tests passed
- `10` tests skipped by existing suite guards

Jest emitted its existing open-handle warning after reporting completion, but the suite results themselves were green.
