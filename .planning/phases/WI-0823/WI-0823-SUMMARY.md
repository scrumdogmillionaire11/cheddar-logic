---
phase: WI-0823-nhl-goalie-composite
plan: WI-0823
type: phase-summary
subsystem: nhl-model
tags: [nhl, goalie, composite, gsax, save-pct, wi-0823]
dependency_graph:
  requires: [WI-0820 input gate]
  provides: [resolveGoalieComposite, unified goalie signal]
  affects: [nhl-pace-model.js, cross-market.js, WI-0830 additive z-score model]
tech_stack:
  added: []
  patterns: [composite-signal, source-routing, factor-clamping]
key_files:
  created:
    - apps/worker/src/models/__tests__/nhl-pace-model.test.js (resolveGoalieComposite block)
  modified:
    - apps/worker/src/models/nhl-pace-model.js
    - apps/worker/src/models/cross-market.js
decisions:
  - "Unified GSaX and SV% into single composite via resolveGoalieComposite — eliminates double-counting when both signals are present."
  - "Source routing FULL/GSAX_ONLY/SV_PCT_ONLY/NEUTRAL provides transparency into which signal drove the adjustment."
  - "Factor clamped to [0.88, 1.12] — same range as legacy; composite does not increase total modifier magnitude vs pre-WI-0823."
  - "applyGoalieAdj updated to accept gsax param and delegate to resolveGoalieComposite internally."
  - "cross-market.js goalieSignal derives from composite, not raw goalieSum — eliminates previous additive double-count."
metrics:
  duration: "< 1 day"
  completed: "2026-04-09"
  implementation_commit: "77b726e"
  verification_task: "quick task 142"
---

# WI-0823 Phase Summary: NHL Unified Goalie Signal

**One-liner:** Consolidated GSaX and SV% goalie signals into `resolveGoalieComposite` with FULL/GSAX_ONLY/SV_PCT_ONLY/NEUTRAL source routing — eliminates double-counting and provides transparent signal provenance.

## What Was Built

WI-0823 replaced the previous additive double-count of goalieSum (GSaX + SV%) in cross-market.js with a unified composite:

1. **`resolveGoalieComposite(savePct, gsax)`** exported from `nhl-pace-model.js`
   - Returns `{ factor, composite, source }` where source is one of FULL / GSAX_ONLY / SV_PCT_ONLY / NEUTRAL
   - Factor clamped to [0.88, 1.12]
   - When both inputs present (FULL), blends them without double-counting
   - When only one input is present, uses that signal alone (graceful degradation)
   - When neither present, returns neutral factor 1.0

2. **`applyGoalieAdj`** updated to accept gsax param and use resolveGoalieComposite internally.

3. **`cross-market.js`** goalieSignal now derives from composite (not raw goalieSum).

## Verification

Quick task 142 ran the full NHL test suite (89 tests, 6 suites) and confirmed:
- 4/4 resolveGoalieComposite unit tests pass
- Zero regressions in nhl-pace-model, cross-market, nhl-pace-calibration
- Implementation at commit 77b726e is correct

## Deviations from Plan

None.

## Self-Check: PASSED

Implementation commit 77b726e confirmed via test suite in quick task 142.
