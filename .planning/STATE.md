---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: active
last_updated: "2026-04-03T00:00:00Z"
last_activity: "2026-04-04 - Completed quick task 123: NHL total gating: build pull_nhl_goalie_starters.js + require real source"
---

# Project State

This file is intentionally minimal to avoid stale status drift.
Historical quick-task completions have been moved to [COMPLETED_SPRINT_LOG.md](./COMPLETED_SPRINT_LOG.md).

## Authoritative Source of Truth

- Active and upcoming work: `WORK_QUEUE/WI-####.md`
- Completed work: `WORK_QUEUE/COMPLETE/WI-####.md`
- Sprint history: `.planning/COMPLETED_SPRINT_LOG.md`
- Work-item scope/acceptance always governs completion status.

## How To Read Current Project Status

- What is in progress: claimed items in `WORK_QUEUE/`
- What is done: items moved to `WORK_QUEUE/COMPLETE/`
- What is obsolete/superseded: explicit status notes inside the WI file

## Accumulated Context

### Pending Todos

- `2` pending todos in `.planning/todos/pending/`
- `2026-02-28-per-sport-model-health-agents-nba-nhl-ncaam-agents-own-model-health-checks.md`
- `2026-04-02-add-live-player-props-regression-coverage.md`

## Review Cadence

- Last reviewed: 2026-04-03
- Next action: WI-0747 (MLB K pipeline hardening) is complete. Remaining WI-0742 implementation scope: run_nhl_model.js (NHL_1P_TOTAL), run_nhl_player_shots_model.js (NHL_PLAYER_SHOTS), compare_audit_snapshot.js, and 2 remaining PROJECTION_ONLY fixtures. WI-0728, WI-0729, WI-0730, WI-0731, WI-0742 spec, WI-0747 are complete.

## Sprint Plan — 2026-04-02 (Model Audit Rollout Cycle)

**Context:** Baseline lock complete (WI-0728), card family registry established (WI-0730), first weekly scorecard complete (WI-0731). Projection-only families (NHL_1P_TOTAL, NHL_PLAYER_SHOTS, MLB_PITCHER_K, MLB_F5_TOTAL) emit `execution_status=PROJECTION_ONLY` but do not yet carry numeric projections. WI-0742 adds the numeric contract. No new sports or models until WI-0742 is complete.

---

### Recently Completed (since last STATE)

- WI-0713 ✓ — Season date logic fix
- WI-0714 ✓ — Remove mlF5Home/mlF5Away snapshot writes and NO_F5_ML_LINE log
- WI-0725 ✓ — Model audit stack: frozen audit contract, snapshot runner, comparator, scorecard, CI gate
- WI-0726 ✓ — Performance drift report + golden fixture library
- WI-0727 ✓ — Remove per-event odds fetching; force NHL 1P / NHL shots / MLB F5 / MLB pitcher-K to PROJECTION_ONLY
- WI-0729 ✓ — Model audit rollout runbook (docs/model_audit_rollout_runbook.md)
- WI-0730 ✓ — Card family registry (4 LIVE, 4 PROJECTION_ONLY; audit/README.md added)
- WI-0731 ✓ — First weekly scorecard 2026-W14 (all 8 families ranked; NBA_TOTAL Watch/model_decay; next review 2026-04-09)
- WI-0741 ✓ — Harden audit artifact upload checks (CI gate)

---

### Dependency Chains — Model Audit Rollout

- **WI-0728** ✓ — First baseline lock-in cycle (2026-04-02)
- **WI-0729** ✓ — Model audit rollout runbook (2026-04-02)
- **WI-0730** ✓ — Card family registry with operational status (2026-04-02)
- **WI-0731** ✓ — First weekly scorecard 2026-W14 (2026-04-02)
- **WI-0742** ✓ — Projection-only decision-ready output contract spec; implementation sprint next
- WI-0747 ✓ — MLB K pipeline hardening: `classifyMlbPitcherKQuality`, `[MLB_K_AUDIT]` log, INV-007, input contract spec (2026-04-03)
### Dependency Chains — Open FPL / Product

