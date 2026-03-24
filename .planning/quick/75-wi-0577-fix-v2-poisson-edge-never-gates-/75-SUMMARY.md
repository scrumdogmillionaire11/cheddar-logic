---
phase: quick
plan: 75
subsystem: nhl-player-shots-model
tags: [guard, v2-veto, poisson, fire-downgrade, symmetry, wi-0577]
dependency_graph:
  requires: [WI-0577 partial (1P Guard 3 already done)]
  provides: [full-game Guard 3 parity with 1P Guard 3]
  affects: [run_nhl_player_shots_model.js full-game FIRE decisions on odds-backed cards]
tech_stack:
  added: []
  patterns: [V2 Poisson veto guard, console.warn tag pattern [v2-veto-full]]
key_files:
  created: []
  modified:
    - apps/worker/src/jobs/run_nhl_player_shots_model.js
    - apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js
decisions:
  - Checked warnSpy.mock.calls BEFORE mockRestore() to avoid Jest clearing call list on restore
  - Guard 3 uses usingRealLine (not isOddsBacked) for consistency with existing Guard 1 condition
metrics:
  duration: "~12 minutes"
  completed: "2026-03-23T23:59:27Z"
  tasks_completed: 1
  files_modified: 2
---

# Phase quick Plan 75: WI-0577 Add V2 Poisson Veto Guard to Full-Game Path Summary

One-liner: Added Guard 3 (V2 Poisson veto) to full-game path — mirrors 1P Guard 3 with [v2-veto-full] log tag, downgrades FIRE→WATCH when edge_<dir>_pp < 0 on odds-backed cards.

## What Was Changed

### File: `apps/worker/src/jobs/run_nhl_player_shots_model.js`

**Location:** Lines 2065–2089 (immediately after Guard 2 closing brace, before `fullDirectionLabel`)

**Guard condition added:**
```javascript
if (usingRealLine && fullDecision.action === 'FIRE') {
  const v2EdgeForDir =
    fullGameEdge.direction === 'UNDER'
      ? v2EdgeUnderPp
      : v2EdgeOverPp;
  if (
    typeof v2EdgeForDir === 'number' &&
    Number.isFinite(v2EdgeForDir) &&
    v2EdgeForDir < 0
  ) {
    console.warn(
      `[${JOB_NAME}] [v2-veto-full] Downgraded ${playerName} FIRE→WATCH (V2 edge_${fullGameEdge.direction.toLowerCase()}_pp=${v2EdgeForDir.toFixed(4)} < 0)`,
    );
    fullDecision = {
      action: 'HOLD',
      status: 'WATCH',
      classification: 'LEAN',
      officialStatus: 'LEAN',
    };
  }
}
```

Variables in scope at insert point:
- `usingRealLine`: set at line 1893 as `!!selectedPropMarketEvaluation`
- `v2EdgeOverPp` / `v2EdgeUnderPp`: destructured at lines 1946–1947 from `buildV2PricingState()`
- `fullGameEdge`: set at line 2028 from `classifyEdge(mu, syntheticLine, confidence)`

### File: `apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js`

Added `WI-0577 Guard 3: full-game FIRE is downgraded to WATCH when V2 edge_over_pp is negative on odds-backed card` test.

Key pattern: spy `console.warn`, run model, check spy.mock.calls for `[v2-veto-full]` BEFORE calling `warnSpy.mockRestore()` (calling mockRestore first clears the call list in Jest).

## Test Coverage

- 4 WI-0577 tests pass:
  1. `WI-0577: legacy HOT over seed cannot leak FIRE...` (existing)
  2. `WI-0577: explicit projection conflict keeps canonical PASS fields aligned` (existing)
  3. `WI-0577 Guard 3: 1P FIRE is downgraded to WATCH...` (existing)
  4. `WI-0577 Guard 3: full-game FIRE is downgraded to WATCH...` (NEW)
- Full suite: 61/61 pass
- Lint: 0 errors

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test ordering: warnSpy.mock.calls checked after mockRestore clears call list**
- **Found during:** Step 3 (GREEN phase — test still failing after implementation)
- **Issue:** The plan's test snippet called `warnSpy.mockRestore()` before checking `warnSpy.mock.calls`. Jest's `mockRestore()` calls `mockReset()` internally, clearing the call list.
- **Fix:** Moved `expect(vetoWarn).toBeDefined()` check before `warnSpy.mockRestore()`
- **Files modified:** `run_nhl_player_shots_model.test.js`
- **Commit:** 556d1cc

## Commits

- `ab4a019` — `test(qt-75): add failing Guard 3 full-game regression test (WI-0577)` [RED]
- `556d1cc` — `feat(qt-75): add Guard 3 V2 Poisson veto to full-game path (WI-0577)` [GREEN + fix]

## Self-Check: PASSED

- run_nhl_player_shots_model.js: FOUND
- run_nhl_player_shots_model.test.js: FOUND
- Commit ab4a019: FOUND
- Commit 556d1cc: FOUND
