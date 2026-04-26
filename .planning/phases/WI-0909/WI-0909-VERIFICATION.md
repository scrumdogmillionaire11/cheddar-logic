---
phase: WI-0909-nhl-player-shots-source-unification
verified: 2026-04-12T20:20:57Z
status: passed
score: 5/5 must-haves verified
---

# Phase WI-0909 Verification Report

**Phase Goal:** Unify full-game NHL player-shots settlement so projection `actual_result` and `card_results` grading use one consistent stat source and reconciliation rules, and ensure full-game NHL player-shots plays surface under the same publish/display contract.
**Verified:** 2026-04-12T20:20:57Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Full-game NHL player-shots projection settlement reads from one canonical source path with deterministic fallback. | ✓ VERIFIED | `apps/worker/src/jobs/settle_projections.js` fetches `fetchNhlSettlementSnapshot()` and resolves shots through `resolveNhlFullGamePlayerShots()` using player id first, then normalized-name fallback. |
| 2 | Game-results settlement stores the same NHL snapshot shape consumed later by card settlement. | ✓ VERIFIED | `apps/worker/src/jobs/settle_game_results.js` writes `playerShots.fullGameByPlayerId`, `playerIdByNormalizedName`, and `firstPeriodVerification` into `game_results.metadata` after a double-confirmed NHL API snapshot. |
| 3 | Silent disagreement between stored metadata and live API values is replaced with explicit mismatch telemetry. | ✓ VERIFIED | `settle_projections.js` emits `[NHL_SHOTS_MISMATCH]` when stored `game_results.metadata.playerShots` differs from the live API value used for projection settlement. |
| 4 | Card settlement uses explicit player-shots metadata and deterministic error codes rather than implicit fallbacks. | ✓ VERIFIED | `apps/worker/src/jobs/settle_pending_cards.js` resolves full-game shots from `game_results.metadata.playerShots.fullGameByPlayerId` and throws `MISSING_PLAYER_SHOTS_DATA` or `MISSING_PLAYER_SHOTS_VALUE` when required inputs are missing. |
| 5 | Full-game and 1P NHL player props are surfaced through the API props path without environment-only suppression. | ✓ VERIFIED | `web/src/lib/games/route-handler.ts` treats `nhl-player-shots` and `nhl-player-shots-1p` as prop plays, preserves `PROP` market type, deduplicates by player identity/period/side, and avoids the wave-1 silent-drop path for prop rows. |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `apps/worker/src/jobs/nhl-settlement-source.js` | Canonical NHL settlement snapshot and full-game player-shot resolver | ✓ VERIFIED | Provides snapshot normalization and deterministic id/name lookup. |
| `apps/worker/src/jobs/settle_projections.js` | Projection `actual_result` uses canonical snapshot path | ✓ VERIFIED | Wired to the settlement-source module and mismatch telemetry. |
| `apps/worker/src/jobs/settle_game_results.js` | Persists NHL snapshot metadata for downstream card settlement | ✓ VERIFIED | Writes confirmed snapshot fields into `game_results.metadata`. |
| `apps/worker/src/jobs/settle_pending_cards.js` | Card grading uses persisted metadata and explicit errors | ✓ VERIFIED | Reads the persisted shot maps and grades deterministically. |
| `web/src/lib/games/route-handler.ts` | NHL prop cards survive the API surface path consistently | ✓ VERIFIED | Explicit prop handling and dedupe logic are present. |
| `apps/worker/src/jobs/__tests__/settle_projections.test.js` | Mismatch and id/name fallback regression coverage | ✓ VERIFIED | Tests cover mismatch warning, no-mismatch path, id lookup, and name lookup. |
| `web/src/__tests__/api-games-prop-decision-contract.test.js` | API prop contract regression | ✓ VERIFIED | Test executed successfully from repo root. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `apps/worker/src/jobs/nhl-settlement-source.js` | `apps/worker/src/jobs/settle_projections.js` | Canonical snapshot fetch + full-game resolver | ✓ WIRED | `settle_projections` imports and calls both exports directly. |
| `apps/worker/src/jobs/settle_game_results.js` | `apps/worker/src/jobs/settle_pending_cards.js` | Persisted `playerShots` metadata reused for card grading | ✓ WIRED | `settle_game_results` writes the same fields that `resolvePlayerShotsActualValue()` later consumes. |
| `apps/worker/src/jobs/run_nhl_player_shots_model.js` | `web/src/lib/games/route-handler.ts` | Full-game prop payloads routed through the props surface path | ✓ WIRED | Route handler explicitly preserves `nhl-player-shots` prop rows and skips the silent wave-1 drop path for them. |
| `web/src/lib/games/route-handler.ts` | `web/src/__tests__/api-games-prop-decision-contract.test.js` | Prop contract protection | ✓ WIRED | Test asserts normalized prop decision fields remain exposed in the route handler. |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| `WI-0909` | `WORK_QUEUE/COMPLETE/WI-0909.md` | Unify full-game NHL player-shots settlement source and surfacing contract | ✓ SATISFIED | Canonical snapshot path, persisted metadata reuse, mismatch telemetry, explicit grading errors, and API prop surfacing are all present. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| None | - | - | - | No blocker stubs or placeholder implementations found in the verified scope. |

### Human Verification Required

None identified for code-level verification.

### Gaps Summary

No goal-blocking gaps found. Full-game NHL player-shots settlement is now tied to one confirmed NHL snapshot contract and the API prop path no longer silently filters these rows away.

---

_Verified: 2026-04-12T20:20:57Z_
_Verifier: Claude (gsd-verifier)_
