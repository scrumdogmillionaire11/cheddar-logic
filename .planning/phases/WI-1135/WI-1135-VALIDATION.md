---
phase: WI-1135
status: ready-for-execution
owner: unassigned
last_updated: 2026-04-22
---

# WI-1135 Validation Matrix

## Objective

Validate that `/api/results` decomposition preserves default response contracts while isolating diagnostics/reporting workloads behind explicit gates.

## Requirement Coverage

| Requirement ID | Planned In | Validation Method | Pass Condition |
| --- | --- | --- | --- |
| WI-1135-API-01 | WI-1135-01 | `npm --prefix web run test:api:results:decision-segmentation` | Segmentation behavior remains unchanged after decomposition |
| WI-1135-PERF-01 | WI-1135-01 | `npm --prefix web run test:api:results:flags` | Diagnostic-only expensive paths remain explicitly gated by flags |
| WI-1135-REG-01 | WI-1135-01 | `npm --prefix web run test:ui:results` | UI smoke passes with unchanged default contracts |

## Nyquist Mapping

| Must-Have Truth | Probe | Signal |
| --- | --- | --- |
| Default `/api/results` responses preserve summary/segments/projectionSummaries/ledger contracts | `npm --prefix web run test:ui:results` | Pass/fail output plus zero contract regressions |
| Expensive diagnostics paths are gated and not default behavior | `npm --prefix web run test:api:results:flags` | Flag-driven path checks pass |
| Query/transform/cache split remains behaviorally stable | `npm --prefix web run test:api:results:decision-segmentation` | Segmentation parity checks pass |

## Manual Spot Check

1. Call `/api/results` with default request parameters.
2. Confirm `summary`, `segments`, `projectionSummaries`, and `ledger` fields are present and structurally unchanged.
3. Re-run with diagnostics flags and confirm expensive reporting paths only activate when explicitly enabled.

## Exit Criteria

- All three automated checks pass from repo root.
- Manual spot check confirms default contract parity.
- Any divergence requires updating `WI-1135-01-PLAN.md` task `<done>` criteria before implementation closes.
