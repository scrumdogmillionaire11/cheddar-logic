# Project State

This file is intentionally minimal to avoid stale status drift.

## Authoritative Source of Truth

- Active and upcoming work: `WORK_QUEUE/WI-####.md`
- Completed work: `WORK_QUEUE/COMPLETE/WI-####.md`
- Work-item scope/acceptance always governs completion status.

## How To Read Current Project Status

- What is in progress: claimed items in `WORK_QUEUE/`
- What is done: items moved to `WORK_QUEUE/COMPLETE/`
- What is obsolete/superseded: explicit status notes inside the WI file

## Review Cadence

- Last reviewed: 2026-03-23
- Next action for operators/agents: Hostile audit (WI-0572) complete — 2 CRITICAL + 4 HIGH defects found in live decision pipeline. NHL props pipeline audit (2026-03-23) added 5 CRITICAL + 4 HIGH + 3 MEDIUM findings (WI-0573–WI-0584). **Start with WI-0573** (negative American price display broken in `/api/games`) — that is broken in prod right now.

---

## Sprint Plan — 2026-03-23 re-prioritization

### Dependency Chains (respect order within chains)
- **Audit fixes (parallel, independent):** AUDIT-FIX-01, AUDIT-FIX-02, AUDIT-FIX-03, AUDIT-FIX-04, AUDIT-FIX-05, AUDIT-FIX-06
- **Edge math stack (serial):** ~~WI-0551~~✓ → ~~WI-0552~~✓ → WI-0554 → WI-0556 → WI-0553
- **Auth/JWT:** ~~WI-0559~~✓ → ~~WI-0560~~✓ (both done)
- **Settlement → CLV (serial):** WI-0564 → WI-0566 → WI-0557
- **Market evaluator (serial):** WI-0568 → WI-0569 / WI-0570 → WI-0571
- **All others:** independent, can be parallelized across agents

---

### Historical Tier 1 — Security & Edge Math (all DONE ✓)

| WI | Summary | Status |
|---|---|---|
| ~~[WI-0560](../WORK_QUEUE/COMPLETE/WI-0560.md)~~ | Fail closed when `AUTH_SECRET` missing/default in prod | ✓ DONE (qt-65) |
| ~~[WI-0559](../WORK_QUEUE/COMPLETE/WI-0559.md)~~ | Fix JWT HS256 signature to RFC-compliant base64url | ✓ DONE (qt-65) |
| ~~[WI-0561](../WORK_QUEUE/COMPLETE/WI-0561.md)~~ | Upgrade Next.js 16.1.6 → 16.2.1 (zero CVEs) | ✓ DONE (qt-66) |
| ~~[WI-0551](../WORK_QUEUE/COMPLETE/WI-0551.md)~~ | Remove vig from implied probability (edge math baseline) | ✓ DONE (qt-66) |
| ~~[WI-0555](../WORK_QUEUE/COMPLETE/WI-0555.md)~~ | Unify spread threshold + enable `MARKET_THRESHOLDS_V2` | ✓ DONE (qt-66) |
| ~~[WI-0552](../WORK_QUEUE/COMPLETE/WI-0552.md)~~ | Empirical sigma from game history (replace hardcoded 12/14) | ✓ DONE (qt-67) |
| ~~[WI-0572](../WORK_QUEUE/WI-0572.md)~~ | Hostile audit — betting decision pipeline (10 findings) | ✓ DONE (2026-03-23) |

---

### Tier 0 — Audit-Derived Critical/High Fixes (create WIs first, do before Tier 1)

> Source: [hostile-betting-pipeline-audit-2026-03.md](../docs/runbooks/hostile-betting-pipeline-audit-2026-03.md)
> Each item needs its own WI file before implementation starts. All are independent (no cross-dependencies).

