# Phase 1 - /api/results Performance Budget Harness (WI-1210)

Date: 2026-04-28
Owner: TBD
Timebox: 2-4 days
Depends on: Phase 0

## Objective
Add deterministic, enforceable regression protection for latency and heap under high-cardinality results datasets.

## Scope
- `web/src/app/api/results/route.ts`
- `web/src/lib/results/query-layer.ts`
- `web/src/lib/results/transform-layer.ts`
- `web/src/__tests__/` performance-focused results tests

## Implementation Outline
1. Build deterministic seed path for high-cardinality result fixtures.
2. Add test harness scenarios:
- default `/api/results`
- `/api/results?limit=200`
- `/api/results?limit=200&dedupe=0`
- one filtered variant
3. Capture timing and heap metrics in-test.
4. Enforce thresholds with clear failure output: measured vs budget.
5. Run stability pass (at least two consecutive runs).

## Acceptance Gates
- Tests are deterministic enough for CI.
- Budget failures are actionable and non-ambiguous.
- Existing behavioral contract tests remain green.

## Risks
- Flaky runtime thresholds due to shared CI noise.
- Slow fixture setup increasing total test runtime.

## Mitigations
- Use bounded datasets and warm-up iteration policy.
- Separate performance command from default smoke path if needed.

## Verification Commands
- `npm --prefix web run test:results:behavioral-contract`
- `npm --prefix web run test:api:results:decision-segmentation`
- `npm --prefix web run test:api:results:performance-budget` (new)
