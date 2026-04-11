---
phase: quick-151
plan: 01
subsystem: potd-engine
tags: [potd, kelly, confidence, wager-sizing, migration]
dependency_graph:
  requires: [WI-0819]
  provides: [confidence-weighted-wager-sizing]
  affects: [potd_plays, card_payloads]
tech_stack:
  added: []
  patterns: [multiplier-after-kelly-cap, tdd-red-green]
key_files:
  created:
    - packages/data/db/migrations/074_add_confidence_multiplier_to_potd_plays.sql
  modified:
    - apps/worker/src/jobs/potd/signal-engine.js
    - apps/worker/src/jobs/potd/run_potd_engine.js
    - apps/worker/src/jobs/potd/__tests__/signal-engine.test.js
    - apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js
decisions:
  - "confidence_multiplier applied after kellySize (cap enforced inside kellySize before multiplier)"
  - "Unknown/undefined label defaults to HIGH multiplier (0.85) — safe fallback"
  - "Updated existing wager_amount test expectation (2.5→2.0) to match correct HIGH-multiplier behavior"
metrics:
  duration: "~12 minutes"
  completed: "2026-04-11"
  tasks_completed: 2
  files_changed: 5
---

# Phase quick-151 Plan 01: POTD Confidence-Weighted Sizing Summary

**One-liner:** Confidence-weighted Kelly stake scaling — ELITE/HIGH/MEDIUM/LOW multipliers applied post-cap using a lookup map in signal-engine with migration 074 for persistence.

## Tasks Completed

| # | Task | Commit | Status |
|---|------|--------|--------|
| 1 | Add confidenceMultiplier to signal-engine, wire into run_potd_engine | 6aa590f | Done |
| 2 | Migration 074 — add confidence_multiplier column to potd_plays | 0db8488 | Done |

## What Was Built

**signal-engine.js:**
- `confidenceMultiplier(label)` function: `{ ELITE: 1.0, HIGH: 0.85, MEDIUM: 0.65, LOW: 0.40 }[label] ?? 0.85`
- Exported in `module.exports`

**run_potd_engine.js:**
- Destructures `confidenceMultiplier` from `./signal-engine`
- Replaces single rounding line with: `adjustedWager = Math.round(rawWager * confidenceMultiplier(bestCandidate.confidenceLabel) * 100) / 100`
- `wagerAmount = Math.round(adjustedWager * 2) / 2` (nearest $0.50)
- `buildPotdPlayRow` now accepts and writes `confidence_multiplier` field
- `buildCardPayloadData` now accepts and writes `confidence_multiplier` field
- `buildPotdCard` passes `row.confidence_multiplier` through to `buildCardPayloadData`
- INSERT SQL updated to include `confidence_multiplier` column

**Migration 074:**
- `ALTER TABLE potd_plays ADD COLUMN confidence_multiplier REAL;`
- Nullable — pre-existing rows stay NULL with no back-fill needed

## Test Results

All 30 tests pass:
- 3 new `confidenceMultiplier` tests in signal-engine.test.js
- 1 new confidence-weighted wager sizing test in run-potd-engine.test.js
- 26 pre-existing tests all continue to pass

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated pre-existing wager_amount test expectation**
- **Found during:** Task 1 GREEN phase
- **Issue:** The existing test `seeds bankroll and writes published TOTAL play` expected `wager_amount: 2.5` (raw Kelly output). With the multiplier applied, `2.5 * 0.85 (HIGH) = 2.125` → rounds to `$2.00`. The test expectation was stale relative to the new behavior.
- **Fix:** Updated test comment and expectation to `wager_amount: 2.0` with explanatory comment documenting the math.
- **Files modified:** `apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js`
- **Commit:** 6aa590f (included in Task 1 commit)

## Self-Check: PASSED

- signal-engine.js: FOUND
- migration 074: FOUND
- 151-SUMMARY.md: FOUND
- Commit 6aa590f: FOUND
- Commit 0db8488: FOUND
