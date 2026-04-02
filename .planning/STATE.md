---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: active
last_updated: "2026-04-02T00:00:00Z"
last_activity: "2026-04-02 - Model audit stack complete; per-event odds removed; WI-0728–0731 planned for baseline lock + rollout cycle"
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

- `3` pending todos in `.planning/todos/pending/`
- `2026-02-28-per-sport-model-health-agents-nba-nhl-ncaam-agents-own-model-health-checks.md`
- `2026-04-02-add-live-player-props-regression-coverage.md`
- `2026-04-02-restore-configurable-mlb-pitcher-k-rollout-mode.md`

## Review Cadence

- Last reviewed: 2026-04-02
- Next action: Run WI-0728 (baseline lock) and WI-0730 (family registry) in parallel. WI-0731 (scorecard) is gated on both.

## Sprint Plan — 2026-04-02 (Model Audit Rollout Cycle)

**Context:** The model audit stack is complete (WI-0725, WI-0726). Per-event odds have been stripped and projection-only lanes formalized (WI-0727). The audit system now needs to be used to make actual product decisions. No new sports or models until the first baseline lock and scorecard review are done.

---

### Recently Completed (since last STATE)

- WI-0713 ✓ — Season date logic fix
- WI-0714 ✓ — Remove mlF5Home/mlF5Away snapshot writes and NO_F5_ML_LINE log
- WI-0725 ✓ — Model audit stack: frozen audit contract, snapshot runner, comparator, scorecard, CI gate
- WI-0726 ✓ — Performance drift report + golden fixture library
- WI-0727 ✓ — Remove per-event odds fetching; force NHL 1P / NHL shots / MLB F5 / MLB pitcher-K to PROJECTION_ONLY

---

### Dependency Chains — Model Audit Rollout

- **WI-0728** — First baseline lock-in cycle; no deps → **READY**
- **WI-0729** — Model audit rollout runbook; no blocking deps (reference WI-0730 paths before close) → **READY**
- **WI-0730** — Card family registry with operational status; no deps → **READY**
- **WI-0731** — First weekly scorecard; depends on WI-0728 ✓ + WI-0730 ✓ → **blocked until both close**

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

#### P1 — Model Audit Rollout (this sprint)

Run WI-0728 and WI-0730 in parallel first. WI-0729 can run alongside.

- **WI-0728** — Run `audit:all`, review every fixture, lock baselines, set `baseline_reviewed: true`
- **WI-0730** — Create `card-family-registry.json`: LIVE × 4 (`NBA_TOTAL`, `NBA_SPREAD`, `NHL_TOTAL`, `NHL_ML`), PROJECTION_ONLY × 4 (`NHL_1P_TOTAL`, `NHL_PLAYER_SHOTS`, `MLB_PITCHER_K`, `MLB_F5_TOTAL`)
- **WI-0729** — Write `docs/model_audit_rollout_runbook.md`
- **WI-0731** — Run first scorecard + publish ranked family table (gated on WI-0728 + WI-0730)

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

