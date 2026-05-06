---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Model Integrity & Betting Execution Hardening
status: active
last_updated: "2026-05-06T02:11:24Z"
last_activity: "2026-05-05 - WI-1225 executed: resolvePrimaryReason explicit null-edge vs residual PASS fallback routing with EDGE_INSUFFICIENT family regression coverage"
---

# Project State

This file is the authoritative sprint plan. Agents must read it before claiming any work item.
Historical quick-task completions: [COMPLETED_SPRINT_LOG.md](./COMPLETED_SPRINT_LOG.md).

## Latest Activity

- **2026-05-05 — WI-1225 executed:** Removed reliance on the historical silent `SUPPORT_BELOW_PLAY_THRESHOLD` fallback by preserving explicit helper routing (`PASS_MISSING_EDGE` for null-edge, `PASS_NO_EDGE` for defensive computed-edge residual PASS states), documented the test-only helper export marker, added regression coverage to ensure both fallback codes remain in `EDGE_INSUFFICIENT`, asserted `PASS_NO_EDGE` stays out of normal `buildDecisionV2()` outcomes, and added a source-level guard against reintroducing the unconditional fallback pattern.
- **2026-05-04 — WI-1222 executed:** Added ADR-0018 documenting NHL card_payloads-only persistence, updated `/api/model-outputs` route source with explicit ADR-linked NHL omission note, tightened writer contract test to enforce NHL exclusion + ADR route reference, and replaced NHL worker `model_outputs` tolerance check with a strict zero-row regression guard.
- **2026-05-04 — WI-1269 completed:** Non-destructive quarantine classification of historical display-enrollment debt with date-based cutoff (2026-05-01T00:00:00Z); implements three-bucket model (LEGACY_QUARANTINED, CURRENT_PATH_DEFECT, UNKNOWN_UNCLASSIFIED); preserves immutable forensic audit trail; test suite passes 5/5; addendum documentation committed with non-destructive guarantees (no payload mutation, no deletion, no backdating); ready for stakeholder acceptance and deployment.
- **2026-04-30 — WI-1181 reclaimed:** Found a remaining consumer-side contract gap where opposite-side NHL moneyline candidates could still score via complement math even when `model_signal.selection_side` chose the other side; patch in progress to fail closed with `MODEL_SIGNAL_INCOMPLETE` + `SELECTION_SIDE_MISMATCH`.
- **2026-04-30 — WI-1218 claimed:** Scoped migration hardening is in progress to remove inline `ALTER TABLE` guards from `packages/data/src/db/cards.js`, add `090_add_card_payloads_actual_result.sql`, and add a CI grep gate for inline DDL under `packages/data/src/db/**`.
- **2026-04-25 — WI-1181 completed:** NHL producer now emits normalized MONEYLINE `model_signal` payloads with explicit blocker semantics (`NO_MARKET_LINE`, `GOALIE_CONTEXT_MISSING`, etc.) for non-actionable rows; model_signal wiring now covers both `nhl-model-output` and `nhl-moneyline-call`; verification passed with `npm --prefix apps/worker run test -- 'src/jobs/__tests__/run_nhl_model*.test.js' --runInBand`, `npm --prefix apps/worker run test -- src/jobs/potd/__tests__/signal-engine.test.js --runInBand`, and `npm --prefix apps/worker run test -- src/jobs/potd/ --runInBand` (159 tests).
- **2026-04-25 — WI-1180 completed:** POTD now emits explicit `MODEL_SIGNAL_INCOMPLETE` diagnostics for contract-`MODEL` markets when model payload rows are present but non-actionable; runner audit now surfaces `MODEL_SIGNAL_INCOMPLETE` as a first-class rejection reason; full POTD suite verification passed (`npm --prefix apps/worker run test -- src/jobs/potd/ --runInBand`, 159 tests).
- **2026-04-25 — WI-1178 completed:** POTD NBA TOTAL edge now uses sigma-based `computeTotalEdge()` instead of the uncalibrated `/20` shortcut; `totalScore` now includes positive-only normalized edge across all scoring branches; NBA TOTAL noise floor default is `0.03`. Verification: `npm --prefix apps/worker run test -- src/jobs/potd/__tests__/signal-engine.test.js --runInBand` passed with 76 tests, and `npm --prefix apps/worker run test -- src/jobs/potd/ --runInBand --silent` passed with 156 tests.

