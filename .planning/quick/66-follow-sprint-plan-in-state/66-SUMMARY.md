---
phase: quick-66
plan: "01"
subsystem: edge-math, security, nba-model
tags: [security, edge-calculator, vig-removal, next-upgrade, nba-spread-gate, tdd]
dependency_graph:
  requires: []
  provides: [noVigImplied, vig-removed-edge-baseline, unified-spread-gate, next-16.2.1]
  affects: [edge-calculator.js, run_nba_model.js, flags.js]
tech_stack:
  added: []
  patterns: [TDD red-green, resolveThresholdProfile canonical gate, two-sided vig removal]
key_files:
  created:
    - packages/models/src/__tests__/edge-calculator.test.js
  modified:
    - web/package.json
    - web/package-lock.json
    - packages/models/src/edge-calculator.js
    - packages/models/src/flags.js
    - apps/worker/src/jobs/run_nba_model.js
decisions:
  - "Upgraded Next.js to 16.2.1 (latest stable 16.x) — well above minimum 16.1.7, zero CVE advisories"
  - "noVigImplied uses two-sided normalization: p_nv = p_raw / (p_home_raw + p_away_raw)"
  - "VIG_REMOVAL_SKIPPED:true flag added to return object when only one side available — silent fallback, no exception"
  - "ENABLE_MARKET_THRESHOLDS_V2 defaults true via ternary guard — can be overridden to false via env var"
  - "resolveThresholdProfile imported from @cheddar-logic/models (already re-exported via decisionPipelineV2Patch spread) rather than direct file path"
metrics:
  duration: "~20 minutes"
  completed: "2026-03-22"
  tasks_completed: 3
  files_changed: 7
  tests_added: 18
---

# Phase quick-66 Plan 01: Sprint Security + Edge Math Correctness Summary

**One-liner:** Patched Next.js CVE (16.1.6 → 16.2.1), added two-sided vig removal to all edge functions, and unified NBA spread gate to canonical resolveThresholdProfile lean_edge_min (0.035).

---

## Tasks Completed

| Task | WI | Description | Commit |
|------|----|-------------|--------|
| 1 | WI-0561 | Upgrade Next.js 16.1.6 → 16.2.1, zero audit advisories | 67f0cb9 |
| 2 (TDD RED) | WI-0551 | Failing tests for noVigImplied + vig-removal wiring | dfe048f |
| 2 (TDD GREEN) | WI-0551 | noVigImplied implemented, wired into all compute*Edge | abb6a92 |
| 3 (TDD RED) | WI-0555 | Failing spread gate assertions (0.025 below 0.035) | ab30d64 |
| 3 (TDD GREEN) | WI-0555 | resolveThresholdProfile wired, MARKET_THRESHOLDS_V2 default true | 3ea9f2f |

---

## What Was Built

### WI-0561: Next.js Security Patch

- Bumped `next` from `^16.1.6` to exact `16.2.1` in `web/package.json`
- `npm --prefix web audit --omit=dev` reports **0 vulnerabilities**
- `test:ui:evidence`, `test:transform:market`, and `lint` all pass

### WI-0551: Vig Removal from Implied Probability

Added `noVigImplied(priceHome, priceAway)` to `packages/models/src/edge-calculator.js`:

```js
function noVigImplied(priceHome, priceAway) {
  const pHome = impliedProbFromAmerican(priceHome);
  const pAway = impliedProbFromAmerican(priceAway);
  if (pHome == null || pAway == null) return null;
  const total = pHome + pAway;
  return { home: pHome / total, away: pAway / total };
}
```

- At -110/-110: returns `{ home: 0.5, away: 0.5 }` (was 0.524/0.524 with raw implied)
- At -150/+130: returns `{ home: 0.5798, away: 0.4202 }` (mathematically verified)
- All three `compute*Edge` functions (moneyline, spread, total) use vig-removed probability when both sides present
- `VIG_REMOVAL_SKIPPED: true` appended to return object when only one price available (silent fallback)
- `noVigImplied` added to `module.exports`

**Test count: 18 tests, 0 failures**

### WI-0555: Unified NBA Spread Gate

