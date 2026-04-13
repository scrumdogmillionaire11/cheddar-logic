# ADR-0014: Archive NFL Model Stub and Disable Scheduler Registration

- Status: Accepted
- Date: 2026-04-13
- Work item: WI-2780

## Context

NFL model execution exists as a stub without a production-grade NFL data layer.
Even when feature flags default to off, retaining active scheduler wiring creates
risk of accidental enablement and low-quality card generation.

A legacy runner at apps/worker/src/jobs/run_nfl_model.js was still callable from
scripts and referenced by scheduler subcomponents, which can be re-enabled via
environment drift.

## Decision

NFL model execution is archived and removed from active scheduler orchestration.

- The previous implementation is preserved at:
  - apps/worker/src/jobs/_archive/run_nfl_model.js
- The active entrypoint remains at:
  - apps/worker/src/jobs/run_nfl_model.js
  - It now returns an explicit archived/disabled result and logs a warning.
- Main scheduler registration is removed:
  - No NFL sub-scheduler dispatch from apps/worker/src/schedulers/main.js
  - NFL removed from active SPORT_JOBS scheduler sport map

## Reintroduction Checklist

Before reactivating NFL model execution, complete all items:

- Define NFL data contracts (odds, injuries, roster/status, game metadata)
- Add deterministic validation gates equivalent to active sports
- Add end-to-end tests for inference output + card payload schema
- Add scheduler idempotency + t-minus coverage tests
- Add operations runbook and rollout/rollback plan
- Replace disabled shim with reviewed production implementation

## Consequences

- NFL cards cannot be emitted from scheduler ticks.
- Direct execution of run_nfl_model reports archived status instead of running
  inference.
- The old implementation remains available for reference-only recovery work.