## Authoritative Source of Truth

- Active and upcoming work: `WORK_QUEUE/WI-####.md`
- Completed work: `WORK_QUEUE/COMPLETE/WI-####.md`
- Sprint history: `.planning/COMPLETED_SPRINT_LOG.md`
- Work-item scope/acceptance always governs completion status.

---

## Remaining WORK_QUEUE Snapshot (Authoritative as of 2026-04-19)

This snapshot reflects the current remaining work list provided by the operator and should be treated as the active priority pool for planning and claims.

### Frozen (Do Not Claim)

- FPL: WI-0662, WI-0705, WI-0706, WI-0708, WI-0709, WI-0710
- NFL: WI-0766
- Auth: WI-0794, WI-0795, WI-0796

### Non-Frozen Remaining WIs

- WI-0834
- WI-0895
- WI-0896
- WI-0904
- WI-0938
- WI-0969
- WI-0970
- WI-0971
- WI-0972
- WI-0973
- WI-1013
- WI-1016
- WI-1018
- WI-1019
- WI-1020
- WI-1021
- WI-1022
- WI-1023
- WI-1024
- WI-1025
- WI-1026
- WI-1027
- WI-1028
- WI-1029
- WI-1034
- WI-1034-a
- WI-1034-b
- WI-1034-c

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
| **WI-0836** | ~~Rest-days pipeline — compute `homeRest`/`awayRest`, thread into NBA + NHL models~~ | ~~Medium~~ COMPLETE (2026-04-08) | none |
| ~~**WI-0840**~~ | ~~MLB dynamic league constants — replace hardcoded 2024 averages with live season stats~~ | ~~Medium~~ COMPLETE (2026-04-08) | — |

**Sprint 2 done when:** All 7 items land, CI green, no model test regressions.

---

## Sprint 3 — Signal Quality & Operational Observability
**~1 week | Start after Sprint 2 model corrections are stable.**

| WI | Title | Priority | Deps |
|----|-------|----------|------|
| ~~**WI-0823**~~ | ~~NHL unified goalie signal — consolidate GSaX + SV% into one composite~~ | ~~High~~ COMPLETE (2026-04-09) | WI-0820 |
| **WI-0824** | Two-layer bet execution gate — model fair prob ≠ executable edge | High | WI-0820 |
| ~~**WI-0815**~~ | ~~Edge sanity clamp → watchdog `CAUTION` propagation in `computeTotalEdge`~~ | ~~Medium~~ COMPLETE (2026-04-09) | none |
| ~~**WI-0818**~~ | ~~Price staleness warning on hard-locked cards with stale price~~ | ~~Medium~~ COMPLETE (2026-04-09) | none |
| **WI-0837** | ESPN null metrics alerting — Discord warning + `[ESPN_NULL]` log | Medium | none |
| ~~**WI-0841**~~ | ~~NBA impact players — replace static 41-name set with ESPN injury-feed tier~~ | ~~Medium~~ COMPLETE (2026-04-09) | — |

**Sprint 3 done when:** Goalie double-counting eliminated; execution gate rejects cards with no positive net edge; operators alerted on ESPN null and stale price.

---

## Sprint 4 — Calibration, Bet Sizing & CLV
**~1 week | Start after Sprint 3 execution gate (WI-0824) is live.**

| WI | Title | Priority | Deps |
|----|-------|----------|------|
| ~~**WI-0826**~~ | ~~CLV + firing/winning monitoring — extend DB + worker, expose to dashboard~~ | ~~High~~ COMPLETE (2026-04-10) | WI-0824 |
| ~~**WI-0819**~~ | ~~Quarter-Kelly stake fraction on PLAY/LEAN card payloads~~ | ~~High~~ COMPLETE (2026-04-10) | WI-0813 |
| ~~**WI-0838**~~ | ~~CLV first-seen price lock — freeze `odds_at_pick` at card creation~~ | ~~Medium~~ COMPLETE (2026-04-10) | WI-0812 |
| ~~**WI-0809**~~ | ~~Rolling cohort windows (14/30/60/90d) in decision-tier calibration report~~ | ~~Medium~~ COMPLETE (2026-04-10) | none |
| ~~**WI-0811**~~ | ~~Book-to-book mispricing scanner — deterministic `MispricingCandidate` emitter~~ | ~~Medium~~ COMPLETE (2026-04-10) | none |

