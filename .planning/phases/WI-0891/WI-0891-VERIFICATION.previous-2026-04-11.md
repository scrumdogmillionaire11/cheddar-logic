---
phase: WI-0891-remove-live-split-brain
verified: 2026-04-11T23:59:00Z
status: gaps_found
score: 3/4 must-haves verified
gaps:
  - truth: "Regression tests cover active-run and no-active-run authority paths"
    status: partial
    reason: "api-games-missing-data-contract.test.js uses structural source-grep assertions, not fixture-based behavioral scenarios. The active-run/no-active-run coverage asserts code shape exists, not that behavior is stable across the two paths."
    artifacts:
      - path: "web/src/__tests__/api-games-missing-data-contract.test.js"
        issue: "All assertions are grep-string checks on route-handler.ts source. No fixture runs with/without active_run_ids to prove behavioral determinism."
    missing:
      - "Add at least one behavioral assertion that exercises selectAuthoritativeTruePlay with and without active run ids present (fixture-level, not source-level)"
  - truth: "Scope hygiene: commit 909b709 includes out-of-scope file"
    status: failed
    reason: "apps/worker/src/__tests__/settle-coverage.test.js is NOT in WI-0891 scope (scope lists settle_pending_cards.phase2.test.js, not settle-coverage.test.js). The change is behavior-correct but violates AGENTS.md scope rules."
    artifacts:
      - path: "apps/worker/src/__tests__/settle-coverage.test.js"
        issue: "Modified in commit 909b709 — test name rename + 4 expectation inversions to match ADR-0003 guard. File is outside WI-0891 declared scope."
    missing:
      - "Acknowledge scope deviation in WI-0891 SUMMARY.md (it is not currently documented)"
      - "Or move the change retroactively to a separate dedicated commit / work item for traceability"
human_verification:
  - test: "Deploy to staging and call /api/games before and after triggering a settlement sweep on the same game"
    expected: "true_play.source_card_id and true_play_authority_source remain stable across both calls"
    why_human: "Structural source assertions cannot prove runtime authority stability under a real concurrent settlement replay"
---

# Phase WI-0891: Verification Report

**Phase Goal:** Remove split-brain behavior where settlement-time backfill updates to card_display_log can change what /api/games surfaces as true_play.

**Verified:** 2026-04-11T23:59:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

---

## Commits Verified

| Hash | Subject | Files Changed |
|------|---------|--------------|
| `8398e4e` | WI-0890: enforce single true-play authority contract | ADR-0003, route-handler.ts, settle_pending_cards.js, game-card-decision-authority.test.ts, WI-0890.md |
| `50299f4` | docs | WI-0908–0912.md (new WIs, unrelated) |
| `2bed099` | feat(WI-0891-01): enforce settlement display-backfill authority guard | settle_pending_cards.js, settle_pending_cards.phase2.test.js |
| `909b709` | test(WI-0891-01): add authority contract assertions | **settle-coverage.test.js** ⚠️ (out of scope), api-games-missing-data-contract.test.js |
| `66df113` | docs(WI-0891-01): complete plan summary and state update | WI-0891-SUMMARY.md, STATE.md |

---

## Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Settlement replay does not change live true_play authority | ✓ VERIFIED | `shouldEnableDisplayBackfill()` hard-returns false; settle-coverage test `allowDisplayBackfill request is ignored under ADR-0003 strict mode` passes and asserts card-p5 stays `pending` after override request |
| 2 | /api/games selection path is deterministic, single authority chain regardless of display-log rows | ✓ VERIFIED | `selectAuthoritativeTruePlay` is the sole true_play selector; `FROM card_display_log` is absent from route-handler live query path; comment `card_display_log remains historical/analytics` is present and asserted |
| 3 | Historical backfill behavior remains available without mutating live-authority fields | ✓ VERIFIED | `backfillDisplayedPlaysFromPayloads` remains in codebase and `__private`; only the `enableDisplayBackfill` gate blocks its execution at runtime |
| 4 | Regression tests cover active-run and no-active-run authority paths | ⚠️ PARTIAL | Tests exist and pass, but assertions are **source-code grep** (structural), not fixture-level behavioral scenarios. Active-run vs no-active-run code path is asserted to exist, not proven stable. |

