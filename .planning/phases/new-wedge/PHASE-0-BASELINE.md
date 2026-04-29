# Phase 0 - Baseline and Policy Lock

Date: 2026-04-28
Owner: TBD
Timebox: 0.5-1 day

## Objective
Lock thresholds and policy definitions before implementation work starts.

## Inputs
- `.planning/codebase/CONCERNS.md`
- `WORK_QUEUE/WI-1210.md`
- `WORK_QUEUE/WI-1211.md`
- `WORK_QUEUE/WI-1212.md`

## Decisions Required
1. Performance budgets for `/api/results`:
- p50 and p95 latency targets.
- max heap delta per scenario.
- CI variance tolerance and retry policy.

2. Settlement surfaced-play exception matrix:
- Approved exception markets.
- Required prerequisites per exception.
- Explicit non-exception deny list behavior.

3. Legacy helper disposition strategy:
- Delete-first when unreachable.
- Retain only with runtime usage and direct behavioral coverage.

## Deliverables
- Budget table committed in test doc comments (or adjacent planning note).
- Exception matrix committed as test-case source of truth.
- Signed decision note for helper cleanup strategy.

## Exit Criteria
- All thresholds and policy paths are explicit and measurable.
- No coding started without approved baseline values.
