---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: active
last_updated: "2026-04-05T02:10:00Z"
last_activity: "2026-04-05 - Completed quick task 134: WI-0787 insertProjectionAudit unit tests — normal write, confidence_band derivation, idempotency, optional-field tolerance"
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

### Recently Completed (out-of-sprint)

- **WI-0761 ✓** — Model Health Dashboard: replaced `/admin` stub with live pipeline-health + model-outputs dashboard; `🏥 Model Health 🏥` button on homepage. Commits: 4fdac4a, 3a03863, 30adc8b, 94dcd4c, 8c472da
- **WI-0792 (open, low priority)** — Future brainstorm: model health log UX + alert reaction playbook. See `WORK_QUEUE/WI-0792.md`

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
| 124 | WI-0783: Sequential ordering guard — settle_pending_cards and settle_projections blocked until game-results succeeds | 2026-04-04 | 01070c0 | [124-wi-0783-sequential-ordering-guard-in-set](./quick/124-wi-0783-sequential-ordering-guard-in-set/) |
| 125 | WI-0765: NHL blocked-shot pipeline hardening — warn-and-return on missing NST CSV URLs, per-player null WARN, card-level block_rates_stale flag | 2026-04-04 | 62ac8ad | [125-wi-0765-schedule-pull-nhl-player-blk-ret](./quick/125-wi-0765-schedule-pull-nhl-player-blk-ret/) |
| 126 | WI-0776: Circa sharp splits from VSIN — migration 059, updateOddsSnapshotCircaSplits, soft-fail CIRCA fetch pass, sharp_divergence in NHL/NBA payloads | 2026-04-04 | cea1631 | [126-wi-0776-circa-sharp-splits-from-vsin-cir](./quick/126-wi-0776-circa-sharp-splits-from-vsin-cir/) |
| 127 | WI-0760: Wire model_outputs table to GET /api/model-outputs — route with optional ?sport= filter, NHL model header correction, models.js read-surface comment | 2026-04-04 | a5b3bd1 | [127-wire-model-outputs-table-to-web-api-endp](./quick/127-wire-model-outputs-table-to-web-api-endp/) |
| 128 | Fix MLB model test failures — projection_source + F5 floor math (8 failures block MLB CI) | 2026-04-04 | 299595f | [128-fix-mlb-model-test-failures-projection-s](./quick/128-fix-mlb-model-test-failures-projection-s/) |
| 129 | WI-0790: Fix decision-publisher.v2 stale-input BLOCKED test (160-min threshold) + post_discord_cards LEAN→Slight Edge label | 2026-04-05 | 9981f1f | [129-fix-decision-publisher-v2-stale-input-st](./quick/129-fix-decision-publisher-v2-stale-input-st/) |
| 130 | WI-0798: Fix NHL_CURRENT_SEASON stale default — replace '20242025' fallbacks with deriveNhlSeasonKey(); pin NHL_CURRENT_SEASON=20252026 in .env.production | 2026-04-05 | b8567fd | [130-fix-nhl-current-season-stale-default-202](./quick/130-fix-nhl-current-season-stale-default-202/) |
| 131 | WI-0799: Verify MLB Statcast scheduling chain — update stale comment in run_mlb_model.js + scheduler-windows test for pitcher_stats → statcast → weather ordering | 2026-04-05 | c1c24b2 | [131-wi-0799-verify-fix-mlb-statcast-scheduli](./quick/131-wi-0799-verify-fix-mlb-statcast-scheduli/) |
| 132 | Wire pull_schedule_nba and pull_schedule_nhl into automate scheduler — export key builders, add computeDueJobs entries at 04:00/11:00 ET, scheduler-windows test | 2026-04-05 | 1bbe0b6 | [132-wire-pull-schedule-nba-nhl-into-automate](./quick/132-wire-pull-schedule-nba-nhl-into-automate/) |
| 133 | NHL BLK model audit — wire opponent_attempt_factor (corsi proxy), playoff_tightening_factor (date heuristic), and lines_to_price into projectBlkV1 call site | 2026-04-05 | ff79fa8 | [133-nhl-blk-model-audit-opponent-factor-play](./quick/133-nhl-blk-model-audit-opponent-factor-play/) |
| 134 | WI-0787: Add unit tests for insertProjectionAudit — normal write, confidence_band derivation (5 cases), INSERT OR IGNORE idempotency, optional-field NULL tolerance | 2026-04-05 | fbd7053 | [134-wi-0787-add-projection-audit-row-level-t](./quick/134-wi-0787-add-projection-audit-row-level-t/) |

