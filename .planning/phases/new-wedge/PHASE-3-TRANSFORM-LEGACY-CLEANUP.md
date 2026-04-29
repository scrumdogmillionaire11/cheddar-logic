# Phase 3 - Results Transform Legacy Helper Cleanup (WI-1212)

Date: 2026-04-28
Owner: TBD
Timebox: 1-2 days
Depends on: Phase 1

## Objective
Resolve unexercised legacy helper paths to reduce contract ambiguity and maintenance overhead.

## Target Helpers
- `hasDecisionV2`
- `resolveLegacyMlbResultsTier`
- `canUseLegacyMlbResultsAdapter`

## Scope
- `web/src/lib/results/transform-layer.ts`
- related results API tests under `web/src/__tests__/` as needed

## Implementation Outline
1. Trace call graph and classify each helper:
- unreachable and removable
- reachable and must be retained
2. Apply one disposition per helper:
- remove dead path, or
- wire into active runtime path and add direct behavioral tests
3. Validate decision-tier behavior parity (`PLAY`, `LEAN`, `PASS`, `INVALID`).

## Acceptance Gates
- No ambiguous dead paths remain in transform logic.
- Behavioral tests prove active contracts unchanged.
- No source-string-only assertions added as primary coverage.

## Risks
- Hidden fallback coupling causing subtle behavior drift.

## Mitigations
- Use parity-style fixture tests before/after cleanup.
- Run full targeted results test suite before closeout.

## Verification Commands
- `npm --prefix web run test:api:results:decision-segmentation`
- `npm --prefix web run test:api:results:no-implicit-actionable-fallback`