| Priority | Placeholder | Finding | Severity | Target file |
|---|---|---|---|---|
| 1 | AUDIT-FIX-01 | NHL OVER edge suppressed by spurious `+0.5` line adjustment — every NHL OVER total loses ~0.02–0.04 edge silently | **CRITICAL** | `packages/models/src/edge-calculator.js` |
| 2 | AUDIT-FIX-02 | Silent exception swallow in `buildDecisionV2` — parse failures become `DEGRADED` with no log, masking real errors | **CRITICAL** | `packages/models/src/decision-pipeline-v2.js` |
| 3 | AUDIT-FIX-03 | `truePlayMap` first-come ordering — stale LEAN shadows a fresh FIRE for the same game | **HIGH** | `packages/models/src/decision-pipeline-v2.js` |
| 4 | AUDIT-FIX-04 | `shouldFlip` coerces null edge to `0` via `?? 0` — phantom flip when `edge_available=true` but edge is null | **HIGH** | `packages/models/src/decision-gate.js` |
| 5 | AUDIT-FIX-05 | `reason_codes` accumulates monotonically, never purged — stale codes contradict current card status | **HIGH** | `apps/worker/src/utils/decision-publisher.js` |
| 6 | AUDIT-FIX-06 | `EVIDENCE` cards carry permanent `PASS_UNREPAIRABLE_LEGACY` in `reason_codes`, never refreshed on re-evaluation | **HIGH** | `apps/worker/src/utils/decision-publisher.js` |

---

### Tier 0b — NHL Props Pipeline Audit Fixes (2026-03-23)

> Source: NHL player shot props pipeline audit — full trace from ingest → model → display.
> WI-0573–WI-0584. Critical/High items must land before treating NHL prop plays as actionable bets.

| Priority | WI | Finding | Severity | Target file(s) |
|---|---|---|---|---|
| 1 | [WI-0573](../WORK_QUEUE/WI-0573.md) | Negative American prices (`−110`, `−115`) passed to `decimalToAmerican()` — `> 10` check must be `Math.abs() > 10`; every prop price on display is currently wrong | **CRITICAL** | `web/src/app/api/games/route.ts` |
| 2 | [WI-0574](../WORK_QUEUE/WI-0574.md) | `selection.price` hardcoded to `−110` in full-game + 1P card payloads; real `over_price`/`under_price` from Odds API are stored but never wired to the canonical price field | **CRITICAL** | `apps/worker/src/jobs/run_nhl_player_shots_model.js` |
| 3 | [WI-0575](../WORK_QUEUE/WI-0575.md) | `opportunity_score` is always computed for the OVER direction regardless of V1 play direction; an UNDER call shows a positive OVER opportunity_score, contradicting the bet | **CRITICAL** | `apps/worker/src/models/nhl-player-shots.js` |
| 4 | [WI-0576](../WORK_QUEUE/WI-0576.md) | `NHL_SOG_PROP_EVENTS_ENABLED` defaults false — real Odds API lines are never ingested unless explicitly set; all cards run on synthetic `2.5` floor line silently | **CRITICAL** | `apps/worker/src/jobs/pull_nhl_player_shots_props.js`, `.env` |
| 5 | [WI-0577](../WORK_QUEUE/WI-0577.md) | V1 drives bet decision; V2 Poisson edge is computed but never gates FIRE — V1 can emit a PLAY while V2's `edge_over_pp` is negative; add V2 veto gate for FIRE on odds-backed cards | **CRITICAL** | `apps/worker/src/jobs/run_nhl_player_shots_model.js` |
| 6 | [WI-0578](../WORK_QUEUE/WI-0578.md) | `PP_RATE_MISSING` flag set but PP component silently collapses to 0 for top PP players; under-projects by 0.3–0.5 SOG for players with non-zero `ppToi` | **HIGH** | `apps/worker/src/jobs/run_nhl_player_shots_model.js` |
| 7 | [WI-0579](../WORK_QUEUE/WI-0579.md) | 1P cards don't run `projectSogV2`; `v2AnomalyDetected` from full-game run is reused against 1P mu, which uses a different (scaled) projection | **HIGH** | `apps/worker/src/jobs/run_nhl_player_shots_model.js` |
| 8 | [WI-0580](../WORK_QUEUE/WI-0580.md) | PROP cards are not wave-1 eligible — `decision_v2.official_status` does not override V1 `action`/`status` because `PROP` is not in `WAVE1_MARKETS`; V1 classification wins unconditionally | **HIGH** | `web/src/app/api/games/route.ts` |
| 9 | [WI-0581](../WORK_QUEUE/WI-0581.md) | `edge_pct` in `decision_v2` is `(mu−line)/line×100` (projection-delta %) while V2 `edge_over_pp` is probability edge (p_fair−p_implied); both surface as "edge" — rename `decision_v2.edge_pct` → `edge_delta_pct` for clarity | **HIGH** | `apps/worker/src/jobs/run_nhl_player_shots_model.js` |
| 10 | [WI-0582](../WORK_QUEUE/WI-0582.md) | `opponentFactor`/`paceFactor` silently default to `1.0` at `console.debug` when `team_metrics_cache` is empty after a refresh failure; should be `console.warn` and surfaced in card flags | **MEDIUM** | `apps/worker/src/jobs/run_nhl_player_shots_model.js` |
| 11 | [WI-0583](../WORK_QUEUE/WI-0583.md) | V1 (recency-decay blend) and V2 (rate-weighted blend) produce different mu from the same data with no reconciliation or accuracy audit; calibration study needed | **MEDIUM** | `apps/worker/src/models/nhl-player-shots.js` |
| 12 | [WI-0584](../WORK_QUEUE/WI-0584.md) | Line change between model runs can surface two cards for the same player/side if `purgePlayerCardsForGame` fails silently; dedup key differs on `dedupeLine`, bypassing `seenNhlShotsPlayKeys` | **MEDIUM** | `web/src/app/api/games/route.ts`, `apps/worker/src/jobs/run_nhl_player_shots_model.js` |

