---
phase: WI-0822
plan: WI-0822
subsystem: nba-model
tags: [nba, pace, projection, cross-market, normalization]
requires: [WI-0820]
provides: [pace-normalized-nba-projection, canonical-cross-market-decisions]
affects: [WI-0830]

tech-stack:
  added: []
  patterns: [pace-normalization, single-pace-framework]

key-files:
  created:
    - apps/worker/src/models/__tests__/nba-pace-normalization.test.js
  modified:
    - apps/worker/src/models/projections.js
    - apps/worker/src/models/cross-market.js
    - apps/worker/src/models/index.js
    - WORK_QUEUE/COMPLETE/WI-0822.md

decisions:
  - id: D1
    summary: "Normalize using own-team pace for both offense and defense ratings"
    detail: "homeDefRtgNorm = (homeDefRtg / homePace) * 100 (not awayPace). This matches the WI formula exactly: each team's stats normalized by their own pace."
  - id: D2
    summary: "Deprecate projectNBA rather than delete"
    detail: "projectNBA retained with @deprecated JSDoc for nba-base-projection driver card in index.js. WI-0836 will handle rest-day pipeline. Removing it would break the legacy base-projection driver card  used in computeNBADriverCards."
  - id: D3
    summary: "Update index.js NBA total driver to use canonical"
    detail: "nba-total-projection-alignment.test.js explicitly asserts alignment between computeNBADriverCards and computeNBAMarketDecisions. index.js was updated to use projectNBACanonical + analyzePaceSynergy to maintain this invariant. This was Rule 1 (bug) — the alignment test would have broken otherwise."

metrics:
  duration: "~25 min"
  completed: "2026-04-08"
---

# Phase WI-0822 Summary

**One-liner:** Pace-normalized ORtg in `projectNBACanonical` via `offRtg = (avgPoints / teamPace) * 100`; retired dual pace framework by switching `computeNBAMarketDecisions` to canonical + `analyzePaceSynergy`.

## Objective

Fix pace double-counting in NBA PPP model and retire the legacy `projectNBA` bucket-threshold pace classification from `computeNBAMarketDecisions`.

## What Was Done

### Task 1 — projectNBACanonical pace normalization (`projections.js`)

Added per-100-possession normalization before the PPP formula:

```js
const homeOffRtgNorm = homePace > 0 ? (homeOffRtg / homePace) * 100 : homeOffRtg;
const homeDefRtgNorm = homePace > 0 ? (homeDefRtg / homePace) * 100 : homeDefRtg;
const awayOffRtgNorm = awayPace > 0 ? (awayOffRtg / awayPace) * 100 : awayOffRtg;
const awayDefRtgNorm = awayPace > 0 ? (awayDefRtg / awayPace) * 100 : awayDefRtg;

const baseHomePPP = (homeOffRtgNorm + awayDefRtgNorm) / 200;
const baseAwayPPP = (awayOffRtgNorm + homeDefRtgNorm) / 200;
```

Pace is now applied exactly once (via `adjustedPace`). `projectNBA` marked `@deprecated`.

### Task 2 — Retire dual pace framework (`cross-market.js`, `index.js`)

- `cross-market.js`: import changed from `projectNBA` → `projectNBACanonical`
- `computeNBAMarketDecisions`: `analyzePaceSynergy` called **first** (mandatory ordering), its `paceAdjustment` passed as 7th arg to `projectNBACanonical`; synergy object reused for `paceSignalData` (no duplicate call)
- `index.js`: added `projectNBACanonical` + `analyzePaceSynergy` imports; NBA total projection driver switched to canonical to keep `nba-total-projection-alignment` test green

### Task 3 — Unit tests (`nba-pace-normalization.test.js`, 6 tests)

- Fast-paced team: `homeProjected` lower than raw (pace contamination removed)
- Slow-paced team: `homeProjected` higher than raw (per-100 efficiency correctly raised)
- Same avgPoints, different pace → different projections
- Acceptance: total ≤ 240 at max realistic synergy boost (VERY_FAST_BOOST_FULL = 1.2 poss)
- pace=100 identity: normalization ≤ 0.5 pt change
- NO_BET preserved for null pace

## Acceptance Criteria Status

- [x] Fast team (118 pts, 108 poss): `homeOffRtgNorm ≈ 109.3`; `homeProjected` lower
- [x] Slow team (108 pts, 98 poss): `homeOffRtgNorm ≈ 110.2`; `homeProjected` higher
- [x] `computeNBAMarketDecisions` no longer calls `projectNBA` for projected total/margin
- [x] Unit test: same avgPoints different pace → different `homeProjected`, correctly
- [x] `projectNBA` marked `@deprecated`; not deleted
- [x] `cross-market.js` import updated: `projectNBACanonical` imported, `projectNBA` removed
- [x] `analyzePaceSynergy` called **before** `projectNBACanonical`; `paceAdjustment` passed as 7th arg
- [x] Rest-day adjustments intentionally absent from canonical path (deferred WI-0836)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated index.js NBA total driver to stay aligned with cross-market**

- **Found during:** Task 2 — `nba-total-projection-alignment.test.js` would have broken
- **Issue:** `computeNBADriverCards` in `index.js` also builds `nba-total-projection` card using `projectNBA`; alignment test asserts the two functions produce the same `projected_total`
- **Fix:** Added `projectNBACanonical` + `analyzePaceSynergy` imports to index.js; updated NBA total driver card section to use canonical formula
- **Files modified:** `apps/worker/src/models/index.js`
- **Commit:** f45bc6a

## Commits

| Hash | Message |
| --- | --- |
| 6ee9a6b | feat(WI-0822): normalize avgPoints to per-100 ORtg in projectNBACanonical |
| f45bc6a | feat(WI-0822): switch computeNBAMarketDecisions + NBA total driver to projectNBACanonical |
| a747895 | test(WI-0822): add pace normalization unit tests for projectNBACanonical |

## Test Results

```text
Test Suites: 11 passed, 11 total
Tests:       117 passed (111 pre-existing + 6 new), 0 failed
```

## Next Phase Readiness

- WI-0836 (rest-days pipeline): `restDaysHome`/`restDaysAway` remain in `computeNBAMarketDecisions` for the `restGap` driver; `projectNBACanonical` has no rest param (intentional)
- WI-0830 (additive z-score model): `projectNBACanonical` now produces accurate bounded PPP values — safe to build upon

## Human Validation Required

1. **Elite-offense deflation:** Run NBA slate with OKC/ATL (high-pace teams). Compare projected totals before/after — should be 3–8 pts lower for fast teams.
2. **No total > 240:** Confirm no real NBA game produces a canonical total over 240 pts post-fix.
