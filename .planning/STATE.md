---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: active
last_updated: "2026-03-28T12:00:00Z"
last_activity: "2026-03-28 - Priority re-assessment + gap: WI-0635/0636 slotted into P2 (deploy rollback fix). WI-0638 (remove NCAAM+Soccer from UI permanently) and WI-0639 (NFL UI seasonal gate) added to P3."
progress:
  total_phases: 4
  completed_phases: 3
  total_plans: 6
  completed_plans: 6
---

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

- Last reviewed: 2026-03-28
- Next action: **WI-0626** (P1 correctness — settle_mlb_f5 doubleheader gamePk bug, silent mis-settlement every MLB day). Then **WI-0636** + **WI-0635** (`needs-sync`, deploy verification — turbopack guard + CF convergence retries; block future false-rollbacks). Then **WI-0625** (tiny: remove unused liveLineBook). Then **WI-0627** (check_odds_health watchdog), **WI-0630** (pull_nhl_team_stats scheduler), **WI-0628** (market evaluator UI), **WI-0629** (settle_mlb_f5 tests). Full priority order in the sprint tables below.

## Sprint Plan — 2026-03-28 (29 open WIs: 1 P1 + 9 P2 + 11 P3 + 6 Backlog + 2 Backlog-S)

### Dependency Chains

- **MLB pitcher K:** ALL DONE ✓ (WI-0595→0596→0597→0598)
- **MLB F5:** ALL DONE ✓ (WI-0602→0603→0604)
- **CLV:** ALL DONE ✓ (WI-0557)
- **Display:** ALL DONE ✓ (WI-0567 1P label)
- **Market evaluator (serial):** ALL DONE ✓ (~~WI-0568~~✓ → ~~WI-0569~~✓ / ~~WI-0570~~✓ → ~~WI-0571~~✓ — UI half deferred to WI-0628)
- **Security hardening:** ~~WI-0608~~✓ → ~~WI-0609~~✓ → WI-0631 (refresh token persistence)
- **settle_mlb_f5 correctness:** WI-0626 (fix doubleheader bug) → WI-0629 (tests, unblocked after 0626)
- **New markets:** WI-0586 independent (NHL blocked shots)

---

## Prioritized Open Work Queue — 2026-03-28

### Recently Completed ✓

| WI | Summary |
|---|---|
| ~~WI-0571~~ ✓ | Market evaluator — projection comparator (edge vs consensus, execution alpha) |
| ~~WI-0610~~ ✓ | moneypuck.js test suite |
| ~~WI-0609~~ ✓ | Token route IP whitelist / endpoint hardening |
| ~~WI-0570~~ ✓ | Market evaluator — misprice detector (soft line, price-only, high-dispersion flags) |
| ~~WI-0569~~ ✓ | Market evaluator — execution selector (best-price separate from best-line) |
| ~~WI-0607~~ ✓ | Persist + backfill results market period token |
| ~~WI-0608~~ ✓ | JWT revocation persistence — move to DB table |
| ~~WI-0614~~ ✓ | Rename decision-pipeline-v2.patch.js |
| ~~WI-0613~~ ✓ | Delete committed scratch/debug/backup files |
| ~~WI-0598~~ ✓ | Pitcher Ks contract hardening (validator + market contract) |
| ~~WI-0597~~ ✓ | Pitcher Ks odds pull + dual-mode runtime wiring |
| ~~WI-0596~~ ✓ | Pitcher Ks data foundations and freshness gates |
| ~~WI-0595~~ ✓ | Pitcher Ks core engine (projection-only parity) |
| ~~WI-0603~~ ✓ | MLB F5 ML ingest + side-projection layer |
| ~~WI-0568~~ ✓ | Market evaluator — consensus layer (median line/price, dispersion) |
| ~~WI-0567~~ ✓ | Surface 1P vs full-game label on /results page |
| ~~WI-0557~~ ✓ | Wire CLV feedback loop (`ENABLE_CLV_LEDGER`) |

### P0 — (empty ✓)

### P1 — Correctness bug (silent mis-settlement)

| # | WI | Summary | Deps |
|---|---|---|---|
| 1 | [WI-0626](../WORK_QUEUE/WI-0626.md) | Fix settle_mlb_f5 doubleheader gamePk lookup bug | none |

### P2 — Sprint +1