**Execution waves:**

| Wave | WIs (run in parallel) | Notes |
|------|-----------------------|-------|
| 1 | WI-0809, WI-0811, WI-0819, WI-0825, WI-0838 | All independent of each other |
| 2 | WI-0826 | Requires WI-0825 (calibration tables) and WI-0838 (accurate `clv_ledger.odds_at_pick`) |

**Sprint 4 done when:** Calibration kill switch suppressing bad markets; Kelly fractions on payloads; CLV trackable from Day 1 of new card cycle.

---

## Sprint 5 — Advanced Model Architecture
**~1–2 weeks | Requires Sprints 1–2 to be fully stable. High regression risk — full test coverage required before merge.**

| WI | Title | Priority | Deps |
|----|-------|----------|------|
| ~~**WI-0830**~~ | ~~Additive z-score model core — shared bounded scoring framework (NBA/NHL/MLB)~~ | ~~High~~ COMPLETE (2025-07-25) | WI-0820, WI-0821, WI-0822, WI-0823 |
| ~~**WI-0831**~~ | ~~Isotonic regression calibration — fit per-market calibrator, apply at inference~~ | ~~High~~ COMPLETE (2025-07-25) | WI-0825 |
| **WI-0832** | Backtest closing-line substitution removal — enforce pre-game odds only | High | none |
| ~~**WI-0829**~~ | ~~Residual modeling layer — predict fair line vs market line delta~~ | ~~Medium~~ COMPLETE (2025-07-25) | WI-0822, WI-0823, WI-0824, WI-0826 |

**Sprint 5 done when:** All sport models produce a bounded `modelScore in (0,1)` via additive z-score path; backtests no longer use closing lines.

---

## Sprint 6 — CI Hardening & Risk Recalibration
**Ongoing | Can run in parallel with Sprints 4–5.**