---

### Tier 1 — Edge Model Correctness & CI Integrity

| Order | WI | Summary | Depends on |
|---|---|---|---|
| 7 | [WI-0554](../WORK_QUEUE/WI-0554.md) | Computed confidence function (replace 0.95/0.88/0.85 literals) | WI-0551 ✓, WI-0552 ✓ — **unblocked** |
| 8 | [WI-0562](../WORK_QUEUE/WI-0562.md) | Isolate mutating web tests to temp DB (prevent CI prod mutation) | — |
| 9 | [WI-0558](../WORK_QUEUE/WI-0558.md) | Stabilize smoke/contract tests — deterministic CI with no local server | — |

---

### Tier 2 — Feature Completions

| Order | WI | Summary | Depends on |
|---|---|---|---|
| 10 | [WI-0563](../WORK_QUEUE/WI-0563.md) | API security on `/api/cards/[gameId]` + SQLi regression tests | — |
| 11 | [WI-0564](../WORK_QUEUE/WI-0564.md) | Soccer settlement — ingest final scores, grade ML/total/spread cards | — |
| 12 | [WI-0553](../WORK_QUEUE/WI-0553.md) | Gate FIRST_PERIOD on edge (not projection signal) | WI-0554 |
| 13 | [WI-0556](../WORK_QUEUE/WI-0556.md) | Track line movement delta to detect stale-edge cards | WI-0554 |
| 14 | [WI-0566](../WORK_QUEUE/WI-0566.md) | Player props settlement framework generalization | WI-0564 |
| 15 | [WI-0557](../WORK_QUEUE/WI-0557.md) | Wire CLV feedback loop (`ENABLE_CLV_LEDGER`) | WI-0564 |

---

### Tier 3 — Market Evaluator Layer (serial chain)

| Order | WI | Summary | Depends on |
|---|---|---|---|
| 16 | [WI-0568](../WORK_QUEUE/WI-0568.md) | Market evaluator — consensus layer (median line/price, dispersion, confidence) | — |
| 17 | [WI-0569](../WORK_QUEUE/WI-0569.md) | Market evaluator — execution selector for all markets (best-price separate from best-line) | WI-0568 |
| 18 | [WI-0570](../WORK_QUEUE/WI-0570.md) | Market evaluator — misprice detector (soft line, price-only, high-dispersion flags) | WI-0568 |
| 19 | [WI-0571](../WORK_QUEUE/WI-0571.md) | Market evaluator — projection comparator (edge vs consensus, edge vs best available, execution alpha) | WI-0568, WI-0569 |

---

### Tier 4 — Polish / Display

