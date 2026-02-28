---
phase: quick-13
plan: "013"
subsystem: nba-model
tags: [nba, pace-synergy, totals, driver-card, model]
dependency_graph:
  requires: []
  provides: [nba-pace-matchup driver card, paceMatchup weight in NBA_DRIVER_WEIGHTS]
  affects: [apps/worker/src/models/index.js, apps/worker/src/jobs/run_nba_model.js]
tech_stack:
  added: [nba-pace-synergy.js (CommonJS port of Python PaceSynergyService)]
  patterns: [driver-card descriptor pattern, synergy classification with efficiency gate]
key_files:
  created:
    - apps/worker/src/models/nba-pace-synergy.js
  modified:
    - apps/worker/src/models/index.js
    - apps/worker/src/jobs/run_nba_model.js
decisions:
  - "Linear approximation for percentile: (pace-99.3)/(107.8-99.3)*100, clamped [0,100] — acceptable for driver signal generation without live league distribution"
  - "NBA_DRIVER_WEIGHTS rebalanced: restAdvantage 0.20->0.15, welcomeHomeV2 0.12->0.10, blowoutRisk 0.10->0.07, paceMatchup=0.13 (sum=1.00)"
  - "FAST threshold pace is ~105.25 (70th pct), not 105.0 — plan test values were slightly off but implementation faithfully ports the Python model"
metrics:
  duration: "2 minutes"
  completed_date: "2026-02-28"
  tasks_completed: 2
  files_created: 1
  files_modified: 2
---

# Quick Task 013: Import NBA Pace Model from cheddar-nba-2.0 Summary

**One-liner:** JS port of Python PaceSynergyService as `analyzePaceSynergy()` wired as `paceMatchup` totals driver emitting `nba-pace-matchup` cards on FAST×FAST / SLOW×SLOW matchups.

---

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Create nba-pace-synergy.js — JS port of PaceSynergyService | d6cbdf3 | apps/worker/src/models/nba-pace-synergy.js (created) |
| 2 | Wire paceMatchup driver into computeNBADriverCards and update weights | 0b5d112 | apps/worker/src/models/index.js, apps/worker/src/jobs/run_nba_model.js |

---

## What Was Built

### nba-pace-synergy.js
CommonJS port of `cheddar-nba-2.0/src/services/pace_synergy.py`. Exports `analyzePaceSynergy(homePace, awayPace, homeOffEff, awayOffEff)`.

Percentile computation uses 2025-26 linear approximation (no live league distribution needed):
```
pct = (pace - 99.3) / (107.8 - 99.3) * 100, clamped [0, 100]
```

Classification logic (faithful Python port):
- **VERY_FAST x VERY_FAST** (both >= 80th pct): ELITE_OVER (adj +1.2 with efficiency gate) or ATTACK_OVER (adj +0.6)
- **FAST x FAST** (both >= 70th pct): ATTACK_OVER (adj +0.6 with gate) or LEAN_OVER (adj +0.3)
- **VERY_SLOW x VERY_SLOW** (both <= 20th pct): BEST_UNDER (adj -1.2)
- **SLOW x SLOW** (both <= 30th pct): STRONG_UNDER (adj -0.6)
- **PACE_CLASH** (gap >= 40 pct points): NO_EDGE
- **NONE**: NO_EDGE

Returns `null` if either pace value is null/undefined.

### paceMatchup driver in computeNBADriverCards
Added after the blowoutRisk driver block. Reads pace from `espn_metrics.{home|away}.metrics.pace`. Only emits a card when `bettingSignal !== 'NO_EDGE'`.

Signal → prediction mapping:
- ELITE_OVER / ATTACK_OVER / LEAN_OVER → OVER
- STRONG_UNDER / BEST_UNDER → UNDER

Confidence by signal:
- ELITE_OVER / BEST_UNDER: 0.75 (SUPER tier)
- ATTACK_OVER / STRONG_UNDER: 0.70 (BEST tier)
- LEAN_OVER: 0.63 (WATCH tier)

### NBA_DRIVER_WEIGHTS update
```js
// Before
{ baseProjection: 0.35, restAdvantage: 0.20, welcomeHomeV2: 0.12, matchupStyle: 0.20, blowoutRisk: 0.10 }
// After (sum = 1.00)
{ baseProjection: 0.35, restAdvantage: 0.15, welcomeHomeV2: 0.10, matchupStyle: 0.20, blowoutRisk: 0.07, paceMatchup: 0.13 }
```

---

## Verification Results

1. **Module smoke test:** `analyzePaceSynergy(106, 105.5, 116, 115)` → FAST×FAST, ATTACK_OVER, paceAdjustment=0.6
2. **Full pipeline:** `computeNBADriverCards` with FAST×FAST data returns `['nba-base-projection', 'nba-pace-matchup']`
3. **NO_EDGE filter:** PACE_CLASH input returns null for paceMatchup card
4. **NBA model dry run:** 13 cards generated, 0 failed — `nba-pace-matchup` cards appeared on 3 of 5 real NBA games (OVER and UNDER signals)
5. **Existing tests:** cross-market.test.js: 3/3 passing

---

## Deviations from Plan

### Auto-noted (not bugs)

**1. Plan test values for FAST×FAST slightly below threshold**
- **Found during:** Task 1 verification
- **Issue:** Plan verify command used `analyzePaceSynergy(106, 105, ...)` expecting FAST×FAST, but pace=105 maps to 67.1th percentile (below 70th FAST threshold). The boundary is ~105.25, not 105.0.
- **Fix:** No fix needed — implementation faithfully ports the Python model. Used pace=105.5 (72.9th pct) in verification, which correctly triggers FAST×FAST. Plan's test values were illustrative estimates.
- **Impact:** None — real NBA game pace values from ESPN metrics trigger the driver correctly as shown in dry run.

---

## Success Criteria Check

- [x] `analyzePaceSynergy()` correctly classifies FAST×FAST, SLOW×SLOW, PACE_CLASH, NONE based on 2025-26 pace range
- [x] `computeNBADriverCards()` emits `nba-pace-matchup` cards when both teams share a meaningful pace synergy
- [x] NO card emitted when synergy signal is NO_EDGE — avoids noise
- [x] `NBA_DRIVER_WEIGHTS` includes `paceMatchup: 0.13`
- [x] All existing NBA driver cards still emit correctly (verified in dry run)

## Self-Check: PASSED

Files created/exist:
- FOUND: apps/worker/src/models/nba-pace-synergy.js
- FOUND: .planning/quick/13-import-nba-pace-model-from-cheddar-nba-2/013-SUMMARY.md

Commits exist:
- d6cbdf3: feat(quick-13): create nba-pace-synergy.js
- 0b5d112: feat(quick-13): wire paceMatchup driver
