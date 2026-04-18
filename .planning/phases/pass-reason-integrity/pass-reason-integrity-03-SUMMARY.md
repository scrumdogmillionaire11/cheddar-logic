---
phase: pass-reason-integrity
plan: "03"
subsystem: mlb-model
tags: [mlb, pass-reason-code, card-builder, propagation, tdd, display-layer]

# Dependency graph
requires:
  - phase: pass-reason-integrity
    plan: "01"
    provides: MarketEvalResult contract with 6 provenance fields, assertLegalPassNoEdge enforcer
  - phase: pass-reason-integrity
    plan: "02"
    provides: projectFullGameML extended return contract with pass_reason_code, raw_edge_value, threshold_required, threshold_passed

provides:
  - computeMLBDriverCards propagates mlResult.pass_reason_code from projectFullGameML (not hardcoded PASS_NO_EDGE)
  - Projection-floor fallback driver reason_codes contains only PASS_SYNTHETIC_FALLBACK (PASS_NO_EDGE removed)
  - Legal PASS_NO_EDGE invariant in computeSyntheticLineF5Driver documented with comment
  - decisionReason() in post_discord_cards returns null when no reason found (never fabricates PASS_NO_EDGE)
  - decisionReason exported for unit testing

affects:
  - discord-alerts
  - web-api
  - health-monitor

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Card builder propagation: mlResult.pass_reason_code ?? 'PASS_NO_EDGE' — fallback only when model didn't supply one"
    - "Projection-floor driver: only carries reason codes that are semantically correct (edge was never computed, so PASS_NO_EDGE is wrong)"
    - "Display layer null contract: decisionReason() returns null (not a synthetic code) when no reason is present; callers use null-safe patterns"

key-files:
  created: []
  modified:
    - apps/worker/src/models/mlb-model.js
    - apps/worker/src/jobs/run_mlb_model.js
    - apps/worker/src/jobs/post_discord_cards.js
    - apps/worker/src/models/__tests__/mlb-model.test.js
    - apps/worker/src/jobs/__tests__/run_mlb_model.test.js
    - apps/worker/src/jobs/__tests__/post_discord_cards.test.js

key-decisions:
  - "computeMLBDriverCards uses mlResult.pass_reason_code ?? 'PASS_NO_EDGE' — preserves fallback for null model output but propagates correct code when present"
  - "Test H uses real fixture (elitePitcher, +180/-220, highVarContext) rather than mocking internals — confirms PASS_CONFIDENCE_GATE travels end-to-end through card builder"
  - "Test I implemented as source scan — projection-floor driver is inline (not a named function), so structural scan is the most reliable regression guard"
  - "decisionReason exported for unit testing; was previously unexported and uncallable outside module"

patterns-established:
  - "Pass-reason propagation chain: projectFullGameML -> computeMLBDriverCards -> card payload -> decisionReason() — each layer passes through, never re-derives or fabricates"
  - "Null return contract for display utilities: return null on unknown state, let callers handle — never invent a reason code"

requirements-completed:
  - PRI-RUNNER-01
  - PRI-RUNNER-02
  - PRI-DISPLAY-01

# Metrics
duration: 8min
completed: 2026-04-18
---

# Phase pass-reason-integrity Plan 03: Card Builder Propagation and Display Layer Cleanup Summary

**PASS_NO_EDGE truth chain completed: card builder propagates pass_reason_code from projectFullGameML, projection-floor driver scrubbed, decisionReason() returns null instead of fabricating PASS_NO_EDGE**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-04-18T19:19:30Z
- **Completed:** 2026-04-18T19:28:00Z
- **Tasks:** 2 (both TDD: 4 RED + 4 GREEN commits)
- **Files modified:** 6

## Accomplishments

