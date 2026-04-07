---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: active
last_updated: "2026-04-06T00:00:00Z"
last_activity: "2026-04-06 - Reprioritized sprint plan; deprioritized FPL/NFL/Auth; 43 open WIs triaged into 5 tiers"
---

# Project State

## Authoritative Source of Truth

- Active and upcoming work: `WORK_QUEUE/WI-####.md`
- Completed work: `WORK_QUEUE/COMPLETE/WI-####.md`
- Sprint history: `.planning/COMPLETED_SPRINT_LOG.md`
- Work-item scope/acceptance always governs completion status.

---

## Deprioritized Domains (do not pick up without explicit re-enable)

These areas are parked. No agent should start or continue work here until explicitly re-enabled.

| Domain | WIs | Reason |
|--------|-----|--------|
| **Auth** | WI-0794, WI-0795, WI-0796 | Deprioritized — auth hardening deferred |
| **FPL** | WI-0662, WI-0705, WI-0706, WI-0708, WI-0709, WI-0710 | Deprioritized — FPL feature work deferred |
| **NFL** | WI-0766 | Deprioritized — NFL data layer spec deferred |

---

## Sprint Plan — 2026-04-06 (Risk Elimination + Model Quality Cycle)

**Context:** Raw implied probability two-sided vig removal landed (QT-139, QT-140).
Pipeline health watchdog is live (WI-0797). Card duplication, execution-risk gaps,
and model input quality are the next three rings to close before any new features.

---

### TIER 1 — Production Stability (pick up immediately, unblocked)

These are correctness or data-integrity defects with live impact.

| WI | Title | Status |
|----|-------|--------|
| **WI-0812** | Fix market-call card duplication — deterministic IDs + upsert + UNIQUE constraint | Open |
| **WI-0816** | Add 5xx retry to Odds API fetch | Open |
| **WI-0817** | Wrap delete+insert in SQLite transaction in `prepareModelAndCardWrite` | Open |
| **WI-0799** | Admin Dashboard — consecutive failure streak + stale-card muting (partially shipped QT-137) | Open |

**Rule:** Only one agent per WI. WI-0812 must complete before WI-0838 starts.

---

### TIER 2 — Execution Risk Fixes (start after or in parallel with Tier 1)

These close live trading-risk holes: bad edge math, uncalibrated confidence, stale prices.

| WI | Title | Depends on |
|----|-------|------------|
| **WI-0813** | Fix cross-book vig removal — same-book two-sided pairs | None |
| **WI-0814** | Sigma fallback safety gate (PLAY→LEAN when sigma_source=fallback) | None |
| **WI-0815** | Propagate EDGE_SANITY_CLAMP_APPLIED to watchdog CAUTION | None |
| **WI-0818** | Emit `price_staleness_warning` on hard-locked cards with stale price | None |
| **WI-0835** | Sigma provenance — expose `sigma_source` on card payload and logs | None |
| **WI-0819** | Quarter-Kelly stake fraction on PLAY/LEAN card payloads | WI-0813 |

**Rule:** WI-0813 must land before WI-0819. All others are independent.

---

### TIER 3 — Model Input Quality Quick Wins (run in parallel with Tier 2)

Small, scoped, high signal-to-noise improvements to existing live models.

| WI | Title | Sport | Gate |
|----|-------|-------|------|
| **WI-0836** | Rest-days pipeline — compute homeRest/awayRest, pass into NBA/NHL models | NBA/NHL | None |
| **WI-0837** | ESPN neutral metrics alerting — Discord warning when all team inputs are null | NBA | None |
| **WI-0839** | NHL 1P sigma static gate — label/suppress 1P cards below 40 settled results | NHL | None |
| **WI-0840** | MLB dynamic league constants — replace hardcoded 2024 xFIP/xwOBA/K% with live season averages | MLB | None |
| **WI-0841** | NBA impact players — replace static 41-name list with ESPN injury-feed tier | NBA | None |
| **WI-0820** | Core Input Gate — NO_BET / DEGRADED / MODEL_OK state machine | All | None |
| **WI-0838** | CLV first-seen price lock — freeze `odds_at_pick` at card creation | All | WI-0812 |

---

### TIER 4 — Model Architecture Refactors (sequence carefully, one per sport at a time)

These change model internals. Do not run multiple refactors per sport concurrently.

| WI | Title | Sport | Notes |
|----|-------|-------|-------|
| **WI-0821** | MLB Offense Stack Collapse — two-term composite replaces four-term chain | MLB | High impact |
| **WI-0822** | NBA Pace Normalization — fix ORtg proxy, retire dual-pace framework | NBA | High impact |
| **WI-0823** | NHL Unified Goalie Signal — consolidate GSaX + SV% into one score | NHL | High impact |
| **WI-0825** | Calibration Layer — per-market Brier/ECE tracking with kill switch | All | Enables WI-0824 |
| **WI-0824** | Two-Layer Bet Execution Gate — separate fair probability from executable edge | All | Requires WI-0825 |
| **WI-0826** | CLV + firing/winning monitoring dashboard data | All | Requires WI-0838 |
| **WI-0827** | Feature timestamp audit — enforce strict event-time data in all model inputs | All | CI gate |
| **WI-0828** | CI ablation tests + standardized model output interface | All | CI gate |

**Sequencing rules:**
- WI-0825 (calibration tracking) must land before WI-0824 (execution gate).
- WI-0826 (dashboard data) requires WI-0838 (CLV price lock).
- WI-0821, WI-0822, WI-0823 are independent and can run concurrently across sports.

---

### TIER 5 — Research and Long-Horizon (do not start until Tier 3 is complete)

| WI | Title |
|----|-------|
| **WI-0809** | Rolling cohort windows to decision-tier calibration report |
| **WI-0811** | Book-to-book mispricing scanner |
| **WI-0829** | Residual modeling layer — predict fair line vs market line |
| **WI-0830** | Additive z-score model core — shared bounded scoring framework |
| **WI-0831** | Isotonic regression calibration per market |
| **WI-0832** | Backtest closing-line substitution removal |
| **WI-0833** | Feature correlation cluster detection in CI |
| **WI-0834** | Risk model recalibration — re-run Monte Carlo with empirical edge |

---

## Non-Negotiables (always enforced)

- Single-writer DB contract: worker is sole DB writer. Web routes must never call `closeDatabase()`, `runMigrations()`, `db.exec()`, or `stmt.run()`.
- Production DB path: `CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db`. Do not set `CHEDDAR_DATA_DIR`.
- `web/src/middleware.ts` must not exist alongside `proxy.ts` — CI gate enforces this.
- No new sport or model enabled until its Tier 3 quality items are shipped.
- Every change traces to exactly one WI. No repo-wide formatting or drive-by fixes.

---

## Accumulated Context

### Pending Todos

- `2` pending todos in `.planning/todos/pending/`
- `2026-02-28-per-sport-model-health-agents-nba-nhl-ncaam-agents-own-model-health-checks.md`
- `2026-04-02-add-live-player-props-regression-coverage.md`

### Quick Task Counter

Last quick task: **140** (WI-0810 residual devig — BLK twoSidedFairProb)

See [COMPLETED_SPRINT_LOG.md](./COMPLETED_SPRINT_LOG.md) for full history.
