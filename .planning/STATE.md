---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Model Integrity & Betting Execution Hardening
status: active
last_updated: "2026-04-08T22:00:00Z"
last_activity: "2026-04-08 - WI-0840 complete: MLB dynamic league constants — computeMLBLeagueAverages queries mlb_pitcher_stats AVG(season_k_pct|x_fip|bb_pct); setLeagueConstants setter; module-level mutables replace 8 hardcoded call-sites; [MLB_LEAGUE_AVG] log; 1265+234 tests passing."
---

# Project State

This file is the authoritative sprint plan. Agents must read it before claiming any work item.
Historical quick-task completions: [COMPLETED_SPRINT_LOG.md](./COMPLETED_SPRINT_LOG.md).

## Authoritative Source of Truth

- Active and upcoming work: `WORK_QUEUE/WI-####.md`
- Completed work: `WORK_QUEUE/COMPLETE/WI-####.md`
- Sprint history: `.planning/COMPLETED_SPRINT_LOG.md`
- Work-item scope/acceptance always governs completion status.

---

## FROZEN DOMAINS (as of 2026-04-06)

Agents must not claim, modify, or execute work items in these areas until the freeze is lifted:

| Domain | Frozen WIs | Reason |
|--------|-----------|--------|
| **FPL** | WI-0662, WI-0705, WI-0706, WI-0708, WI-0709, WI-0710 | Product direction deprioritized; FPL is internal-only |
| **NFL** | WI-0766 | No data layer; stub disabled |
| **Auth** | WI-0794, WI-0795, WI-0796 | Infrastructure not ready; formally deferred |

---

## Active Focus: Model Integrity & Betting Execution

**North star:** Every card that fires must be built on correct math, clean inputs, and a demonstrably positive-EV execution signal. Work flows in dependency order — sprint N must be stable before sprint N+1 begins.

---

## Sprint 1 — Foundation: Data Integrity & Safety Infrastructure
**~1 week | Parallelize freely — items are independent of each other**

Pre-requisites for all model math corrections. Non-breaking, additive.

| WI | Title | Priority |
|----|-------|----------|
| ~~**WI-0820**~~ | ~~Core input gate — `NO_BET` / `DEGRADED` / `MODEL_OK` short-circuit~~ | ~~**Critical**~~ COMPLETE (2026-06-10) |
| ~~**WI-0812**~~ | ~~Fix card payload duplication — deterministic ID + upsert `ON CONFLICT`~~ | ~~High~~ COMPLETE (2026-06-10) |
| ~~**WI-0817**~~ | ~~Wrap delete+insert in SQLite transaction in `prepareModelAndCardWrite`~~ | ~~Medium~~ COMPLETE (2026-04-07) |
| **WI-0816** | Odds API 5xx retry with exponential backoff | Medium |
| ~~**WI-0835**~~ | ~~Sigma provenance — `sigma_source` + `sigma_games_sampled` on card payloads~~ | ~~Medium~~ COMPLETE (2026-04-08) |

**Sprint 1 done when:** WI-0820 gate is live and short-circuiting on missing core inputs; WI-0812 upsert confirmed; WI-0817 transaction wrapping in place; WI-0816 retry helper wired; WI-0835 `[SIGMA_SOURCE]` log emitting.

---

## Sprint 2 — Model Formula Corrections
**~1 week | Start after WI-0820 is complete. Items within sprint are parallel.**

| WI | Title | Priority | Deps |
|----|-------|----------|------|
| ~~**WI-0821**~~ | ~~MLB offense stack — replace 4-term multiplicative chain with 2-term composite~~ | ~~High~~ COMPLETE (2026-04-08) |
| ~~**WI-0822**~~ | ~~NBA pace normalization — fix ORtg proxy, retire dual pace framework~~ | ~~High~~ COMPLETE (2026-04-08) |
| **WI-0813** | Cross-book vig removal — fix same-book pairing in `selectTotalExecution` | High | none |
| ~~**WI-0814**~~ | ~~Sigma fallback safety gate — PLAY→LEAN when `sigma_source=fallback`~~ | ~~High~~ COMPLETE (2026-04-08) | — |
| **WI-0839** | NHL 1P sigma static gate — LEAN when <40 settled 1P results | Medium | WI-0835 |
| **WI-0836** | Rest-days pipeline — compute `homeRest`/`awayRest`, thread into NBA + NHL models | Medium | none |
| ~~**WI-0840**~~ | ~~MLB dynamic league constants — replace hardcoded 2024 averages with live season stats~~ | ~~Medium~~ COMPLETE (2026-04-08) | — |

**Sprint 2 done when:** All 7 items land, CI green, no model test regressions.

---

## Sprint 3 — Signal Quality & Operational Observability
**~1 week | Start after Sprint 2 model corrections are stable.**

