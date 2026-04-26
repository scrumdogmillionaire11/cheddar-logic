---
phase: WI-0893-drop-reason-ledger
verified: 2026-04-12T20:20:57Z
status: passed
score: 4/4 must-haves verified
---

# Phase WI-0893 Verification Report

**Phase Goal:** Add deterministic observability showing why odds-backed candidates do not surface, with layer-specific reason codes across worker, API, transform, and diagnostics context.
**Verified:** 2026-04-12T20:20:57Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Worker drop paths emit a normalized drop reason with bounded taxonomy and explicit layer origin. | ✓ VERIFIED | `apps/worker/src/jobs/execution-gate.js` maps raw block reasons to bounded codes such as `MISSING_EDGE`, `NO_EDGE_AT_CURRENT_PRICE`, and `PROJECTION_ONLY_EXCLUSION`, and emits `drop_reason_layer: 'worker_gate'`. |
| 2 | NBA and NHL model runners preserve the normalized worker drop reason on candidate payloads. | ✓ VERIFIED | `apps/worker/src/jobs/run_nba_model.js` and `apps/worker/src/jobs/run_nhl_model.js` both attach `drop_reason` on early exits and on evaluated execution-gate results. |
| 3 | API and transform layers preserve the reason ledger for diagnostics consumers. | ✓ VERIFIED | `web/src/lib/games/route-handler.ts` collects `execution_gate.drop_reason`, aggregates `drop_summary`, and `web/src/lib/game-card/transform/index.ts` preserves `transform_meta.drop_reason`. |
| 4 | Diagnostics-mode card context exposes reason code and origin without changing default rendering. | ✓ VERIFIED | `web/src/components/cards/CardsPageContext.tsx` only adds `_drop_reason_code` and `_drop_reason_layer` when diagnostics mode is enabled. |

**Score:** 4/4 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `apps/worker/src/jobs/execution-gate.js` | Bounded drop-reason taxonomy | ✓ VERIFIED | Substantive mapping function and emitted object shape are present. |
| `apps/worker/src/jobs/run_nba_model.js` | Worker-side payload propagation for NBA | ✓ VERIFIED | Early-exit and evaluated execution paths both carry `drop_reason`. |
| `apps/worker/src/jobs/run_nhl_model.js` | Worker-side payload propagation for NHL | ✓ VERIFIED | Same normalized ledger shape is forwarded into payloads. |
| `web/src/lib/games/route-handler.ts` | API diagnostics collection and summary | ✓ VERIFIED | Parses payload drop reasons and builds grouped `drop_summary` in dev diagnostics. |
| `web/src/lib/game-card/transform/index.ts` | Transform preservation of drop_reason | ✓ VERIFIED | Maps `execution_gate.drop_reason` into `transform_meta.drop_reason`. |
| `web/src/components/cards/CardsPageContext.tsx` | Diagnostics-mode visibility | ✓ VERIFIED | Adds diagnostic fields only when diagnostics mode is on. |
| `web/src/__tests__/api-games-missing-data-contract.test.js` | Regression proof of survivor + dropped candidate reason codes | ✓ VERIFIED | Synthetic fixture assertions verify a surviving candidate with `drop_reason: null` and a dropped candidate with `NO_EDGE_AT_CURRENT_PRICE` and `worker_gate`. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `apps/worker/src/jobs/execution-gate.js` | `apps/worker/src/jobs/run_nba_model.js` | Normalized worker-gate object attached to payload | ✓ WIRED | NBA runner forwards `gateResult.drop_reason` and explicit early-exit reasons. |
| `apps/worker/src/jobs/execution-gate.js` | `apps/worker/src/jobs/run_nhl_model.js` | Normalized worker-gate object attached to payload | ✓ WIRED | NHL runner mirrors the same propagation pattern. |
| Worker payloads | `web/src/lib/games/route-handler.ts` | `execution_gate.drop_reason` parsed into diagnostics | ✓ WIRED | Route handler reads the payload object and records grouped summaries. |
| `web/src/lib/games/route-handler.ts` | `web/src/lib/game-card/transform/index.ts` | `drop_reason` preserved in transformed play metadata | ✓ WIRED | Transform layer carries the reason object through `transform_meta`. |
| `web/src/lib/game-card/transform/index.ts` | `web/src/components/cards/CardsPageContext.tsx` | Diagnostics fields exposed to cards context | ✓ WIRED | Context derives `_drop_reason_code` and `_drop_reason_layer` from transformed play metadata. |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| `R1` | `WORK_QUEUE/COMPLETE/WI-0893.md` | Normalized drop reason + layer origin for dropped candidates | ✓ SATISFIED | Worker gate and model runners emit `drop_reason_code` and `drop_reason_layer`. |
| `R2` | `WORK_QUEUE/COMPLETE/WI-0893.md` | Reasons queryable in API diagnostics and diagnostics mode | ✓ SATISFIED | Route handler builds `drop_summary`; cards context exposes diagnostic fields. |
| `R3` | `WORK_QUEUE/COMPLETE/WI-0893.md` | Distinguish missing edge, no edge at current price, and projection-only exclusion | ✓ SATISFIED | Taxonomy mapping includes `MISSING_EDGE`, `NO_EDGE_AT_CURRENT_PRICE`, and `PROJECTION_ONLY_EXCLUSION`. |
| `R4` | `WORK_QUEUE/COMPLETE/WI-0893.md` | Regression includes survivor + dropped candidate with reason metadata | ✓ SATISFIED | `api-games-missing-data-contract.test.js` contains explicit synthetic survivor and dropped-candidate assertions. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| `web/src/lib/game-card/transform/index.ts` | 1811 | `DATA_ERROR_PLACEHOLDER` tag still exists | ℹ️ Info | Pre-existing degraded-data label; not part of the WI-0893 drop-reason ledger and not blocking the verified flow. |

### Human Verification Required

None identified for code-level verification.

### Gaps Summary

No goal-blocking gaps found. The ledger exists end-to-end from worker gating through API diagnostics and into diagnostics-mode card context.

---

_Verified: 2026-04-12T20:20:57Z_
_Verifier: Claude (gsd-verifier)_