| Order | WI | Summary | Depends on |
|---|---|---|---|
| 20 | [WI-0567](../WORK_QUEUE/WI-0567.md) | Surface 1P vs full-game label on /results page | — |

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 29 | WI-0444 Production Main DB Corruption Triage | 2026-03-13 | 21c1cf0 | [29-wi-0444-production-main-db-corruption-tr](./quick/29-wi-0444-production-main-db-corruption-tr/) |
| 30 | WI-0433 Settlement Health Reporting for Prod Triage | 2026-03-13 | dbd5ac2 | [30-wi-0433-settlement-health-reporting-for-](./quick/30-wi-0433-settlement-health-reporting-for-/) |
| 31 | P1 Stability: Contract Correctness (WI-0398/0399/0408/0415) | 2026-03-13 | 94934a7 | [31-p1-stability-contract-correctness-wi-040](./quick/31-p1-stability-contract-correctness-wi-040/) |
| 32 | P2 NHL Decision Integrity Chain (WI-0382/0383) | 2026-03-13 | 444389e | [32-p2-nhl-decision-integrity-chain-wi-0384-](./quick/32-p2-nhl-decision-integrity-chain-wi-0384-/) |
| 33 | P3 NCAAM FT cleanup/investigation (WI-0405/0406/0407/0409) | 2026-03-13 | 97e6570 | [33-p3-ncaam-ft-cleanup-investigation-wi-040](./quick/33-p3-ncaam-ft-cleanup-investigation-wi-040/) |
| 34 | P0 Shield core cards/games surfaces — nhl_props run_state isolation (WI-0447) | 2026-03-14 | f268a6e | [34-p0-wi-0447-shield-core-cards-games-surfa](./quick/34-p0-wi-0447-shield-core-cards-games-surfa/) |
| 35 | WI-0448 Settlement Segmentation Record Traceability — lineage audit script + docs | 2026-03-14 | afeb71c | [35-wi-0448-settlement-segmentation-record-t](./quick/35-wi-0448-settlement-segmentation-record-t/) |
| 36 | WI-0449 SettleCards Run-Log Failure Remediation — safe error serialization + counter isolation | 2026-03-14 | af58e8b | [36-wi-0449-settlecards-run-log-failure-reme](./quick/36-wi-0449-settlecards-run-log-failure-reme/) |
| 37 | NHL player SOG prop market: real O/U lines from Odds API into player_prop_lines table + model runner integration | 2026-03-14 | bc63cc3 | [37-nhl-player-shots-prop-market-with-proces](./quick/37-nhl-player-shots-prop-market-with-proces/) |
| 38 | FPL Sage mobile decision-first layout: sticky header, collapsible advanced sections, scaled pitch cards | 2026-03-14 | 1f4fe86 | [38-fpl-sage-mobile-decision-first-layout](./quick/38-fpl-sage-mobile-decision-first-layout/) |
| 39 | WI-0453/WI-0454 NHL injury status filtering + model hardening (7 gaps) + prop expansion guide | 2026-03-14 | a03c027 | [39-wi-0453-nhl-injury-status-filtering-and-](./quick/39-wi-0453-nhl-injury-status-filtering-and-/) |
| 40 | Investigate failing prediction models: nhl-pace-totals (0% win rate) + ncaam-base-projection spread (27.8%) | 2026-03-14 | — (no code changes) | [40-investigate-failing-prediction-models-nh](./quick/40-investigate-failing-prediction-models-nh/) |
| 41 | Display play-type label on cards: cardType pill + recommended_bet_type chip in Signal Header Bar | 2026-03-14 | 74383e8 | [41-display-play-type-label-on-cards](./quick/41-display-play-type-label-on-cards/) |
| 42 | Rewrite WI-0437 top section for Tier 1 soccer hardening — Goal/Scope/Out-of-scope/Acceptance now unambiguous | 2026-03-14 | 5d7c02e | [42-update-wi-0437-plan-header-to-match-bott](./quick/42-update-wi-0437-plan-header-to-match-bott/) |
| 43 | new work item 0458 to audit the site for vulnerabilities and secure them | 2026-03-15 | 8f71ae2 | [43-new-work-item-0458-to-audit-the-site-for](./quick/43-new-work-item-0458-to-audit-the-site-for/) |
| 44 | WI-0437 Soccer Data Hardening Tier 1: Ohio scope router + Tier 1 packet builders + validator hard-bouncer | 2026-03-15 | 66da2d5 | [44-wi-0437-soccer-data-hardening-tier-1-mar](./quick/44-wi-0437-soccer-data-hardening-tier-1-mar/) |
| 45 | WI-0459 Soccer odds + projection-only market rework: two-track runner, soccer_ml/game_total/double_chance schemas, 34 tests | 2026-03-15 | 3b5b71d | [45-wi-0459-soccer-odds-projection-only-mark](./quick/45-wi-0459-soccer-odds-projection-only-mark/) |
| 46 | Soccer multi-league support: EPL + MLS + UCL via apiKeys array, tokensPerFetch 3→9, sequential fetch with merged results | 2026-03-15 | 1f986c0 | [46-soccer-multi-league-support-add-mls-and-](./quick/46-soccer-multi-league-support-add-mls-and-/) |
| 47 | WI-0456 Migrate DB layer from sql.js to better-sqlite3: WAL mode, native sync writes, full packages/data migration | 2026-03-16 | 43ac6e6 | [47-wi-0456-migrate-db-layer-from-sql-js-to-](./quick/47-wi-0456-migrate-db-layer-from-sql-js-to-/) |
| 48 | WI-0435 Projection/card write-and-read pipeline contract alignment: explicit CONTRACT block in card-payload.js + validator-to-route alignment note in DATA_CONTRACTS.md | 2026-03-16 | 8922015 | [48-wi-0435-projection-contract-alignment](./quick/48-wi-0435-projection-contract-alignment/) |
| 49 | WI-0389 MLB Pitcher Ks Research Spec Freeze: rewrote MLB-research.md as frozen 7-section implementation contract with 8 gates, full payload schema, 9 failure modes, 7 test vectors | 2026-03-17 | fea5aed | [49-wi-0389-mlb-pitcher-ks-research-spec-fre](./quick/49-wi-0389-mlb-pitcher-ks-research-spec-fre/) |
| 50 | WI-0477 Phase 2 Rollout Coordinator: verify WI-0479/0480 scopes and document dependency order and closeout gate | 2026-03-17 | 30a7654 | [50-wi-0477-phase-2-rollout-coordinator-veri](./quick/50-wi-0477-phase-2-rollout-coordinator-veri/) |
| 52 | WI-0527 Projection Anomaly Audit Layer: v2 anomaly flag + pricing nullification + extended drivers debug fields | 2026-03-20 | 002ff2a | [52-wi-0527-projection-anomaly-audit-layer](./quick/52-wi-0527-projection-anomaly-audit-layer/) |
| 53 | WI-0528 Fix PP TOI gap — replace hardcoded toi_proj_pp:0 with real avgPpToi from NHL API subSeason | 2026-03-20 | 20ee178 | [53-wi-0528-fix-pp-toi-gap-replace-hardcoded](./quick/53-wi-0528-fix-pp-toi-gap-replace-hardcoded/) |
| 54 | WI-0529 Decision layer for props: computePropDisplayState (PLAY/WATCH/PROJECTION_ONLY) in model job + transform.ts status override | 2026-03-20 | 4fea1d8 | [54-wi-0529-decision-layer-for-props-enforce](./quick/54-wi-0529-decision-layer-for-props-enforce/) |