In `apps/worker/src/jobs/run_nba_model.js`:
- Removed `const SPREAD_EDGE_MIN = 0.02`
- Added `const { resolveThresholdProfile } = require('@cheddar-logic/models')`
- Replaced hardcoded gate with:
  ```js
  const nbaSpreadProfile = resolveThresholdProfile({ sport: 'NBA', marketType: 'SPREAD' });
  const SPREAD_LEAN_MIN = nbaSpreadProfile.edge.lean_edge_min; // 0.035
  ```

In `packages/models/src/flags.js`:
- `ENABLE_MARKET_THRESHOLDS_V2` now defaults to `true` when env var is absent:
  ```js
  ENABLE_MARKET_THRESHOLDS_V2: process.env.ENABLE_MARKET_THRESHOLDS_V2 !== undefined
    ? isTruthy(process.env.ENABLE_MARKET_THRESHOLDS_V2)
    : true,
  ```

**Effect:** Spread cards at 2.5% edge are now correctly blocked (below 3.5% lean_edge_min). Cards at 4%+ still emit normally.

---

## Test Results

| Suite | Pass | Fail |
|-------|------|------|
| `node packages/models/src/__tests__/edge-calculator.test.js` | 18 | 0 |
| `npm --prefix web run test:card-decision` | all | 0 |
| `npm --prefix web run test:decision:canonical` | 32 | 0 |
| `npm --prefix web run test:ui:evidence` | pass | 0 |
| `npm --prefix web run test:transform:market` | pass | 0 |
| `npm --prefix web audit --omit=dev` | 0 vulns | — |

---

## Verification Checks

- `grep SPREAD_EDGE_MIN apps/worker/src/jobs/run_nba_model.js` → empty (confirmed)
- `grep ENABLE_MARKET_THRESHOLDS_V2 packages/models/src/flags.js` → shows ternary default true (confirmed)
- `noVigImplied(-110, -110)` → `{ home: 0.5, away: 0.5 }` (confirmed)
- `next` in `web/package.json` → `16.2.1` (confirmed)
- Zero audit advisories (confirmed)

---

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test fixture needed `reasoning` field and correct `cardType` field access**
- **Found during:** Task 3 RED phase
- **Issue:** `buildMarketCallCard` was returning a null-push because `spreadDecision.reasoning` was undefined in test fixture, and test checked `card_type` instead of `cardType`
- **Fix:** Added `reasoning: 'test reasoning'` to test fixture and corrected field access to `c.cardType`
- **Files modified:** `packages/models/src/__tests__/edge-calculator.test.js`
- **Commit:** ab30d64

**2. [Rule 3 - Blocking] Relative path to `run_nba_model.js` from `__tests__` directory was wrong**
- **Found during:** Task 3 RED phase
- **Issue:** Used `../../../apps/worker/...` but correct path from `packages/models/src/__tests__/` is `../../../../apps/worker/...`
- **Fix:** Corrected relative path in require
- **Files modified:** `packages/models/src/__tests__/edge-calculator.test.js`
- **Commit:** ab30d64

---

## Work Items Closed

| WI | Status | Moved to COMPLETE |
|----|--------|-------------------|
| WI-0561 | Done | WORK_QUEUE/COMPLETE/WI-0561.md |
| WI-0551 | Done | WORK_QUEUE/COMPLETE/WI-0551.md |
| WI-0555 | Done | WORK_QUEUE/COMPLETE/WI-0555.md |

---

## Self-Check: PASSED

All created files verified on disk. All task commits confirmed in git log.
- FOUND: packages/models/src/__tests__/edge-calculator.test.js
- FOUND: packages/models/src/edge-calculator.js
- FOUND: WORK_QUEUE/COMPLETE/WI-0551.md
- FOUND: WORK_QUEUE/COMPLETE/WI-0555.md
- FOUND: WORK_QUEUE/COMPLETE/WI-0561.md
- FOUND commit: 67f0cb9 (Next.js upgrade)
- FOUND commit: abb6a92 (noVigImplied GREEN)
- FOUND commit: 3ea9f2f (WI-0555 GREEN + WI closeout)
