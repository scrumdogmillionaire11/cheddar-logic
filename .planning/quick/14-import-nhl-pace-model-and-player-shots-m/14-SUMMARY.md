---
phase: quick-14
plan: 014
subsystem: nhl-model
tags: [nhl, pace-model, totals, player-shots, driver-cards]
dependency_graph:
  requires:
    - apps/worker/src/models/index.js (computeNHLDriverCards)
    - apps/worker/src/jobs/run_nhl_model.js (NHL_DRIVER_WEIGHTS)
  provides:
    - nhl-pace-model.js (predictNHLGame)
    - nhl-player-shots.js (calcMu, calcMu1p, classifyEdge)
    - nhl-pace-totals driver card
    - nhl-pace-1p driver card
  affects:
    - /cards page (new NHL totals driver cards appear)
    - NHL_DRIVER_WEIGHTS (goalie/scoringEnvironment weights reduced to add paceTotals)
tech_stack:
  added: []
  patterns:
    - JS port of Python prediction model (direct algorithm translation)
    - Stateless function per-model (no class instantiation)
    - Driver card descriptor pattern (matches existing NHL driver shape)
key_files:
  created:
    - apps/worker/src/models/nhl-pace-model.js
    - apps/worker/src/models/nhl-player-shots.js
  modified:
    - apps/worker/src/models/index.js
    - apps/worker/src/jobs/run_nhl_model.js
decisions:
  - "Port only core prediction logic — no Poisson distribution, no bias correction, no calendar context (those require DB state cheddar-logic doesn't have)"
  - "classifyEdge() uses raw SOG delta vs market line (not model probability pp) since we have no market odds for player props in driver pipeline"
  - "nhl-player-shots.js is not wired into driver pipeline (per plan: future player card use); only nhl-pace-model.js is wired today"
  - "Goalie confirmed = GSaX data present (goalieHomeGsax !== null) — consistent with existing NHL driver pattern"
metrics:
  duration: "6 minutes"
  completed_date: "2026-02-28"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 2
---

# Quick Task 14: NHL Pace Model and Player Shots — Summary

**One-liner:** JS port of TotalsPredictor (Poisson-based goal projection with pace dampening, defensive crossover, goalie adjustment) and mu.py (L5 recency-weighted SOG with home boost and regression) as new NHL driver cards nhl-pace-totals and nhl-pace-1p.

---

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create nhl-pace-model.js and nhl-player-shots.js | 33e8dea | apps/worker/src/models/nhl-pace-model.js, apps/worker/src/models/nhl-player-shots.js |
| 2 | Wire nhl-pace-totals and nhl-pace-1p drivers into computeNHLDriverCards and update weights | 6ad319b | apps/worker/src/models/index.js, apps/worker/src/jobs/run_nhl_model.js |

---

## What Was Built

### nhl-pace-model.js

Stateless `predictNHLGame(opts)` function — a direct JS port of `TotalsPredictor.predict_game()` from `cheddar-nhl/src/nhl_sog/engine/totals_predictor.py`.

Prediction pipeline (in order):
1. L5 recency blend of offensive/defensive ratings (30% L5 + 70% season when L5 > 0.5)
2. Combined pace factor (dampened multiplicative: 1 + (raw-1) * 0.5)
3. Defensive crossover adjustment (opponent's GA/game vs league avg, dampened 0.5)
4. PP/PK matchup edge (when all 4 values present)
5. Home ice advantage (1.03x — calibrated from cheddar-nhl ModelConfig)
6. B2B penalty (0.95x)
7. Extended rest boost 3+ days (1.02x)
8. Goalie save-pct adjustment (goalie affects opponent's goals, clamped [0.75, 1.25])
9. 1P total = full game * 0.30

Confidence: 0.60 base + 0.05 (both goalies confirmed) + 0.05 (PP/PK present) + 0.03 (L5 blended), clamped [0.55, 0.80].

Returns null when base offensive data (goalsFor) is unavailable.

### nhl-player-shots.js

Three exported functions ported from cheddar-nhl mu.py and edge.py:

- `calcMu(inputs)`: Recency-weighted L5 SOG mean with optional prior blend (shotsPer60 * projToi / 60), opponent/pace factors, home boost (+5%), high-volume regression (>4.5 SOG: -10%).
- `calcMu1p(inputs)`: 1P SOG = calcMu * 0.32 * 1.00, adjusting home boost from full-game (1.05) to 1P-specific (1.03).
- `classifyEdge(mu, marketLine, confidence)`: HOT if |edge| >= 0.8 and confidence >= 0.50; WATCH if |edge| >= 0.5; COLD otherwise.

Note: nhl-player-shots.js is not wired into the driver pipeline in this task (plan spec: "future player card use"). It is exported for standalone use.

### computeNHLDriverCards() extension (index.js)

New `nhl-pace-totals` driver block added after the Scoring Environment driver:

- Calls `predictNHLGame()` with ESPN metrics and goalie data from raw_data
- Emits `nhl-pace-totals` card when `|expectedTotal - marketTotal| >= 0.4` (noise threshold)
- Confidence scaled by edge magnitude: +0.10 for >= 1.5 goal edge, +0.05 for >= 1.0, ±0 for >= 0.6, -0.05 for < 0.6
- Emits `nhl-pace-1p` card when `total_1p` market data is present and `|expected1pTotal - market1pTotal| >= 0.2`

### NHL_DRIVER_WEIGHTS (run_nhl_model.js)

Rebalanced to include pace totals driver:
```
Before: { baseProjection: 0.30, restAdvantage: 0.14, goalie: 0.22, scoringEnvironment: 0.12 }  // sum = 0.78
After:  { baseProjection: 0.30, restAdvantage: 0.14, goalie: 0.18, scoringEnvironment: 0.08, paceTotals: 0.12, paceTotals1p: 0.08 }  // sum = 0.90
```

---

## Verification Results

All success criteria met:

- `predictNHLGame({ homeGoalsFor: 3.2, awayGoalsFor: 2.8, ... })` returns `expectedTotal: 5.778`, `expected1pTotal: 1.733`, `confidence: 0.65`
- `predictNHLGame({ homeGoalsFor: null, ... })` returns `null`
- `calcMu({ l5Sog: [4,3,3,2,4], isHome: true })` returns `mu: 3.526`
- `classifyEdge(3.526, 2.5, 0.55)` returns `{ tier: 'HOT', direction: 'OVER', edge: 1.03 }`
- `computeNHLDriverCards()` with total=5.0 includes `nhl-pace-totals` card (edge: +0.78, OVER)
- `computeNHLDriverCards()` with total=6.5 includes `nhl-pace-totals` card (edge: -0.72, UNDER)
- Existing NHL drivers (nhl-base-projection, nhl-model-output, nhl-rest-advantage) still emit correctly
- 3/3 cross-market tests pass
- NHL model job processes 16 games, 22 cards generated, 0 failed

---

## Deviations from Plan

None — plan executed exactly as written.

---

## Self-Check: PASSED

**Files created:**
- FOUND: apps/worker/src/models/nhl-pace-model.js
- FOUND: apps/worker/src/models/nhl-player-shots.js

**Commits verified:**
- FOUND: 33e8dea feat(quick-14): add nhl-pace-model.js and nhl-player-shots.js
- FOUND: 6ad319b feat(quick-14): wire nhl-pace-totals and nhl-pace-1p drivers into NHL model pipeline