- `computeMLBDriverCards` full_game_ml card builder at mlb-model.js line 2251: changed from `'PASS_NO_EDGE'` hardcode to `mlResult.pass_reason_code ?? 'PASS_NO_EDGE'` — codes like `PASS_CONFIDENCE_GATE` and `PASS_MODEL_DEGRADED` now survive into card payloads
- Projection-floor fallback driver (run_mlb_model.js line 3969): removed `'PASS_NO_EDGE'` from `reason_codes` — inputs were absent so edge was never computed; `PASS_SYNTHETIC_FALLBACK` is the only correct code
- `computeSyntheticLineF5Driver` (run_mlb_model.js line 2979-2980): added INVARIANT comment confirming PASS_NO_EDGE is legal at this site — edge was computed against synthetic line and failed threshold, inputs were present
- `decisionReason()` in post_discord_cards.js: final fallback changed from `return 'PASS_NO_EDGE'` to `return null`; function exported for unit testing
- 8 new tests added (4 per task): Tests H, I, J, J2 — all green. All 290 affected tests pass.

## Task Commits

Each task was committed atomically (TDD: RED then GREEN):

1. **Task 1 RED — Tests H and I failing** - `415d497d` (test)
2. **Task 1 GREEN — propagate pass_reason_code; scrub projection-floor; add invariant comment** - `495d603a` (feat)
3. **Task 2 RED — Tests J/J2 failing** - `0fc865ee` (test)
4. **Task 2 GREEN — remove fabricated PASS_NO_EDGE from decisionReason()** - `981b9dac` (feat)

_Note: TDD tasks have separate RED and GREEN commits per task._

## Files Created/Modified

- `apps/worker/src/models/mlb-model.js` — Line 2251: propagation fix in `computeMLBDriverCards` card builder
- `apps/worker/src/jobs/run_mlb_model.js` — Line 3969: projection-floor reason_codes scrub; line 2979-2980: INVARIANT comment
- `apps/worker/src/jobs/post_discord_cards.js` — `decisionReason()` null fallback; exported `decisionReason`
- `apps/worker/src/models/__tests__/mlb-model.test.js` — Test H (PRI-RUNNER-01 describe block)
- `apps/worker/src/jobs/__tests__/run_mlb_model.test.js` — Test I (PRI-RUNNER-02 describe block, source scan)
- `apps/worker/src/jobs/__tests__/post_discord_cards.test.js` — Tests J/J2/edge cases (PRI-DISPLAY-01 describe block)

## Decisions Made

- Card builder fix uses `??` fallback: `mlResult.pass_reason_code ?? 'PASS_NO_EDGE'` — if model returns null (unexpected state) the card still gets a fallback code rather than null; correctness is enforced at the model layer (Plan 02)
- Test H avoids jest.mock — uses a real fixture (elitePitcher, +180/-220, highVarContext from Scenario C) to drive PASS_CONFIDENCE_GATE through the full call stack; more robust than mocking internals
- Test I is a source scan rather than an integration test — the projection-floor driver is built as an inline literal inside runMlbModel(), not an exported function; source scan is the most maintainable regression guard for this pattern
- `decisionReason` exported from post_discord_cards.js — was previously unreachable for unit testing; export adds no behavior change, only testability

## Deviations from Plan

None — plan executed exactly as written. The three surgical edits were made as specified. Test approach adapted for Test I (source scan) due to inline literal not being an exported function, but the test faithfully captures the invariant.

## Issues Encountered

The plan noted `computeMLBDriverCards` at "line 2214 in run_mlb_model.js" but the function is actually in `mlb-model.js` (line 2251). The plan's `files_modified` list accurately included both files. No actual issue — the fix location was unambiguous.

## Self-Check

Files exist:
- `apps/worker/src/models/mlb-model.js` — FOUND
- `apps/worker/src/jobs/run_mlb_model.js` — FOUND
- `apps/worker/src/jobs/post_discord_cards.js` — FOUND

Commits: 415d497d, 495d603a, 0fc865ee, 981b9dac — all in git log

Test results: 290 passed, 0 failed

## Next Phase Readiness

- The full PASS_NO_EDGE truth chain is now closed: model layer (Plan 02) → card builder (Plan 03) → display layer (Plan 03)
- `assertLegalPassNoEdge` from Plan 01 will correctly validate payloads that now carry accurate reason codes
- No remaining fabrication sites for PASS_NO_EDGE identified in the three consumer files

---
*Phase: pass-reason-integrity*
*Completed: 2026-04-18*
