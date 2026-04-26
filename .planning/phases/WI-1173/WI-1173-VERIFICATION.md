---
phase: WI-1173
verified: 2026-04-26T00:55:02Z
status: human_needed
score: 6/6 must-haves verified
human_verification:
  - test: "Run pull_mlb_pitcher_stats against a dev DB"
    expected: "Newly written rows continue to support pitcher-K runtime paths with no write dependence on hits/earned_runs"
    why_human: "Requires DB-integrated job execution and row-level inspection"
  - test: "Run a high recent-BB% pitcher-K case end-to-end"
    expected: "Reason codes and bounded projection/confidence penalties appear in produced output payloads"
    why_human: "Needs integrated pipeline output validation beyond unit-level checks"
---

# Phase WI-1173 Verification Report

**Phase Goal:** Integrate pitcher command-context fields into MLB pitcher-K path and remove dead run-allowed write-path/model-input fields.
**Verified:** 2026-04-26T00:55:02Z
**Status:** human_needed
**Re-verification:** No - initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Active write path no longer persists `hits` and `earned_runs` | VERIFIED | `upsertGameLogs` insert/update omits both fields in `apps/worker/src/jobs/pull_mlb_pitcher_stats.js` (lines ~509-556). |
| 2 | Pitcher-K path derives and consumes command-context (`recent_bb_pct`, status, risk flag, home/away context) | VERIFIED | Command-context derivation + usage in `apps/worker/src/models/mlb-model.js` (lines ~2686-2802). |
| 3 | Command-risk projection/confidence behavior is bounded, deterministic, and reason-coded | VERIFIED | `COMMAND_RISK_*` and overlap cap (`projectionPreOverlap - 0.30`) implemented in model and asserted in `apps/worker/src/__tests__/mlb-k-bb-split.test.js` (multiple tests). |
| 4 | Output contract includes explainability fields | VERIFIED | Output includes `recent_bb_pct`, `recent_bb_pct_status`, `command_risk_flag` in `apps/worker/src/models/mlb-model.js` (lines ~2794-2796, ~3580-3582). |
| 5 | WI-0763 projection penalty path is superseded, with retained traceability marked deprecated | VERIFIED | Deprecated traceability fields retained but inert in model code and explicitly documented in `docs/models__mlb_pitcher_k_inputs.md` (deprecated section). |
| 6 | Repo-wide MLB runtime no longer actively consumes removed dead fields | VERIFIED | Repo-wide grep across apps/worker/src (excluding markdown) shows only MLB schema/comment references, with no active MLB runtime dependency. |

**Score:** 6/6 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `apps/worker/src/jobs/pull_mlb_pitcher_stats.js` | Dead-field write-path pruning | VERIFIED | Write path excludes `hits`/`earned_runs`; schema columns retained for historical compatibility. |
| `apps/worker/src/models/mlb-model.js` | Command-context derivation + bounded effects + output fields | VERIFIED | Derivation, reason codes, overlap cap, and traceability output are implemented. |
| `apps/worker/src/jobs/run_mlb_model.js` | Runtime model input path consumes command-context-compatible fields | VERIFIED | Pitcher history includes `walks`, `batters_faced`, `home_away`; explicitly excludes dead fields from model input. |
| `apps/worker/src/__tests__/mlb-k-bb-split.test.js` | Adversarial and contract tests | VERIFIED | 34 tests passed including cap, small-sample, missing-context, and reason-code coverage. |
| `docs/models__mlb_pitcher_k_inputs.md` | Runtime/deprecated field contract documentation | VERIFIED | Documents formulas, thresholds, caps, reason codes, retained deprecated fields. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `apps/worker/src/jobs/pull_mlb_pitcher_stats.js` | `apps/worker/src/models/mlb-model.js` | Game-log fields feed command-context lookback | WIRED | Producer writes `walks`, `batters_faced`, `home_away`; consumer derives BB context from those fields. |
| `apps/worker/src/models/mlb-model.js` | `apps/worker/src/__tests__/mlb-k-bb-split.test.js` | Reason-code/cap/threshold behavior | WIRED | Targeted tests pass and cover all required reason codes and cap behavior. |
| `apps/worker/src/models/mlb-model.js` | `docs/models__mlb_pitcher_k_inputs.md` | Deprecated + active contract parity | WIRED | Docs match runtime behavior and retained deprecated audit fields. |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| WI-1173 acceptance: dead-field prune | `WORK_QUEUE/COMPLETE/WI-1173.md` | Remove active dependency on `hits`/`earned_runs` in write/model-input paths | SATISFIED | Write path pruned; runtime grep confirms no active MLB dependency. |
| WI-1173 acceptance: command-context derivation | `WORK_QUEUE/COMPLETE/WI-1173.md` | Derive `recent_bb_pct` and status using 10-start lookback | SATISFIED | Implemented in `mlb-model.js`, with explicit thresholds and statuses. |
| WI-1173 acceptance: overlap cap | `WORK_QUEUE/COMPLETE/WI-1173.md` | Enforce `final_projection >= projection_pre_overlap - 0.30` | SATISFIED | Cap implemented and tested in `mlb-k-bb-split.test.js`. |
| WI-1173 acceptance: explainability outputs + docs | `WORK_QUEUE/COMPLETE/WI-1173.md` | Output and docs include new command-context fields and deprecated status | SATISFIED | Fields emitted in model output and documented in `docs/models__mlb_pitcher_k_inputs.md`. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| None | - | No placeholder/TODO/stub blockers in scoped WI-1173 files | INFO | No blocker anti-patterns found. |

### Human Verification Required

### 1. pull_mlb_pitcher_stats Dev DB Run

**Test:** Execute `pull_mlb_pitcher_stats` against a dev DB containing current-season pitcher data.
**Expected:** New rows keep pitcher-K pipeline functional while write path remains independent of `hits`/`earned_runs`.
**Why human:** Requires integration run and DB inspection not covered by static checks.

### 2. End-to-End Command-Risk Audit

**Test:** Run a known high-BB%-risk pitcher through the full MLB model pipeline and inspect payload/log artifacts.
**Expected:** `COMMAND_RISK_RECENT_BB_RATE` and bounded adjustments appear; no over-penalization beyond cap.
**Why human:** Requires end-to-end execution context and artifact inspection.

### Gaps Summary

No implementation gaps detected in automated/static verification. Human integration validation is still required for full operational sign-off.

---

_Verified: 2026-04-26T00:55:02Z_
_Verifier: Claude (gsd-verifier)_