| # | WI | Summary | Deps | LOE |
|---|---|---|---|---|
| 2 | [WI-0636](../WORK_QUEUE/WI-0636.md) | Add turbopack/dev-chunk pattern guard to deploy verification (`needs-sync`) | none | S |
| 3 | [WI-0635](../WORK_QUEUE/WI-0635.md) | Stabilize deploy verification — public HTML CF convergence retries (`needs-sync`) | after WI-0636 | M |
| 4 | [WI-0625](../WORK_QUEUE/WI-0625.md) | Remove unused liveLineBook variable | none | XS |
| 5 | [WI-0627](../WORK_QUEUE/WI-0627.md) | Wire check_odds_health into scheduler as watchdog | none | S |
| 6 | [WI-0630](../WORK_QUEUE/WI-0630.md) | Wire pull_nhl_team_stats into scheduler daily cadence | none | S |
| 7 | [WI-0628](../WORK_QUEUE/WI-0628.md) | Surface edge_vs_consensus and edge_vs_best_available in cards UI | none | S |
| 8 | [WI-0629](../WORK_QUEUE/WI-0629.md) | Test suite for settle_mlb_f5.js | WI-0626 first | M |
| 9 | [WI-0611](../WORK_QUEUE/WI-0611.md) | Replace NHL fault harness stubs | none | S |
| 10 | [WI-0612](../WORK_QUEUE/WI-0612.md) | team-metrics.js test suite | none | M |

### P3 — Sprint +2

| # | WI | Summary | Deps |
|---|---|---|---|
| 9 | [WI-0586](../WORK_QUEUE/WI-0586.md) | NHL blocked shots prop pipeline (full end-to-end) | none |
| 10 | [WI-0615](../WORK_QUEUE/WI-0615.md) | Remove homeGoalieConfirmed deprecated field | none |
| 11 | [WI-0616](../WORK_QUEUE/WI-0616.md) | Rename welcome-home-v2 card_type | none |
| 12 | [WI-0617](../WORK_QUEUE/WI-0617.md) | Remove initDb() no-op callers | none |
| 13 | [WI-0618](../WORK_QUEUE/WI-0618.md) | Delete orphaned archive directories | none |
| 14 | [WI-0619](../WORK_QUEUE/WI-0619.md) | Extract FPL scheduler to schedulers/fpl.js | none |
| 15 | [WI-0631](../WORK_QUEUE/WI-0631.md) | Implement refresh token persistence and revocation | none |
| 16 | [WI-0632](../WORK_QUEUE/WI-0632.md) | Test suite for run_nfl_model.js | none |
| 17 | [WI-0633](../WORK_QUEUE/WI-0633.md) | Test suite for run_ncaam_model.js | none |
| 18 | [WI-0638](../WORK_QUEUE/WI-0638.md) | Remove NCAAM + Soccer from UI sport filter permanently | none |
| 19 | [WI-0639](../WORK_QUEUE/WI-0639.md) | NFL UI seasonal gate — hide sport filter outside Sep–Feb | none |

### Backlog — Tech Debt Milestone

| WI | Summary | LOE |
|---|---|---|
| [WI-0620](../WORK_QUEUE/WI-0620.md) | Decompose db.js into domain modules | XL |
| [WI-0621](../WORK_QUEUE/WI-0621.md) | Decompose games/route.ts into lib/games/ helpers | XL |
| [WI-0622](../WORK_QUEUE/WI-0622.md) | Decompose transform.ts into split modules | L |
| [WI-0623](../WORK_QUEUE/WI-0623.md) | Decompose cards-page-client.tsx into sub-components | XL |
| [WI-0624](../WORK_QUEUE/WI-0624.md) | Audit + remove legacy reason codes | L |
| [WI-0634](../WORK_QUEUE/WI-0634.md) | Wire report_settlement_health into scheduler daily | S |

---

### Historical Audit Fixes — Tier 0 / Tier 0b (all DONE ✓ as of 2026-03-24)

> All 12 NHL props audit findings (WI-0573–0584) and 6 pipeline audit findings (AUDIT-FIX-01–06) are closed.
> WI-0551/0552/0555/0557/0559/0560/0561/0567/0568/0569/0570/0572 all done.
> See quick tasks qt-65–qt-80 and `WORK_QUEUE/COMPLETE/` for details.
> WI-0554/0558/0562/0563/0553/0556 — closed or removed from active queue 2026-03-27.
> WI-0564/0566 — OBSOLETE (soccer dependency removed).

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
| 73 | WI-0580 Add PROP to WAVE1_MARKETS gate — V2 official_status can now override V1 for NHL player prop cards | 2026-03-23 | c79acf5 | [73-wi-0580-add-prop-to-wave-1-market-gate-s](./quick/73-wi-0580-add-prop-to-wave-1-market-gate-s/) |
| 74 | WI-0575 Direction-aware opportunity_score — closure session; fix confirmed live from quick-71 (no code changes) | 2026-03-23 | c516c07 | [74-wi-0575-fix-opportunity-score-direction-](./quick/74-wi-0575-fix-opportunity-score-direction-/) |
| 75 | WI-0577 Guard 3 full-game V2 Poisson veto: FIRE→WATCH when edge_<dir>_pp < 0 on odds-backed cards; mirrors 1P Guard 3 with [v2-veto-full] log tag | 2026-03-23 | 556d1cc | [75-wi-0577-fix-v2-poisson-edge-never-gates-](./quick/75-wi-0577-fix-v2-poisson-edge-never-gates-/) |

