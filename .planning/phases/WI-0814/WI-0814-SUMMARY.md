---
phase: WI-0814
plan: WI-0814
subsystem: decision-pipeline
tags: [sigma, safety-gate, decision-pipeline-v2, PLAY, LEAN, model-integrity]
requires: [WI-0835]
provides: [sigma-fallback-safety-gate]
affects: [WI-0839, sprint-3-observability]
tech-stack:
  added: []
  patterns: [status-cap-gate, reason-code-annotation]
key-files:
  created:
    - packages/models/src/__tests__/decision-pipeline-v2-sigma-fallback-gate.test.js
  modified:
    - packages/models/src/decision-pipeline-v2-edge-config.js
    - packages/models/src/decision-pipeline-v2.js
    - apps/worker/src/jobs/run_nba_model.js
    - apps/worker/src/jobs/run_nhl_model.js
    - apps/worker/src/jobs/run_mlb_model.js
decisions:
  - "Gate applied in computeOfficialStatus (not via threshold mutation): direct status cap PLAY→LEAN when sigmaSource='fallback'. Threshold mutation approach was reversed because lean_edge_min < play_edge_min; raising play_edge_min to lean_edge_min would have lowered the bar, not raised it."
  - "jobSigmaSource derived from context.sigmaOverride (explicit override only); null when no override → gate inactive by default. Prevents false triggering for payloads that use model_prob directly."
  - "SIGMA_FALLBACK_DEGRADED injected only when card would have been PLAY without the gate (edge_pct >= original play_edge_min AND support_score >= play support threshold). Pure LEAN cards are not annotated."
  - "NHL nhlBaseSigma now includes sigma_source so it flows through effectiveSigma into sigmaOverride. NBA computedSigma already had sigma_source. MLB does not use buildDecisionV2 (prop model path); warn only."
metrics:
  duration: ~25min
  completed: 2026-04-08
---

# WI-0814 Summary: Sigma fallback safety gate — PLAY→LEAN when sigma_source=fallback

**One-liner:** PLAY-to-LEAN safety cap in `computeOfficialStatus` when `sigmaOverride.sigma_source='fallback'`; emits `SIGMA_FALLBACK_DEGRADED` reason code and `[SIGMA_FALLBACK]` warn at model startup.

## Objective Completed

Prevent false PLAY classifications at season start or after a DB reset. When `computeSigmaFromHistory` returns `sigma_source='fallback'` (fewer than 20 settled games), every PLAY-tier card is downgraded to LEAN. The gate automatically releases once empirical sigma is computed.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | `resolveThresholdProfile` accepts `sigmaSource`; annotates `profile.meta` with `sigma_degraded: true` and `original_play_edge_min` | 0da3767 |
| 2 | Thread `jobSigmaSource` through `buildDecisionV2`; pass to `computeOfficialStatus` and `getThresholdProfile` | a71e8bd |
| 3 | `computeOfficialStatus`: cap status at `LEAN` when `sigmaSource='fallback'`; inject `SIGMA_FALLBACK_DEGRADED` into `price_reason_codes` | a71e8bd |
| 4 | Model runner `[SIGMA_FALLBACK]` startup warn in NBA/NHL/MLB; thread `sigma_source` into NHL `nhlBaseSigma` | 3011f4c |
| 5 | 11 new unit + integration tests in `decision-pipeline-v2-sigma-fallback-gate.test.js` | 178db1b |

## Verification

- edge-config unit tests: `resolveThresholdProfile` behaves correctly for fallback/computed/null
- Integration tests (11 new + 36 existing): `buildDecisionV2` PLAY→LEAN downgrade confirmed; SIGMA_FALLBACK_DEGRADED presence confirmed; no regression on computed/no-override paths
- Full models suite: 50/50 pass (2 pre-existing unrelated failures in sharp-divergence-annotation and edge-calculator)

## Deviations from Plan

**1. [Rule 1 - Bug] Wrong threshold direction in resolveThresholdProfile**

- **Found during:** Task 1 implementation
- **Issue:** Original plan set `play_edge_min = lean_edge_min` (lowering play_edge_min, which would make PLAY _easier_, not harder)
- **Fix:** Moved the gate to `computeOfficialStatus` as a direct status cap (`if sigmaSource === 'fallback') return 'LEAN'`). `resolveThresholdProfile` only annotates `profile.meta` (does not change thresholds).
- **Files modified:** `decision-pipeline-v2-edge-config.js`, `decision-pipeline-v2.js`
- **Commit:** a71e8bd

**2. [Rule 2 - Missing Critical] NHL sigma_source not propagated**

- **Found during:** Task 4
- **Issue:** `run_nhl_model.js` builds `nhlBaseSigma = { margin, total }` without `sigma_source`, so `effectiveSigma` passed to `publishDecisionForCard` options would always resolve to `sigma_source='fallback'` in the pipeline even after calibration.
- **Fix:** Added `nhlBaseSigma = { ...nhlBaseSigma, sigma_source: _sigmaSource }` after the sigma calibration block.
- **Files modified:** `apps/worker/src/jobs/run_nhl_model.js`
- **Commit:** 3011f4c

## Next Phase Readiness

- WI-0839 (NHL 1P sigma static gate) can now build on the same `sigmaSource` pattern established here.
- Both the `SIGMA_FALLBACK_DEGRADED` reason code and `[SIGMA_FALLBACK]` log tag are observable for Sprint 3 monitoring work.