- **WI-0705** — Fix Build Lab "New session" 422; no deps → **UNBLOCKED**
- **WI-0653** — Manager Profile APIs (re-implement — 0/5 verified, never committed); no deps → **UNBLOCKED**
- **WI-0657** — Explainability contract gap-fill (3/5 verified); no deps → **UNBLOCKED**
- **WI-0706** — Profile persistence; requires WI-0653 → blocked
- **WI-0669** — Final Recommendation terminal output; depends on WI-0656 ✓, WI-0660 ✓ → **UNBLOCKED**
- **WI-0668** — NL Intent Translation Layer; depends on WI-0660 ✓, WI-0652 ✓ → **UNBLOCKED**
- **WI-0670** — Comparison + tradeoff chips; depends on WI-0669 → blocked on WI-0669
- **WI-0671** — Post-draft season loop; depends on WI-0669, WI-0652 ✓ → blocked on WI-0669
- **WI-0672** — Constraint state panel + reset; depends on WI-0668 → blocked on WI-0668
- **WI-0708** — API contract expansion (posture-aware outputs); depends on WI-0707 ✓ → **UNBLOCKED**
- **WI-0709** — nextGW ceiling/floor pts from FPL API; depends on WI-0707 ✓ → **UNBLOCKED**
- **WI-0662** — Sage frontend internal-only + runbook; depends on WI-0659 ✓, WI-0660 ✓, WI-0661 ✓ → **UNBLOCKED**
- **WI-0663** — MLB pitcher-K UNDER monitoring; independent → **UNBLOCKED**
- **WI-0710** — OCR + live FPL registry; lower priority, Q2 → **UNBLOCKED**
- **WI-0664 → WI-0665 → WI-0666 → WI-0667** — public betting splits pipeline; low priority, defer

---

### Prioritized Open Work Queue

#### P1 — Implement WI-0742 Contract (current sprint)

- **WI-0747 ✓ COMPLETE** — MLB K pipeline hardening done: classifier, pre-model audit, INV-007, spec doc.
- **WI-0742 remaining** — Wire decision-ready contract into remaining model jobs:
  `run_nhl_model.js` (NHL_1P_TOTAL),
  `run_nhl_player_shots_model.js` (NHL_PLAYER_SHOTS);
  update `compare_audit_snapshot.js`;
  update 2 remaining PROJECTION_ONLY fixtures.
  Spec lives in `WORK_QUEUE/COMPLETE/WI-0742.md`.

#### P2 — FPL Shell Repair (unblocked, run in parallel with P1)

- **WI-0705** — Fix Build Lab "New session" 422
- **WI-0653** — Re-implement Manager Profile APIs (0 code ever committed)
- **WI-0657** — Fill explainability contract gap (5 contract fields missing)

#### P3 — Unblocked Core Product

- **WI-0669** — Final Recommendation terminal output (gates WI-0670, WI-0671)
- **WI-0668** — NL Intent Translation Layer (gates WI-0672)
- **WI-0709** — `nextGW_ceiling_pts` / `nextGW_floor_pts` from FPL API
- **WI-0708** — API contract expansion for posture-aware outputs

#### P4 — Blocked / Gated

- **WI-0706** — blocked on WI-0653
- **WI-0670** — blocked on WI-0669
- **WI-0671** — blocked on WI-0669
- **WI-0672** — blocked on WI-0668

#### P5 — Low Priority

- **WI-0662** — Sage frontend internal-only + runbook cleanup
- **WI-0663** — MLB pitcher-K UNDER monitoring
- **WI-0664 → 0665 → 0666 → 0667** — public betting splits pipeline (defer until pipeline is consistently profitable)
- **WI-0710** — OCR + live FPL player registry (synthetic scaffold is functional for now)

---

**Guard:** No new sport or model is added until WI-0728 (baseline lock) and WI-0731 (first scorecard) are both closed.

**Edge retention review:** Schedule for 2–4 weeks after WI-0731 closes. That is when promotion, hold, or cut decisions for each card family are made.

See [COMPLETED_SPRINT_LOG.md](./COMPLETED_SPRINT_LOG.md) for full historical quick-task archive.

### Quick Tasks Completed

| #   | Description                                                                     | Date       | Commit  | Directory                                                                                              |
|-----|---------------------------------------------------------------------------------|------------|---------|--------------------------------------------------------------------------------------------------------|
| 118 | WI-0757: Actual result ingestion for projection cards (nhl-pace-1p and mlb-f5) | 2026-04-03 | edcc5e9 | [118-wi-0757-actual-result-ingestion-for-proj](./quick/118-wi-0757-actual-result-ingestion-for-proj/) |
| 119 | WI-0758: Actual result ingestion for player prop cards                         | 2026-04-03 | 7284284 | [119-wi-0758-actual-result-ingestion-for-play](./quick/119-wi-0758-actual-result-ingestion-for-play/) |
| 121 | Fix NHL model to consume existing Fenwick% and HDCF% inputs from MoneyPuck raw_data | 2026-04-04 | 7add789 | [121-fix-nhl-model-to-consume-existing-fenwic](./quick/121-fix-nhl-model-to-consume-existing-fenwic/) |
| 122 | WI-0773: NHL variance use historical settlement data (computeSigmaFromHistory) | 2026-04-04 | fbdba61 | [122-wi-0773-nhl-variance-use-historical-sett](./quick/122-wi-0773-nhl-variance-use-historical-sett/) |
| 123 | WI-0774: NHL goalie starter pre-fetch pipeline (pull_nhl_goalie_starters + resolveGoalieState NHL_API_CONFIRMED) | 2026-04-04 | 0f10fb9 | [123-nhl-total-gating-build-pull-nhl-goalie-s](./quick/123-nhl-total-gating-build-pull-nhl-goalie-s/) |