| 76 | WI-0583 V1 vs V2 mu calibration study | 2026-03-24 | ea7b3b9 | [76-wi-0583-v1-vs-v2-mu-calibration-study](./quick/76-wi-0583-v1-vs-v2-mu-calibration-study/) |
| 77 | WI-0584 Line-change dedup gap: 6-element key + secondary seenPropTupleKeys pass + warn-on-zero purge | 2026-03-24 | 974f114 | [77-wi-0584-line-change-dedup-gap](./quick/77-wi-0584-line-change-dedup-gap/) |
| 78 | WI-0579 1P independent V2 run: projectSogV2 called with 1P-specific mu; full-game v2AnomalyDetected no longer reused against 1P mu | 2026-03-24 | — | — |
| 79 | WI-0581 Rename decision_v2.edge_pct → edge_delta_pct: removes conflation between projection-delta % and probability edge across model job + downstream consumers | 2026-03-24 | — | — |
| 80 | WI-0582 opponentFactor/paceFactor fallback: console.debug → console.warn + OPPONENT_FACTOR_MISSING / PACE_FACTOR_MISSING reason_code flag on card | 2026-03-24 | — | — |
| 81 | WI-0587: Remove ncaam-matchup-style as actionable betting source | 2026-03-24 | 2f35455 | [78-wi-0587-remove-ncaam-matchup-style-as-ac](./quick/78-wi-0587-remove-ncaam-matchup-style-as-ac/) |
| 82 | WI-0588 NBA totals quarantine — demote tier one level | 2026-03-24 | ddfc2fc | [79-wi-0588-nba-totals-quarantine-demote-tie](./quick/79-wi-0588-nba-totals-quarantine-demote-tie/) |
| 83 | WI-0569 Market evaluator — execution selector (best-price separate from best-line); migration 047 | 2026-03-27 | 7e08784 | — |
| 84 | WI-0570 Market evaluator — misprice detector (soft line, price-only, high-dispersion flags); migration 048, UI soft-line display | 2026-03-27 | 4f6af7b | — |
| 85 | WI-0613 delete scratch debug backup files | 2026-03-28 | dcbaeb2 | [81-wi-0613-delete-scratch-debug-backup-file](./quick/81-wi-0613-delete-scratch-debug-backup-file/) |
| 86 | qt-85 / WI-0614 rename decision-pipeline-v2.patch.js to decision-pipeline-v2-edge-config.js | 2026-03-28 | e5cf823 | [85-wi-0614-rename-decision-pipeline-v2-edg](./quick/85-wi-0614-rename-decision-pipeline-v2-edg/) |
| 87 | qt-86 / WI-0608 JWT revocation persistence — move to DB table | 2026-03-28 | 34adcd7 | [86-wi-0608-security-jwt-revocation-persiste](./quick/86-wi-0608-security-jwt-revocation-persiste/) |
| 88 | qt-87 / WI-0607 persist market_period_token at settlement + backfill job + COALESCE in /api/results | 2026-03-27 | 70f1f5b | [87-wi-0607-results-persist-market-period-to](./quick/87-wi-0607-results-persist-market-period-to/) |
| 89 | Gap audit 2026-03-28: 9 new WIs (WI-0626–0634) — settle_mlb_f5 doubleheader bug, check_odds_health/report_settlement_health/pull_nhl_team_stats scheduler gaps, market evaluator UI, refresh token storage, run_nfl_model/run_ncaam_model test coverage | 2026-03-28 | — | — |
| 90 | WI-0636 Turbopack/dev-chunk guard in deploy workflow | 2026-03-28 | f3c0db7 | [88-wi-0636-turbopack-dev-chunk-guard-in-dep](./quick/88-wi-0636-turbopack-dev-chunk-guard-in-dep/) |

Last activity: 2026-03-28 - Completed quick task 88: WI-0636 Turbopack/dev-chunk guard in deploy workflow
