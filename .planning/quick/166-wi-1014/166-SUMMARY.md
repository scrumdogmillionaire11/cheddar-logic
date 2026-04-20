---
phase: 166-wi-1014
plan: "01"
subsystem: game-card
tags: [dead-code, deletion, build-health]
dependency_graph:
  requires: []
  provides: [WI-1014]
  affects: []
tech_stack:
  added: []
  patterns: []
key_files:
  created: []
  modified: []
  deleted:
    - web/src/lib/game-card/canonical-decision.ts
decisions:
  - "Delete canonical-decision.ts (deletion path): file had zero importers and computeCanonicalDecision was semantically different from the inline decision logic in transform/index.ts"
metrics:
  duration: "~5 minutes"
  completed: "2026-04-20"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 1
---

# Phase 166 Plan 01: WI-1014 — Delete orphaned canonical-decision.ts Summary

**One-liner:** Deleted zero-importer orphan `canonical-decision.ts`; build confirmed green with TypeScript clean compile.

## Decision Taken: Deletion Path

WI-1014 offered two resolutions: wire `computeCanonicalDecision` into the pipeline, or delete the file as dead code. The deletion path was taken.

**Reason:** `grep -r "canonical-decision" web/src/` returned zero matches before deletion. The file was imported by nobody. Additionally, `computeCanonicalDecision` used only `tier`, `confidence`, and `valueStatus` as signals — a far simpler model than the inline decision block in `transform/index.ts` (L2400–2730), which applies edge-percentage gating (<1% → PASS), driver scoring, longshot guards (+400 odds), coinflip detection, gate codes, canonical NHL totals overrides, and worker-stored action precedence. Wiring would require a separate behavioral regression audit and a new architectural WI.

## Tasks Completed

| Task | Name | Commit | Notes |
|------|------|--------|-------|
| 1 | Verify zero importers and delete canonical-decision.ts | d506ce23 | grep confirmed zero matches; file deleted; 283 lines removed |
| 2 | Confirm build passes | (no commit needed) | `npm --prefix web run build` exits 0; TypeScript clean; 38 pages generated |

## Files Deleted

- `web/src/lib/game-card/canonical-decision.ts` — 283-line orphaned module exporting `computeCanonicalDecision`. No callers anywhere in `web/src/`.

## Build Status

Green. `npm --prefix web run build` compiled successfully in 2.9s, TypeScript finished in 4.8s with no errors, all 38 static pages generated.

## Tests Run

Build only. No test file was needed — the deletion removes the export entirely and the build serves as the integration test (TypeScript would fail on any missed import).

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- `web/src/lib/game-card/canonical-decision.ts` does not exist: CONFIRMED
- `grep -r "canonical-decision" web/src/` returns nothing: CONFIRMED
- `npm --prefix web run build` exits 0: CONFIRMED
- Commit d506ce23 exists: CONFIRMED