| WI | Title | Priority | Deps |
|----|-------|----------|------|
| ~~**WI-0827**~~ | ~~Feature timestamp audit — block any feature with `available_at > bet_placed_at`~~ | ~~High~~ COMPLETE via WI-1038 (2026-04-20) | none |
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

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 174 | WI-1139 Add Frozen-Domain Fail-Closed Runtime Guards NFL and FPL Sage | 2026-04-23 | 5ad9ea44 | [174-wi-1139-add-frozen-domain-fail-closed-ru](./quick/174-wi-1139-add-frozen-domain-fail-closed-ru/) |
| 173 | WI-1143 Unify projection confidence tier — ConfidenceTier type + normalizeToConfidenceTier, confidenceTier field on ProjectionProxyRow | 2026-04-23 | 55b3f9c0 | [173-wi-1143-unify-projection-confidence-tier](./quick/173-wi-1143-unify-projection-confidence-tier/) |
| 172 | WI-1138 Retire dual-DB runtime paths | 2026-04-23 | 5e2170c0 | [172-wi-1138-retire-dual-db-runtime-paths](./quick/172-wi-1138-retire-dual-db-runtime-paths/) |
| 171 | WI-1135: Decompose API Results Route And Isolate Reporting Workloads | 2026-04-23 | e0a6b433 | [171-wi-1135-decompose-api-results-route-and-](./quick/171-wi-1135-decompose-api-results-route-and-/) |
| 170 | WI-1025: NBA Phase 3B — Regime detection with measurable triggers | 2026-04-21 | 630feeb9 | [170-wi-1025](./quick/170-wi-1025/) |
| 169 | WI-1024: NBA Phase 3A — Residual learning layer for total projection | 2026-04-21 | 7818c7e3 | [169-wi-1024-nba-phase-3a-residual-learning-l](./quick/169-wi-1024-nba-phase-3a-residual-learning-l/) |
| 168 | Document and gate initDualDb activation path | 2026-04-20 | cc9b8167 | [168-document-and-gate-initdualdb-activation-](./quick/168-document-and-gate-initdualdb-activation-/) |
| 167 | WI-1015: Complete status→action migration in card transform | 2026-04-20 | 3b62cb2d | [167-wi-1015](./quick/167-wi-1015/) |
| 166 | WI-1014: Delete orphaned canonical-decision.ts (deletion path) | 2026-04-20 | d506ce23 | [166-wi-1014](./quick/166-wi-1014/) |
| 165 | WI-1013: Resolve stale reason code alias confusion | 2026-04-20 | 4616cc1b | [165-wi-1013-resolve-stale-reason-code-alias-](./quick/165-wi-1013-resolve-stale-reason-code-alias-/) |
| 164 | WI-1039: Discord Webhook Optimization — Market Filtering, POTD Integration, Rate-Limit Retry | 2026-04-20 | 091b593f | [164-wi-1039-discord-webhook-optimization-mar](./quick/164-wi-1039-discord-webhook-optimization-mar/) |
| 163 | Fix duplicate ApiPlay interface in legacy-repair.ts | 2026-04-19 | 32ad847d | [163-fix-duplicate-apiplay-interface-in-legac](./quick/163-fix-duplicate-apiplay-interface-in-legac/) |
| 162 | Dead code removal sweep — deprecated exports and leftover shims | 2026-04-19 | 4b936849 | [162-dead-code-removal-sweep-deprecated-expor](./quick/162-dead-code-removal-sweep-deprecated-expor/) |
| 161 | WI-0982: MLB full-game WATCH/HOLD auto-close pipeline integration tests | 2026-04-17 | 8c9ecd0b | [161-mlb-full-game-settlement-display-log-eli](./quick/161-mlb-full-game-settlement-display-log-eli/) |
| 160 | WI-0951: MLB T-Minus Freshness Override Schedule | 2026-04-16 | 8f8356a9 | [160-wi-0951-mlb-t-minus-freshness-override-s](./quick/160-wi-0951-mlb-t-minus-freshness-override-s/) |
| 159 | WI-0911 NHL Player Blocks Projection Settlement Policy | 2026-04-13 | ed879b5 | [159-wi-0911-nhl-player-blocks-projection-set](./quick/159-wi-0911-nhl-player-blocks-projection-set/) |
| 158 | WI-0902 Endpoint Behavioral Parity Fixtures for Cards and Games | 2026-04-13 | af624ff | [158-wi-0902-endpoint-behavioral-parity-fixtu](./quick/158-wi-0902-endpoint-behavioral-parity-fixtu/) |
| 157 | WI-0893 End-to-end drop reason ledger — worker gate taxonomy, API diagnostics drop_summary, transform_meta.drop_reason, CardsPageContext diagnostics surface | 2026-04-12 | 4857ecb | [157-wi-0893-add-end-to-end-odds-to-surface-d](./quick/157-wi-0893-add-end-to-end-odds-to-surface-d/) |
| 156 | WI-0910 NHL 1P player-shots settlement completeness guard | 2026-04-12 | f1d1903 | [156-wi-0910-nhl-player-shots-1p-settlement-c](./quick/156-wi-0910-nhl-player-shots-1p-settlement-c/) |
| 155 | WI-0909 NHL player-shots full-game settlement source unification | 2026-04-12 | e92e444 | [155-wi-0909-nhl-player-shots-full-game-settl](./quick/155-wi-0909-nhl-player-shots-full-game-settl/) |
| 156 | WI-0881: Wire NHL goalie composite into POTD signal — resolveNHLModelSignal, getLatestNhlModelOutput, nhlSnapshot wiring, 22 new tests | 2026-04-11 | 096653b | [154-wire-nhl-goalie-composite-into-potd-sign](./quick/154-wire-nhl-goalie-composite-into-potd-sign/) |
| 155 | WI-0884: POTD multi-day sanity tracking — potd_daily_stats migration 075, stats writes on all engine paths, sanity-check script, 3 new tests | 2026-04-11 | a8f5360 | [152-wi-0884-potd-multi-day-sanity-tracking](./quick/152-wi-0884-potd-multi-day-sanity-tracking/) |
| 154 | WI-0883 POTD confidence-weighted sizing — confidenceMultiplier, migration 074, 4 new tests | 2026-04-11 | 0db8488 | [151-wi-0883-potd-confidence-weighted-sizing](./quick/151-wi-0883-potd-confidence-weighted-sizing/) |
| 153 | WI-0880 Add h2h market to NHL odds fetch | 2026-04-11 | 66e8269 | [150-wi-0880-add-h2h-market-to-nhl-odds-fetch](./quick/150-wi-0880-add-h2h-market-to-nhl-odds-fetch/) |
| 152 | WI-0879: POTD reasoning string — deterministic builder, migration 073, web surface (api + UI card) | 2026-04-12 | 30d4b13 | [WI-0879](./phases/WI-0879/) |
| 151 | WI-0833: feature_correlation_check.js audit script — 3-tier threshold, suppression expiry, 8 tests | 2026-04-11 | fdd5ba4 | [149-wi-0833-feature-correlation-cluster-dete](./quick/149-wi-0833-feature-correlation-cluster-dete/) |
| 150 | WI-0833: feature correlation cluster detection in CI — pearsonR module, NBA/NHL/MLB fixture gate, CI step | 2026-04-11 | e5384ca | [148-wi-0833-feature-correlation-cluster-dete](./quick/148-wi-0833-feature-correlation-cluster-dete/) |
| 149 | WI-0874: POTD MLB integration — resolveMLBModelSignal + scoreCandidate MLB override path, 6 new tests | 2026-04-11 | 4d2136b | [147-wi-0874-potd-mlb-integration-wire-mlb-ed](./quick/147-wi-0874-potd-mlb-integration-wire-mlb-ed/) |
| 148 | WI-0873: implement projectFullGameML — full-game ML win probability model, full_game_ml driver card, 5 new tests | 2026-04-11 | 9c7f87f | [146-wi-0873-implement-projectfullgameml-full](./quick/146-wi-0873-implement-projectfullgameml-full/) |
| 147 | WI-0878: POTD signal-engine sport-fairness fixes — lineDelta normalization, fixed-line fallback, per-sport pool | 2026-04-11 | ffe2e93 | [145-potd-signal-engine-sport-fairness-fixes](./quick/145-potd-signal-engine-sport-fairness-fixes/) |
| 146 | WI-0871: Fix F5 ML formula — align projectF5ML with projectTeamF5RunsAgainstStarter shared run path | 2026-04-11 | 702c77c | [WI-0871](../.planning/phases/WI-0871/) |
| 145 | WI-0856: /api/market-pulse route with 4.5-min server cache | 2026-04-10 | 3f0f608 | [WI-0856](../.planning/phases/WI-0856/) |
| 144 | WI-0819: quarter-Kelly stake fraction on PLAY/LEAN card payloads | 2026-04-10 | c52c2ad | [WI-0819](../.planning/phases/WI-0819/) |
| 144 | WI-0842 + WI-0843: settlement expiry sweep and card_results dedup | 2026-04-10 | a97c1ff | [144-wi-0842-wi-0843](./quick/144-wi-0842-wi-0843-settlement-expiry-sweep-/) |
| 143 | WI-0825: calibration tracking, report job, and execution-gate kill switch | 2026-04-10 | local | [143-wi-0825](./quick/143-wi-0825/) |
| 142 | WI-0823: NHL unified goalie signal — consolidate GSaX and SV% into one score | 2026-04-09 | 77b726e | [142-wi-0823-nhl-unified-goalie-signal-consol](./quick/142-wi-0823-nhl-unified-goalie-signal-consol/) |

---

## Review Cadence

- Last reviewed: **2026-04-15**
- Next action: WI-0941 complete. All acceptance criteria met. Next available: WI-0939 deps or any Sprint items.
- Last session: **2026-04-15T01:13:00Z** — Completed WI-0941 (NBA blocking remediation: decision_v2 consistency, NBA diagnostics, quarantine closure)
