---
phase: quick-158
plan: "01"
subsystem: api-contracts
tags: [parity, contracts, tests, cards, games, behavioral-drift]
dependency_graph:
  requires: [WI-0892]
  provides: [endpoint-parity-suite, parity-diff-schema, parity-audit-doc]
  affects: [api/cards, api/games, lib/games/route-handler]
tech_stack:
  added: []
  patterns: [source-contract-test, fixture-driven-parity, deterministic-diff-object]
key_files:
  created:
    - web/src/__tests__/api-endpoint-parity-fixtures.test.js
    - docs/audits/endpoint-parity.md
  modified:
    - web/src/__tests__/api-games-prop-decision-contract.test.js
    - web/src/__tests__/api-cards-lifecycle-regression.test.js
decisions:
  - "Parity suite operates at the normalization-logic layer (source-mirrored helpers) rather than via live HTTP calls, keeping the test runnable with plain `node` and no test runner dependency."
  - "Projection-only rows produce EXPECTED_DELTA on visibility_class because the cards path excludes them (hidden) while the games path includes and classifies them (projection_only). This architectural difference is documented and intentional."
  - "has_projection_marker delta on parity-008 is a consequence of the cards exclusion path running before marker assignment, producing false where games produces true. Documented as EXPECTED_DELTA."
  - "Six pre-existing games-filter test failures are out of scope. They test web/src/app/api/games/route.ts (a one-line re-export) for features implemented only in route-handler.ts."
metrics:
  duration: "~9 minutes"
  completed_date: "2026-04-12"
  tasks_completed: 3
  files_created: 2
  files_modified: 2
---

# Phase quick-158 Plan 01: WI-0902 Endpoint Behavioral Parity Fixtures Summary

**One-liner:** Fixture-driven behavioral parity harness with deterministic diff objects proving projection-only exclusion vs classification is the only architectural difference between /api/cards and /api/games.

---

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Build shared fixture harness for cards/games parity inputs | d7f34d3 | web/src/__tests__/api-endpoint-parity-fixtures.test.js (new) |
| 2 | Align response behavior assertions across cards and games consumers | cac1da2 | api-games-prop-decision-contract.test.js, api-cards-lifecycle-regression.test.js |
| 3 | Implement deterministic parity diff output and audit documentation | d9483be | docs/audits/endpoint-parity.md (new) |

---

## What Was Built

### Task 1 — Shared fixture harness

`web/src/__tests__/api-endpoint-parity-fixtures.test.js` (808 lines)

Defines 8 fixtures covering:
- Standard PLAY / LEAN / PASS decisions with ODDS_BACKED basis (MATCH)
- PASS with explicit reason code (MATCH)
- BLOCKED / NO_BET execution (MATCH)
- Nested `play` sub-object shape (MATCH)
- PROJECTION_ONLY basis/execution_status/prop_display_state (EXPECTED_DELTA on visibility_class)
- Synthetic fallback line_source + projection_source (EXPECTED_DELTA on visibility_class)
- Projection floor line_source (EXPECTED_DELTA on visibility_class + has_projection_marker)

Each fixture drives both:
- `extractCardsPathBehavior()` — mirror of `isBettingSurfacePayload()` from cards routes
- `extractGamesPathBehavior()` — mirror of `normalizeDecisionBasisToken()`, `normalizeExecutionStatusToken()`, `isProjectionOnlyPlayPayload()` from route-handler.ts

### Task 2 — Behavioral field assertions

Added parity-required assertions to two existing test files:

**api-games-prop-decision-contract.test.js:** Three new assertions that games route-handler emits `pass_reason_code`, `execution_status: normalizedExecutionStatus`, `prop_display_state: normalizedPropDisplayState`, and `projection_source` — the four fields needed for parity comparison.

**api-cards-lifecycle-regression.test.js:** New Test 7 with three source-contract checks that both cards routes reference `execution_status`, `PROJECTION_ONLY` detection logic, and `projection_source`/`synthetic_fallback` detection. All existing tests preserved.

