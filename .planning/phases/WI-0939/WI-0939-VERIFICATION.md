---
phase: WI-0939
verified: 2026-04-14T22:35:00Z
status: passed
score: 5/5 must-haves verified
---

# WI-0939: Restore MLB Full-Game Surfaces Verification Report

**Phase Goal:** Fix audited MLB non-surfacing market gaps by restoring full-game total emission, improving full-game moneyline surfacing reliability, and removing legacy or redundant decision paths.

**Verified:** 2026-04-14T22:35:00Z  
**Status:** ✅ PASSED

## Goal Achievement Summary

✅ **MLB full-game totals emit when full-game total odds exist**  
Verified: `generateMLBMarketCallCards()` checks `full_game_line` and constructs `mlb-full-game` card type

✅ **Full-game total field contract mismatch removed**  
Verified: Single canonical key path from worker `full_game_line` hydration to model `full_game_total` consumption (commit 9544e7a4)

✅ **End-to-end test proves emission path**  
Verified: `run_mlb_model.test.js` includes fixture with full-game total odds that produces `mlb-full-game` cards

✅ **MLB full-game ML no silent drops**  
Verified: Each rejected candidate recorded with explicit reason codes; `check_pipeline_health.js` includes MLB diagnostics

✅ **tech-debt closeout objective and complete**  
Verified:
- TD-01: Canonical key contract test added and passing
- TD-02: Legacy selector-era helpers removed; rg proof recorded
- TD-03: Parity assertions prove persisted terminal status consistency
- TD-04: Health diagnostics include per-market reason-family buckets
- TD-05: All MLB-relevant documentation updated

## Test Results

```
apps/worker/src/jobs/__tests__/run_mlb_model.test.js: ✅ PASS (17/17 tests)
docs/audits/mlb-market-surface-audit.md: ✅ Created with TD closeout proof
```

## Artifacts Verified

| Artifact | Status | Evidence |
| -------- | ------ | -------- |
| `apps/worker/src/jobs/run_mlb_model.js` (full-game-total emission) | ✅ Works | Generates mlb-full-game when full_game_line exists |
| `apps/worker/src/models/mlb-model.js` (full-game-total logic) | ✅ Works | Surfaces total when pricing available |
| `apps/worker/src/jobs/check_pipeline_health.js` (diagnostics) | ✅ Works | MLB diagnostics include reason-family counts |
| `docs/audits/mlb-market-surface-audit.md` (audit doc) | ✅ Created | TD-01 through TD-05 closeout with rg proofs |

---

_Verified: 2026-04-14T22:35:00Z_  
_Verifier: Claude (gsd-verifier)_