**Score: 3/4 truths verified**

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/worker/src/jobs/settle_pending_cards.js` | guardrails preventing backfill writes to live-authority fields | ✓ VERIFIED | `shouldEnableDisplayBackfill` at line 1836, exported via `__private`, wired into job flow at line 1902 |
| `web/src/lib/games/route-handler.ts` | single true_play authority selector | ✓ VERIFIED | `selectAuthoritativeTruePlay` exported function at line 612; `TRUE_PLAY_AUTHORITY_SOURCE = 'CARD_PAYLOADS_DECISION_V2'` at line 543; no `FROM card_display_log` in live selection path |
| `apps/worker/src/jobs/__tests__/settle_pending_cards.phase2.test.js` | worker regression — authority guard | ✓ VERIFIED | Test `display backfill authority guard stays disabled even when override requested` passes all 3 input variants; 16/16 tests pass |
| `web/src/__tests__/api-games-missing-data-contract.test.js` | API regression for active-run and no-active-run consistency | ⚠️ STUB-LEVEL | 9 assertions all pass; 3 new authority assertions added; but all check source code strings, not runtime fixture behavior |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `settle_pending_cards.js` | `route-handler.ts` | Fields written by settlement excluded from live authority path | ✓ WIRED | `enableDisplayBackfill = false` prevents any card_display_log mutation at settlement time; route-handler confirmed no `FROM card_display_log` in live selection |
| `route-handler.ts` | `api-games-missing-data-contract.test.js` | Source assertions on stable selection | ✓ WIRED | Assertions reference `selectAuthoritativeTruePlay(plays)` and `truePlayMap.set` in route-handler |
| `settle_pending_cards.phase2.test.js` | `settle_pending_cards.js` | Replay test proves no live-authority mutation | ✓ WIRED | `__private.shouldEnableDisplayBackfill` tested directly against live export |

---

## Scope Hygiene Audit

| Commit | File | In WI-0891 Scope? | Impact |
|--------|------|-------------------|--------|
| `2bed099` | `apps/worker/src/jobs/settle_pending_cards.js` | ✓ YES | |
| `2bed099` | `apps/worker/src/jobs/__tests__/settle_pending_cards.phase2.test.js` | ✓ YES | |
| `909b709` | `web/src/__tests__/api-games-missing-data-contract.test.js` | ✓ YES | |
| `909b709` | `apps/worker/src/__tests__/settle-coverage.test.js` | ✗ **OUT OF SCOPE** | ⚠️ Blocker: test rename + 4 expectation inversions committed outside declared scope. Changes are behavior-correct (test now reflects ADR-0003 strict mode). settle-coverage suite passes 8/8. |

---

## Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| None in scoped files | — | — | — |

---

## WI-0890 Dependency Artifacts (Spot-Check)

WI-0890 is a direct dependency. Verified its deliverables are present and functional:

| Artifact | Status | Evidence |
|----------|--------|----------|
| `docs/decisions/ADR-0003-true-play-authority.md` | ✓ VERIFIED | 69-line ADR with canonical authority chain, tie-break order, ownership boundary, migration notes for WI-0891/WI-0892 |
| `web/src/__tests__/game-card-decision-authority.test.ts` | ✓ VERIFIED | 6 behavioral assertions; passes via `node --import tsx/esm`; asserts `true_play_authority_source = CARD_PAYLOADS_DECISION_V2`, `PLAY` beats `LEAN`, `PASS` excluded |
| `web/src/lib/games/route-handler.ts` | ✓ VERIFIED | `selectAuthoritativeTruePlay` present; authority metadata constants present; consistent with ADR-0003 tie-break order |

---

## Human Verification Required

### 1. Runtime authority stability under settlement replay

**Test:** In a staging environment, call `/api/games` for a game that has both an active card_payload and a settled result. Record `true_play.source_card_id`. Trigger `settlePendingCards()`. Call `/api/games` again for the same game.

**Expected:** `true_play.source_card_id` and `true_play_authority_source` are identical in both responses.

**Why human:** Source-code assertions cannot prove runtime authority stability under real concurrent settlement. Requires a live DB with both states present.

---

## Gaps Summary

Two gaps found:

1. **Partial (regression depth)** — The active-run / no-active-run authority path coverage in `api-games-missing-data-contract.test.js` is structural (grep on source), not behavioral. A fixture-level test exercising both paths through `selectAuthoritativeTruePlay` with and without active run ids would fully close this truth.

2. **Scope violation** — `apps/worker/src/__tests__/settle-coverage.test.js` was included in commit `909b709` but is not in WI-0891 declared scope. The changes are correct (they align the test to the ADR-0003 strict-mode semantics implemented in WI-0891), and the suite passes 8/8, but the deviation is undocumented in SUMMARY.md and violates AGENTS.md scope hygiene rules.

---

_Verified: 2026-04-11T23:59:00Z_
_Verifier: GitHub Copilot (gsd-verifier)_
