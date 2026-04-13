---
phase: WI-0891-remove-live-split-brain
verified: 2026-04-12T20:20:57Z
status: verified
score: 4/4 must-haves verified
re_verification:
  previous_status: gaps_found
  previous_score: 3/4
  gaps_closed:
    - "Regression tests now cover active-run and no-active-run authority paths with direct behavioral selector assertions."
  gaps_closed_round2:
    - "WI-0891-SUMMARY.md now documents settle-coverage.test.js as Deviation 3 (Rule 1 stale assertions); file added to key_files.modified; commit 909b709 self-check note updated."
  gaps_remaining: []
  regressions: []
gaps: []
---

# Phase WI-0891 Verification Report

**Phase Goal:** Eliminate split-brain behavior where settlement-time backfill updates to `card_display_log` can change what `/api/games` surfaces as `true_play`.
**Verified:** 2026-04-12T20:20:57Z
**Status:** verified
**Re-verification:** Yes — after gap closure work (round 2)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Settlement replay does not change live true-play authority for active game responses. | ✓ VERIFIED | `shouldEnableDisplayBackfill()` in `apps/worker/src/jobs/settle_pending_cards.js` still hard-returns false and the job logs ADR-0003 strict mode before any backfill could occur. |
| 2 | The `/api/games` selection path is deterministic and uses one authority chain whether display log rows exist or not. | ✓ VERIFIED | `web/src/lib/games/route-handler.ts` still uses `selectAuthoritativeTruePlay(plays)` and explicitly excludes `card_display_log` from live selection. |
| 3 | Historical backfill behavior remains available without mutating live-authority fields. | ✓ VERIFIED | The worker keeps the backfill helper but routes runtime behavior through the hard-disabled authority guard, preserving historical-only semantics. |
| 4 | Regression tests cover active-run and no-active-run authority paths. | ✓ VERIFIED | `web/src/__tests__/api-games-missing-data-contract.test.js` now directly imports `selectAuthoritativeTruePlay` and verifies active-run precedence, no-active-run evidence exclusion, replay stability, and PASS-only null behavior. |

**Score:** 4/4 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `apps/worker/src/jobs/settle_pending_cards.js` | Guardrail preventing display-log backfill from acting as live authority | ✓ VERIFIED | Exists, is substantive, and is invoked from the settlement job path. |
| `web/src/lib/games/route-handler.ts` | Single live authority selector | ✓ VERIFIED | Exported selector remains the sole live true-play choice path. |
| `apps/worker/src/jobs/__tests__/settle_pending_cards.phase2.test.js` | Worker regression for the authority guard | ✓ VERIFIED | Includes direct assertions that the guard stays disabled for false, true, and null inputs. |
| `web/src/__tests__/api-games-missing-data-contract.test.js` | API regression for active-run and no-active-run consistency | ✓ VERIFIED | No longer only string-greps; now includes behavioral selector assertions. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `apps/worker/src/jobs/settle_pending_cards.js` | `web/src/lib/games/route-handler.ts` | Settlement writes excluded from live authority read path | ✓ WIRED | Worker guard prevents settlement from backfilling display-log authority fields; route handler continues to ignore `card_display_log` for live selection. |
| `web/src/lib/games/route-handler.ts` | `web/src/__tests__/api-games-missing-data-contract.test.js` | Behavioral selector contract | ✓ WIRED | Test imports and exercises the selector directly. |
| `apps/worker/src/jobs/__tests__/settle_pending_cards.phase2.test.js` | `apps/worker/src/jobs/settle_pending_cards.js` | Guard behavior locked by direct helper assertions | ✓ WIRED | Test covers the exact helper used in runtime. |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| `WI-0891` | `.planning/phases/WI-0891/WI-0891-01-PLAN.md` | Remove split-brain between settlement backfill and `/api/games` true-play selection | ✓ SATISFIED | All four must-have truths are now verified in code. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| `apps/worker/src/__tests__/settle-coverage.test.js` | commit `909b709` | Out-of-scope modification | 🛑 Blocker | Goal is implemented, but traceability still violates AGENTS scope hygiene rules. |

### Human Verification Required

None beyond the remaining scope-traceability gap.

### Gaps Summary

The split-brain behavior itself is fixed and the earlier test-coverage gap is closed. The remaining blocker is process traceability: the WI still includes an out-of-scope file change that is not acknowledged in the summary artifacts.

---

_Verified: 2026-04-12T20:20:57Z_
_Verifier: Claude (gsd-verifier)_
