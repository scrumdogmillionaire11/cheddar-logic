---
phase: WI-1182
verified: 2026-04-26T00:55:02Z
status: human_needed
score: 5/5 must-haves verified
human_verification:
  - test: "Pipeline health run with real near-term stale odds"
    expected: "Health row and Discord output contain concise remediation summary with detected/refreshed/blocked counts"
    why_human: "Requires integrated Discord/webhook and production-like data conditions"
  - test: "Feature-gated SOG sync behavior in live scheduler/health loop"
    expected: "Feature-disabled mode stays non-failed and non-alerting; enabled stale mode produces actionable alert"
    why_human: "Requires real scheduler cadence and live job-run recency behavior"
---

# Phase WI-1182 Verification Report

**Phase Goal:** Reduce false-noisy health alerts by adding bounded stale-odds remediation and feature-aware NHL SOG sync freshness handling.
**Verified:** 2026-04-26T00:55:02Z
**Status:** human_needed
**Re-verification:** No - initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | NHL SOG sync freshness check is feature-aware and non-failing when disabled | VERIFIED | `checkNhlSogSyncFreshness()` returns `ok` with reason `feature disabled` when flag is off in `apps/worker/src/jobs/check_pipeline_health.js` (lines ~1875-1880). |
| 2 | NHL SOG sync gets deterministic catch-up cadence to reduce 24h blind spots | VERIFIED | Scheduler runs `sync_nhl_sog_player_ids` at every fixed window when feature enabled in `apps/worker/src/schedulers/player-props.js` (fixed-window loop) and tests confirm 09:00 + 15:00 enqueue behavior. |
| 3 | Odds freshness attempts bounded remediation before final fail classification | VERIFIED | `checkOddsFreshness()` calls `refreshStaleOdds`, then re-checks stale near-term games before deciding final status in `apps/worker/src/jobs/check_pipeline_health.js` (lines ~314-347). |
| 4 | Final odds fail reason includes remediation summary (`detected`, `refreshed`, `blocked`) | VERIFIED | Reason string appends remediation suffix in `check_pipeline_health.js` (lines ~337-347), and tests assert reason contents in `apps/worker/src/jobs/__tests__/check_pipeline_health.test.js` (lines ~354-355, ~411-413). |
| 5 | Watchdog/Discord suppression + emission behavior matches feature-disabled and remediation outcomes | VERIFIED | Watchdog tests validate suppression for feature-disabled/remediation-success and emission for stale-sync-risk/remediation-still-stale in `apps/worker/src/jobs/__tests__/check_pipeline_health.watchdog.test.js` (WI-1182 describe blocks). |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `apps/worker/src/jobs/check_pipeline_health.js` | Feature-aware SOG sync + bounded stale-odds remediation and reasoning | VERIFIED | Substantive implementation and watchdog integration present. |
| `apps/worker/src/jobs/refresh_stale_odds.js` | Canonical remediation path with diagnostics | VERIFIED | Exposes `staleDiagnostics` with `detected/refreshed/blocked`; test suite passes. |
| `apps/worker/src/schedulers/player-props.js` | Fixed-window SOG sync catch-up cadence | VERIFIED | SOG sync queued at each fixed window behind feature gate. |
| `apps/worker/src/jobs/__tests__/check_pipeline_health.test.js` | Core health check behavior coverage | VERIFIED | Includes remediation-success/still-stale and feature-disabled SOG checks; suite passed. |
| `apps/worker/src/jobs/__tests__/check_pipeline_health.watchdog.test.js` | Discord suppression/emission behavior coverage | VERIFIED | Explicit WI-1182 scenarios covered and passing. |
| `apps/worker/src/schedulers/__tests__/player-props.test.js` | Scheduler cadence and flag gating coverage | VERIFIED | Confirms catch-up windows and feature gating behavior; suite passed. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `apps/worker/src/jobs/check_pipeline_health.js` | `apps/worker/src/jobs/refresh_stale_odds.js` | Bounded remediation call inside odds freshness check | WIRED | `refreshStaleOdds()` invocation and post-remediation re-check are implemented. |
| `apps/worker/src/schedulers/player-props.js` | `apps/worker/src/jobs/check_pipeline_health.js` | Reduced stale-sync risk via catch-up sync cadence + feature-aware health evaluation | WIRED | Scheduler catches up sync job, health check reads recency and feature state consistently. |
| `apps/worker/src/jobs/check_pipeline_health.js` | `apps/worker/src/jobs/__tests__/check_pipeline_health.watchdog.test.js` | Discord emission/suppression contract | WIRED | Tests assert both suppression and emission branches including remediation summary behavior. |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| WI-1182 acceptance: feature-aware SOG freshness | `WORK_QUEUE/COMPLETE/WI-1182.md` | Disabled feature records non-failed `ok` and avoids noise | SATISFIED | Implemented in health check and tested in `check_pipeline_health.test.js` + watchdog tests. |
| WI-1182 acceptance: deterministic SOG retry cadence | `WORK_QUEUE/COMPLETE/WI-1182.md` | Additional cadence/catch-up trigger prevents full-day blind spot | SATISFIED | Fixed-window catch-up sync in scheduler and tests for both windows. |
| WI-1182 acceptance: stale-odds remediation before fail | `WORK_QUEUE/COMPLETE/WI-1182.md` | Remediation attempt precedes final fail state and reason includes summary | SATISFIED | `checkOddsFreshness` flow and remediation reason assertions in tests. |
| WI-1182 acceptance: watchdog suppression/emission coverage | `WORK_QUEUE/COMPLETE/WI-1182.md` | Suppress noise in safe branches and emit actionable alerts in true-risk branches | SATISFIED | Dedicated watchdog test suite covers all listed branches. |
| WI-1182 dependency caveat | `WORK_QUEUE/COMPLETE/WI-1182.md` | WI-1155 completion required for lane ordering caveat | SATISFIED | Dependency target `WORK_QUEUE/COMPLETE/WI-1155.md` is present in COMPLETE lane. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| None | - | No TODO/FIXME/placeholder or stub blockers found in WI-1182 scope | INFO | No blocker anti-patterns found. |

### Human Verification Required

### 1. Live Remediation Messaging Check

**Test:** Run pipeline health in a fixture/live-like state with at least one stale near-term game and observe persisted reason + Discord alert text.
**Expected:** Concise, operator-actionable remediation summary appears with detected/refreshed/blocked counts.
**Why human:** Requires webhook/ops-context judgement and integrated runtime behavior.

### 2. Live Feature-Flag Behavior Check

**Test:** Toggle `ENABLE_NHL_SOG_PLAYER_SYNC` in an integration environment and run scheduler + health loop.
**Expected:** Disabled mode remains non-failed and non-alerting; enabled stale mode alerts only on true stale-sync risk.
**Why human:** Needs runtime scheduler cadence and real recency windows.

### Gaps Summary

No implementation gaps detected in automated/static verification. Human operational validation remains for final production confidence.

---

_Verified: 2026-04-26T00:55:02Z_
_Verifier: Claude (gsd-verifier)_
