# Phase 2 - Surfaced-Play Settlement Policy Regression Matrix (WI-1211)

Date: 2026-04-28
Owner: TBD
Timebox: 1.5-3 days
Depends on: Phase 0
Can run in parallel with: Phase 1

## Objective
Enforce surfaced-play settlement policy boundaries with explicit tests for allowed exceptions and prohibited paths.

## Scope
- `apps/worker/src/jobs/settle_pending_cards.js`
- `apps/worker/src/jobs/__tests__/settle_pending_cards.phase2.test.js`
- additional targeted settlement-policy tests under `apps/worker/src/jobs/__tests__/`

## Implementation Outline
1. Encode policy matrix in tests:
- non-displayed non-exception rows do not settle
- displayed eligible rows settle
- approved exception markets settle only under explicit prerequisites
2. Add duplicate-settlement prevention assertions.
3. Add negative-path fixture coverage for unsurfaced rows.
4. Keep assertions behavioral (state transitions, ledger effects), not source-shape checks.

## Acceptance Gates
- Violations fail fast with readable test names and messages.
- Exception behavior is explicit and documented in tests.
- Existing settlement tests stay green.

## Risks
- Hidden market-specific branch behavior causing brittle tests.
- Existing fixtures not rich enough for exception paths.

## Mitigations
- Add one fixture per exception class.
- Validate transitions row-by-row in assertions.

## Verification Commands
- `npm --prefix apps/worker test -- src/jobs/__tests__/settle_pending_cards.phase2.test.js`
- `npm --prefix apps/worker test -- src/jobs/__tests__/settle_pending_cards.non-actionable.test.js`
- `npm --prefix apps/worker test -- src/jobs/__tests__/negative-path-settlement-live-truth.test.js`