| 55 | WI-0530 NST PP rate ingestion: player_pp_rates table + ingest_nst_pp_rates.js + ppRatePer60 enrichment + projectSogV2 wiring + 45% PP cap | 2026-03-20 | 398aa08 | [55-wi-0530-nst-ingestion-season-pp-rate-per](./quick/55-wi-0530-nst-ingestion-season-pp-rate-per/) |
| 56 | Sort player props view by day and start time, soonest first | 2026-03-20 | f20a6aa | [56-sort-player-props-view-by-day-and-start-](./quick/56-sort-player-props-view-by-day-and-start-/) |
| 57 | WI-0531 Rolling PP splits (L10/L5) + recency-weighted blend: 033 migration, NST ingestion, weightedRateBlendPP (0.40/0.35/0.25), PP_SMALL_SAMPLE flag, four PP driver fields | 2026-03-20 | f6689d7 | [57-wi-0531-rolling-splits-l10-l5-recency-we](./quick/57-wi-0531-rolling-splits-l10-l5-recency-we/) |

| 58 | Display odds on player prop cards: market_price_over/under plumbed through route.ts → transform → PropPlayRow → conditional "OVER X / UNDER Y" odds line in Model Snapshot block | 2026-03-20 | ead47cb | [58-display-odds-on-player-prop-cards-over-u](./quick/58-display-odds-on-player-prop-cards-over-u/) |
| 59 | Clean-up repo lint and TS errors (WI-0532): fixed 2 ESLint no-undef errors in settle_game_results.js SportsRef fallback — `reason` → `missReason` on lines 1490 and 1509; npm run lint + tsc --noEmit both exit 0 | 2026-03-20 | a9db360 | [59-clean-up-repo-lint-and-ts-errors-wi-0532](./quick/59-clean-up-repo-lint-and-ts-errors-wi-0532/) |
| 60 | Activate player props in production: NEXT_PUBLIC_ENABLE_PLAYER_PROPS=true in .env.production + .env.production.example — Pi rebuild + pm2 restart required to activate Props tab at cheddarlogic.com | 2026-03-20 | 7b572d3 | [60-activate-player-props-in-production](./quick/60-activate-player-props-in-production/) |
| 61 | WI-0536 Canonical Edge Contract: CANONICAL_EDGE_CONTRACT in decision-gate, edge=null in card-factory NBA/NHL, edge_units in pipeline + decision events, 3 new tests + 1 extended assertion | 2026-03-21 | 258b8cc | [61-wi-0536-canonical-edge-contract-unit-nor](./quick/61-wi-0536-canonical-edge-contract-unit-nor/) |
| 62 | WI-0547 WI Governance Reconciliation: owner/claim alignment for WI-0516/0517/0522/0537, README.md refreshed through WI-0537, WI-0522 removed from active AH list | 2026-03-21 | 8c9a645 | [62-wi-0547-wi-governance-reconciliation](./quick/62-wi-0547-wi-governance-reconciliation/) |
| 63 | WI-0548 Dev Run Reliability Follow-up: collision dedup (applyEventUseDedupRule), 11 MLS team variants, MISSING_MARKET_KEY auto-close, Discord skip logging, troubleshooting docs | 2026-03-22 | fc4ef8a | [63-wi-0548-dev-run-reliability-follow-up-se](./quick/63-wi-0548-dev-run-reliability-follow-up-se/) |
| 64 | WI-0550 NBA Spread Edge Gate: SPREAD_EDGE_MIN=0.02 guard blocks negative-EV spread cards; settlement 82% void rate diagnosed as legacy null market_key artifact; 4 unit tests | 2026-03-22 | 94868af | [64-wi-0550](./quick/64-wi-0550/) |
| 65 | WI-0559 + WI-0560 JWT security fixes: RFC-compliant HS256 signatures + fail-closed prod AUTH_SECRET guard | 2026-03-23 | c656a20 | [65-follow-sprint-plan-in-state](./quick/65-follow-sprint-plan-in-state/) |
| 66 | WI-0561 + WI-0551 + WI-0555: Next.js 16.2.1, noVigImplied vig removal, NBA spread gate via resolveThresholdProfile | 2026-03-23 | eb034c8 | [66-follow-sprint-plan-in-state](./quick/66-follow-sprint-plan-in-state/) |
| 67 | WI-0552: Empirical sigma from game history — computeSigmaFromHistory, getSigmaDefaults fallback docs, NBA model runner wiring | 2026-03-23 | b55095d | [67-follow-sprint-plan-in-state](./quick/67-follow-sprint-plan-in-state/) |
| 68 | Tier 0 audit-derived fixes AUDIT-FIX-01 through 05-06 | 2026-03-23 | 26b3d48 | [68-tier-0-audit-derived-fixes-audit-fix-01-](./quick/68-tier-0-audit-derived-fixes-audit-fix-01-/) |
| 69 | WI-0573 Fix negative American price display — Math.abs() guard in already-American detection | 2026-03-23 | 307e286 | [69-wi-0573-fix-negative-american-price-disp](./quick/69-wi-0573-fix-negative-american-price-disp/) |
| 70 | WI-0574 Wire real over_price/under_price into selection.price for full-game + 1P cards | 2026-03-23 | 69f91eb | [70-wi-0574-wire-real-over-price-under-price](./quick/70-wi-0574-wire-real-over-price-under-price/) |
| 72 | WI-0576 Default NHL_SOG_PROP_EVENTS_ENABLED to true — prevent silent synthetic-line fallback in production | 2026-03-23 | 5f7f2f1 | [72-wi-0576-default-nhl-sog-prop-events-enab](./quick/72-wi-0576-default-nhl-sog-prop-events-enab/) |

Last activity: 2026-03-23 - WI-0575 (direction-aware opportunity_score) + WI-0577 (V2 Poisson veto gate for 1P FIRE) complete. Next: WI-0578 PP_RATE_MISSING silent collapse HIGH.
