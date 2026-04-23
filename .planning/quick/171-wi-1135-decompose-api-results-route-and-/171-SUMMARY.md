# Quick Task 171: WI-1135

**Description**: WI-1135: Decompose API Results Route And Isolate Reporting Workloads
**Implementation commit**: `e0a6b433`
**Status**: Complete

## Changes

- Split `/api/results` cache behavior into `web/src/lib/results/cache.ts`.
- Moved results SQL, request filtering, schema capability detection, diagnostic counts, and ledger row queries into `web/src/lib/results/query-layer.ts`.
- Moved decision segmentation, projection summary construction, summary aggregation, and ledger response shaping into `web/src/lib/results/transform-layer.ts`.
- Reduced `web/src/app/api/results/route.ts` to request/security/db orchestration, explicit diagnostic cache bypass, and response finalization.

## Verification

- `./web/node_modules/.bin/tsc --project web/tsconfig.json --noEmit` — passed.
- `npm --prefix web run test:api:results:decision-segmentation` — passed via source fallback.
- `npm --prefix web run test:api:results:flags` — passed.
- `npm --prefix web run test:ui:results` — passed.

## Scope

Changed files match WI-1135 scope plus required work-item claim and GSD quick-task bookkeeping.