| WI | Title | Priority | Deps |
|----|-------|----------|------|
| **WI-0823** | NHL unified goalie signal — consolidate GSaX + SV% into one composite | High | WI-0820 |
| **WI-0824** | Two-layer bet execution gate — model fair prob ≠ executable edge | High | WI-0820 |
| **WI-0815** | Edge sanity clamp → watchdog `CAUTION` propagation in `computeTotalEdge` | Medium | none |
| **WI-0818** | Price staleness warning on hard-locked cards with stale price | Medium | none |
| **WI-0837** | ESPN null metrics alerting — Discord warning + `[ESPN_NULL]` log | Medium | none |
| **WI-0841** | NBA impact players — replace static 41-name set with ESPN injury-feed tier | Medium | none |

**Sprint 3 done when:** Goalie double-counting eliminated; execution gate rejects cards with no positive net edge; operators alerted on ESPN null and stale price.

---

## Sprint 4 — Calibration, Bet Sizing & CLV
**~1 week | Start after Sprint 3 execution gate (WI-0824) is live.**

| WI | Title | Priority | Deps |
|----|-------|----------|------|
| **WI-0825** | Per-market Brier/ECE calibration tracking with kill switch | High | WI-0820, WI-0824 |
| **WI-0819** | Quarter-Kelly stake fraction on PLAY/LEAN card payloads | High | WI-0813 |
| **WI-0826** | CLV + firing/winning monitoring — extend DB + worker, expose to dashboard | High | WI-0824 |
| **WI-0838** | CLV first-seen price lock — freeze `odds_at_pick` at card creation | Medium | WI-0812 |
| **WI-0809** | Rolling cohort windows (14/30/60/90d) in decision-tier calibration report | Medium | none |
| **WI-0811** | Book-to-book mispricing scanner — deterministic `MispricingCandidate` emitter | Medium | none |

**Sprint 4 done when:** Calibration kill switch suppressing bad markets; Kelly fractions on payloads; CLV trackable from Day 1 of new card cycle.

---

## Sprint 5 — Advanced Model Architecture
**~1–2 weeks | Requires Sprints 1–2 to be fully stable. High regression risk — full test coverage required before merge.**

| WI | Title | Priority | Deps |
|----|-------|----------|------|
| **WI-0830** | Additive z-score model core — shared bounded scoring framework (NBA/NHL/MLB) | High | WI-0820, WI-0821, WI-0822, WI-0823 |
| **WI-0831** | Isotonic regression calibration — fit per-market calibrator, apply at inference | High | WI-0825 |
| **WI-0832** | Backtest closing-line substitution removal — enforce pre-game odds only | High | none |
| **WI-0829** | Residual modeling layer — predict fair line vs market line delta | Medium | WI-0822, WI-0823, WI-0824, WI-0826 |

**Sprint 5 done when:** All sport models produce a bounded `modelScore in (0,1)` via additive z-score path; backtests no longer use closing lines.

---

## Sprint 6 — CI Hardening & Risk Recalibration
**Ongoing | Can run in parallel with Sprints 4–5.**

| WI | Title | Priority | Deps |
|----|-------|----------|------|
| **WI-0827** | Feature timestamp audit — block any feature with `available_at > bet_placed_at` | High | none |
| **WI-0828** | CI ablation tests + standardized model output interface | Medium | none |
| **WI-0833** | Feature correlation cluster detection in CI — fail on |r| >= 0.80 | Medium | WI-0823 |
| **WI-0834** | Risk recalibration — re-run Monte Carlo notebook with empirical edge distribution | Medium | WI-0825, WI-0831 |

---

## Dependency Graph

```
WI-0820 (NO_BET gate) -------------------------------------------------+
  +-- WI-0821 (MLB offense)                                             |
  +-- WI-0822 (NBA pace) ----------------------------------------+      |
  +-- WI-0823 (NHL goalie) --------------------------------------+  |      |
  +-- WI-0824 (exec gate) ------------+                          |  |      |
                                       +-- WI-0825 ------------> +--+---> WI-0830
WI-0812 (dedup) -------- WI-0838 (CLV lock)  +-- WI-0831
WI-0813 (vig fix) ------ WI-0819 (Kelly)  +-- WI-0826 -----------------> WI-0829
WI-0835 (sigma prov) --- WI-0814 / WI-0839
```

---

## Accumulated Context

### Pending Todos

- `2` pending todos in `.planning/todos/pending/`
- `2026-02-28-per-sport-model-health-agents-nba-nhl-ncaam-agents-own-model-health-checks.md`
- `2026-04-02-add-live-player-props-regression-coverage.md`

### Recently Completed (quick tasks 118–140)

See [COMPLETED_SPRINT_LOG.md](./COMPLETED_SPRINT_LOG.md) for full archive.
Notable: WI-0797 (pipeline health Discord watchdog), WI-0798 (NHL season key fix), WI-0810 (residual vig removal), WI-0799 (admin dashboard streak badges), quick tasks 131–140 (scheduler wiring, BLK audit, projection audit tests, quota-aware odds freshness, two-sided vig fix).

---

## Review Cadence

- Last reviewed: **2026-04-06**
- Next action: Begin Sprint 1. Claim **WI-0820 first** (Critical — gates Sprints 2–5). WI-0812, WI-0817, WI-0816, WI-0835 may be claimed in parallel.
- Next sprint review: After Sprint 1 closes (~2026-04-13).