### Task 3 — Deterministic parity diff schema

`computeParityDiff()` produces per-fixture diff objects with:
```
{
  gameId, fixtureId,
  cards: { status, reason_code, visibility_class, has_projection_marker },
  games: { status, reason_code, visibility_class, has_projection_marker },
  field_deltas: string[],
  reason_explanation: string,
  parity_status: "MATCH" | "EXPECTED_DELTA" | "UNEXPECTED_DELTA"
}
```

UNEXPECTED_DELTA causes `process.exit(1)` with printed diff. This is the drift detector.

`docs/audits/endpoint-parity.md` documents the full fixture matrix, diff schema definitions, visibility logic for each path, interpretation rules for all three parity_status values, and a how-to-add-new-fixture guide.

---

## Verification Results

| Check | Result |
|-------|--------|
| `node web/src/__tests__/api-endpoint-parity-fixtures.test.js` | PASS (5 MATCH, 3 EXPECTED_DELTA, 0 UNEXPECTED_DELTA) |
| `node web/src/__tests__/api-games-prop-decision-contract.test.js` | PASS |
| `npm --prefix web run test:cards-lifecycle-regression` | PASS |
| `npm --prefix web run build` | PASS |
| `npm --prefix web run test:games-filter` | 23 passed, 6 pre-existing failures (out of scope) |

---

## Deviations from Plan

### Pre-existing test failures (out of scope)

`test:games-filter` has 6 pre-existing failures unrelated to this work. The tests check `web/src/app/api/games/route.ts` for fields like `lifecycle_mode: lifecycleMode`, `FINAL_GAME_RESULT_STATUSES`, `activeStartUtc`, and sport SQL filter that are only present in `web/src/lib/games/route-handler.ts`. Since `route.ts` is a one-line re-export (`export { GET } from '@/lib/games/route-handler'`), these contract assertions never passed for the `route.ts` path. These failures predate this task and are logged to `deferred-items.md` scope.

The plan's Task 2 pre-flight only required `api-games-prop-decision-contract.test.js` and `test:cards-lifecycle-regression` to pass (both passed). The `test:games-filter` failures were pre-existing and are not regressions.

### EXPECTED_DELTA discovery (Rule 1 — behavior documentation)

Running the parity suite revealed three fixtures produce `visibility_class` differences between cards and games paths. These are not bugs — they are the correct representation of an architectural difference documented in WI-0892:
- Cards path: projection-only payloads are filtered out (`isBettingSurfacePayload` returns false)
- Games path: projection-only payloads are included with explicit `projection_only` classification

The parity harness labels cards-excluded rows as `"hidden"` to distinguish them from the explicit games classification of `"projection_only"`. This difference is correct and documented in both the fixture table and the audit doc.

---

## Key Decisions

1. **Source-mirrored normalization helpers** over live HTTP simulation. The test mirrors the exact function logic from both routes rather than making HTTP calls, making it runnable with plain `node` and deterministic on any machine without a running server.

2. **`EXPECTED_DELTA` not `MATCH` for projection-only fixtures.** The cards-excludes vs games-classifies architectural difference IS the correct behavior post-WI-0892. Marking these as MATCH would require the parity harness to paper over a real difference; EXPECTED_DELTA makes the difference explicit and auditable.

3. **Fail hard on UNEXPECTED_DELTA.** Any drift that doesn't match the documented expected deltas causes `process.exit(1)` and prints the full diff. This is the primary purpose of the suite — prevent silent drift.

---

## Self-Check: PASSED

- `web/src/__tests__/api-endpoint-parity-fixtures.test.js` — FOUND
- `docs/audits/endpoint-parity.md` — FOUND
- Commit d7f34d3 — FOUND
- Commit cac1da2 — FOUND
- Commit d9483be — FOUND
