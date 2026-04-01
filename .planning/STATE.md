---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: active
last_updated: "2026-03-31T00:00:00Z"
last_activity: "2026-03-31 - Sprint re-prioritised: odds pipeline health first, FPL shell bug fixes, core product unblocked"
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

- Last reviewed: 2026-03-31
- Next action: See sprint plan below. **Odds pipeline health check is the first thing on April 1** before any product work proceeds.

## Sprint Plan — 2026-03-31 re-assess (post WI-0704 + new April priorities)

> Recent completions since last STATE:
> - WI-0660 ✓ — Draft workbench UI (7 components + shell + contract tests) — 2026-03-30
> - WI-0661 ✓ — Weekly co-pilot dashboard — 2026-03-31
> - WI-0704 ✓ — FPLParseReview crash on unresolved_slots undefined — 2026-03-31
> - WI-0673–0680 ✓ — FPL Sage test harness hardening train — 2026-03-30
> - Full prior train: WI-0648–0659, WI-0701–0703 (see `WORK_QUEUE/COMPLETE/`)
>
> ⚠️ WI number collision note: `WORK_QUEUE/COMPLETE/` contains items numbered WI-0668–0672 that are **test-fix tasks** (different scope). The active product WIs with the same numbers in `WORK_QUEUE/` are the canonical ones for this sprint.
>
> ⚠️ Verification failures: WI-0653 (0/5 truths — never implemented, docs-only commit) and WI-0657 (3/5 truths — five contract fields absent) must be re-implemented before any work that depends on them.

---

## ⚡ April Priority: Get the ML/Sports Pipeline Profitable

**Context:** We had a dry week with no odds flowing. April 1 is the start of a new quota cycle. Before shipping any FPL product work, confirm the betting pipeline is healthy and producing play calls.

**Goal:** Odds are flowing → models are running → play calls are posted to Discord → results are settling correctly.

---

### Hard Deadlines

- **April 1**: Verify odds quota reset, `check_odds_health` watchdog active, `pull_odds_hourly` succeeding. Diagnose and fix any dry-run or env flag that may be silencing odds fetches.
- **No hard date deadlines** on FPL product items.

---

### Dependency Chains

- **WI-0704** ✓ — DONE 2026-03-31
- **WI-0710** — OCR + live FPL registry (UX enhancement over WI-0704); depends on WI-0704 ✓ → **UNBLOCKED** (lower priority, Q2)
- **WI-0705** — Build Lab 422 fix; no deps → **UNBLOCKED**
- **WI-0706** — Profile persistence; semantically depends on WI-0653 working → **blocked until WI-0653 re-implemented**
- **WI-0653** — Manager Profile APIs (re-implement — 0/5 verified, never committed); no deps → **UNBLOCKED**
- **WI-0657** — Explainability contract gap-fill (3/5 verified); no deps → **UNBLOCKED**
- **WI-0662** — Sage frontend internal-only + runbook; depends on WI-0659 ✓, WI-0660 ✓, WI-0661 ✓ → **UNBLOCKED**
- **WI-0663** — MLB pitcher-K UNDER monitoring; independent → **UNBLOCKED**
- **WI-0664** — DB migration (public betting splits schema); independent, low priority → **UNBLOCKED**
- **WI-0665** — ActionNetwork adapter; depends on WI-0664 → blocked
- **WI-0666** — pull_public_splits worker job; depends on WI-0664, WI-0665 → blocked
- **WI-0667** — computePublicSplitsGate; depends on WI-0664–0666 → blocked
- **WI-0668** — NL intent translation; depends on WI-0660 ✓, WI-0652 ✓ → **UNBLOCKED**
- **WI-0669** — Final Recommendation output; depends on WI-0656 ✓, WI-0660 ✓ → **UNBLOCKED**
- **WI-0670** — Comparison + tradeoff chips; depends on WI-0669 → blocked on WI-0669
- **WI-0671** — Post-draft season loop; depends on WI-0669, WI-0652 ✓ → blocked on WI-0669
- **WI-0672** — Constraint state panel + reset; depends on WI-0668, WI-0660 ✓ → blocked on WI-0668
- **WI-0708** — API contract expansion (posture-aware outputs); depends on WI-0707 ✓ → **UNBLOCKED**
- **WI-0709** — nextGW ceiling/floor pts from FPL data; depends on WI-0707 ✓ → **UNBLOCKED**

---

## Prioritized Open Work Queue — 2026-03-31 re-assess

### 🔴 P0 — Odds Pipeline Health (April 1 first thing)

Before any code work, manually verify on the Pi / production worker:

1. **Odds quota reset**: confirm `quota_ledger` row for `2026-04` exists or will be seeded on first fetch. Verify `tokens_remaining` is non-zero and `getCurrentQuotaTier()` returns `FULL`.
2. **`ENABLE_ODDS_PULL` flag**: confirm it is NOT set to `false` in the `.env` or Railway env vars.
3. **`check_odds_health` watchdog**: confirm `ENABLE_ODDS_HEALTH_WATCHDOG` is not disabled. Watch scheduler logs for the 30-min `check_odds_health` job executing.
4. **`pull_odds_hourly` succeeding**: confirm a successful run appears in `job_runs` within the last 60 min during game hours.
5. **`ENABLE_WITHOUT_ODDS_MODE`**: confirm this is `false` in production (ESPN-direct mode disables settlement and real play calls).
6. **Discord cards posting**: confirm `ENABLE_DISCORD_CARD_WEBHOOKS=true` and `DISCORD_CARD_WEBHOOK_URL` is set. Verify the 09:00/12:00/18:00 ET snapshots are firing.
7. **Settlement**: after games complete, confirm `settle_game_results` and `settle_pending_cards` are running and `card_results` rows are being written.

If any of (1)–(7) are broken, that diagnosis + fix is the only work that matters until the pipeline is green.

### 🔴 P1 — Broken / Never-Implemented (FPL Shell)

These must land before any downstream FPL product work:

- **WI-0705** — Fix Build Lab "New session" 422 (frontend sends `user_id`, backend expects `manager_id` + `gameweek`). Fast fix, no deps. Run immediately.
- **WI-0653** (re-implement) — Manager Profile APIs. Zero code was ever committed. `profile_api_models.py`, `profile_service.py`, `profiles.py`, and both test files all missing. WI-0706 is blocked until this lands.
- **WI-0657** (gap-fill) — Explainability contract: `confidence_band`, `scenario_notes`, `explainability`, `relative_risk`, `receipt_id` absent from `contract_transformer.py`; two test files missing.

### 🟡 P2 — Unblocked Core Product (gates downstream)

Run in parallel after P1 fixes are claimed:

- **WI-0669** — Final Recommendation terminal output. Gates WI-0670 and WI-0671. Highest leverage item in the queue.
- **WI-0668** — NL Intent Translation Layer. Gates WI-0672.
- **WI-0709** — Derive `nextGW_ceiling_pts` / `nextGW_floor_pts` from FPL API. Direct production impact on transfer ranking. WI-0707 ✓ is its only dep.
- **WI-0708** — API contract expansion for posture-aware outputs. Companion to WI-0709.

### 🟡 P3 — Unblocked Independents

- **WI-0706** — Persist manager profile across reload. Can start immediately after WI-0653 lands.
- **WI-0662** — Sage frontend internal-only conversion + runbook cleanup. All deps done.
- **WI-0663** — MLB pitcher-K UNDER monitoring. Fully independent; extends the profitable pitcher-K pipeline.

### 🟢 P4 — Blocked (awaiting P2)

- **WI-0670** — blocked on WI-0669
- **WI-0671** — blocked on WI-0669
- **WI-0672** — blocked on WI-0668
- **WI-0710** — OCR + live FPL player registry (UX enhancement). Blocked on WI-0704 ✓ (done). Low urgency — synthetic scaffold is functional for now.

### ⚪ P5 — Low Priority / Nice-to-Have

Public betting splits pipeline (sequential chain — all marked `Priority: low` in WI files):
- WI-0664 → WI-0665 → WI-0666 → WI-0667

Defer until the core pipeline is consistently profitable.

- WI-0664 → WI-0665 → WI-0666 → WI-0667

---

- [WI-0668](../WORK_QUEUE/WI-0668.md) — NL intent translation layer (LOE M) — **UNBLOCKED**
- [WI-0669](../WORK_QUEUE/WI-0669.md) — Final Recommendation terminal output (LOE M) — **UNBLOCKED**

### Gated Follow-on

- [WI-0662](../WORK_QUEUE/WI-0662.md) — Standalone Sage frontend internal-only conversion + runbook cleanup (LOE S) — blocked on WI-0661
- [WI-0670](../WORK_QUEUE/WI-0670.md) — Comparison as core + tradeoff surface (LOE M) — blocked on WI-0669
- [WI-0671](../WORK_QUEUE/WI-0671.md) — Post-draft season loop stub (LOE M) — blocked on WI-0669
- [WI-0672](../WORK_QUEUE/WI-0672.md) — Constraint state panel + reset to baseline (LOE M) — blocked on WI-0668

### Secondary / Independent Tracks

- [WI-0663](../WORK_QUEUE/WI-0663.md) — MLB pitcher-K strong UNDER monitoring (LOE M) — **UNBLOCKED**, no chain dependency
- [WI-0664](../WORK_QUEUE/WI-0664.md) → [WI-0665](../WORK_QUEUE/WI-0665.md) → [WI-0666](../WORK_QUEUE/WI-0666.md) → [WI-0667](../WORK_QUEUE/WI-0667.md) — public betting splits pipeline (low priority overlay; WI-0664 UNBLOCKED)

### Program Track A — FPL Product Platform

`WI-0652 ✓ → (WI-0653 ✓, WI-0655 ✓, WI-0657 ✓) → (WI-0654 ✓, WI-0656 ✓, WI-0658 ✓) → WI-0659 ✓ → WI-0660 ✓ → WI-0661 → WI-0662`
`WI-0660 ✓ + WI-0652 ✓ → WI-0668 → WI-0672`
`WI-0656 ✓ + WI-0660 ✓ → WI-0669 → (WI-0670, WI-0671)`

### Program Track B — Public Splits Pipeline

`WI-0664 → WI-0665 → WI-0666 → WI-0667`

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
| 91 | WI-0635: CF public-HTML convergence retries in deploy workflow | 2026-03-28 | 96cfdfb | [89-wi-0635-cf-public-html-convergence-retri](./quick/89-wi-0635-cf-public-html-convergence-retri/) |
| 92 | WI-0627: Wire check_odds_health into scheduler as 30-min watchdog | 2026-03-28 | 0e4d8e3 | [90-wi-0627-wire-check-odds-health-into-sche](./quick/90-wi-0627-wire-check-odds-health-into-sche/) |
| 93 | Test suite for settle_mlb_f5.js | 2026-03-28 | cd72034 | [91-test-suite-for-settle-mlb-f5-js](./quick/91-test-suite-for-settle-mlb-f5-js/) |
| 94 | WI-0626: Fix settle_mlb_f5 doubleheader gamePk lookup bug | 2026-03-28 | a51e3e8 | — |
| 95 | WI-0630: Wire pull_nhl_team_stats into scheduler daily | 2026-03-28 | c6210c3 | — |
| 96 | WI-0628: Surface edge_vs_consensus + edge_vs_best_available in cards UI + WI-0611: Replace NHL fault harness stubs | 2026-03-28 | 9045859 | — |
| 97 | WI-0612: team-metrics.js test suite | 2026-03-28 | 551bd7a | — |
| 98 | WI-0639: NFL UI seasonal gate — isNflSeason() in season-gates.ts, gating filter-panel + filters + cards-page-client | 2026-03-28 | 56ffef1 | [92-wi-0639-nfl-ui-seasonal-gate-hide-sport-](./quick/92-wi-0639-nfl-ui-seasonal-gate-hide-sport-/) |
| 99 | WI-0617: Remove initDb() no-op callers — confirmed already absent (qt-47/WI-0456), acceptance checks pass | 2026-03-28 | 4b1b437 | [93-wi-0617-remove-initdb-no-op-callers](./quick/93-wi-0617-remove-initdb-no-op-callers/) |
| 100 | WI-0641: Player props scheduler extraction — player-props.js (NHL SOG/BLK + MLB pitcher-K), 18 tests, main.js cleaned | 2026-03-28 | eea2e0d | [94-wi-0641-player-props-scheduler-refactor](./quick/94-wi-0641-player-props-scheduler-refactor/) |
| 101 | WI-0649: Add fixture difficulty tracking to FPL Sage | 2026-03-29 | 193b580 | [97-wi-0649-add-fixture-difficulty-tracking-](./quick/97-wi-0649-add-fixture-difficulty-tracking-/) |
| 102 | Audit and remove legacy reason codes (WI-0624) | 2026-03-29 | fb79136 | [98-audit-and-remove-legacy-reason-codes-wi-](./quick/98-audit-and-remove-legacy-reason-codes-wi-/) |
| 103 | WI-0646 (Playoff-mode detection) — must land before Apr 19 | 2026-03-29 | 4725c55 | [99-wi-0646-playoff-mode-detection-must-land](./quick/99-wi-0646-playoff-mode-detection-must-land/) |
| 104 | WI-0701: Preserve games state on transient fetch failures (5xx, timeout) | 2026-03-29 | cee5421 | [101-wi-0701](./quick/101-wi-0701/) |
| 105 | WI-0647: Cross-market settlement ROI report | 2026-03-29 | 9ef8f99 | [102-wi-0647](./quick/102-wi-0647/) |
| 106 | WI-0648: MLB empirical sigma recalibration gate — MIN_MLB_GAMES_FOR_RECAL=20, computeSigmaFromHistory, 11 tests | 2026-03-30 | 9599cbc | [103-wi-0648-mlb-sigma-recal](./quick/103-wi-0648-mlb-sigma-recal/) |
| 107 | WI-0650: Governance + CI import boundary hardening — OWNERSHIP.md DB Domain Modules, scripts/check-db-imports.js, CI check-db-import-boundaries step | 2026-03-30 | c2ef9b6 | [104-wi-0650-governance-ci-hardening-needs-sy](./quick/104-wi-0650-governance-ci-hardening-needs-sy/) |
| 108 | WI-0653: Manager profile APIs + archetype mapping — POST/GET/PATCH /api/v1/profiles, 5-archetype deterministic rules, per-archetype constraint defaults, 33 tests | 2026-03-30 | 19187bd | [106-wi-0653-manager-profile-apis-and-archety](./quick/106-wi-0653-manager-profile-apis-and-archety/) |
| 109 | WI-0655: Screenshot parsing + parsed-squad normalization — POST /api/v1/screenshot-parse, PlayerRegistry fuzzy match, layout detection, synthetic 15-slot scaffold, 51 tests | 2026-03-30 | 8d91364 | [107-wi-0655-screenshot-parsing-and-parsed-sq](./quick/107-wi-0655-screenshot-parsing-and-parsed-sq/) |
| 110 | WI-0657: Weekly analysis explainability contract — ConfidenceBand/ScenarioNote/ExplainabilityBlock/RelativeRiskFrame Pydantic models, 5 additive fields in build_detailed_analysis_contract, 43 tests | 2026-03-30 | 3bd566f | [108-wi-0657-weekly-analysis-explainability-u](./quick/108-wi-0657-weekly-analysis-explainability-u/) |
| 111 | WI-0658: Decision receipts + memory + trust analytics APIs — POST /decision-receipts, GET /user/{id}/analytics + /memory, 4 drift flags, 35 tests | 2026-03-30 | 70e2ad2 | [111-wi-0658-decision-receipts-memory-and-tru](./quick/111-wi-0658-decision-receipts-memory-and-tru/) |
| 112 | WI-0656: Draft audit scoring + comparison APIs — POST /draft-sessions/{id}/audit (8 dimensions, profile-aware), POST /draft-sessions/compare (archetype-weighted), 38 tests | 2026-03-30 | e3d02a4 | [112-wi-0656](./quick/112-wi-0656/) |
| 114 | WI-0660: Draft workbench UI — 7 components (onboarding, draft-lab, candidate-card, screenshot-uploader, parse-review, draft-audit, draft-compare), shell wiring, 2 contract test files | 2026-03-30 | d576106 | [114-wi-0660-draft-workbench-profile-build-pa](./quick/114-wi-0660-draft-workbench-profile-build-pa/) |
| 115 | Weekly co-pilot dashboard WI-0661 UNBLOCKED | 2026-03-31 | c205ca7 | [115-weekly-co-pilot-dashboard-wi-0661-unbloc](./quick/115-weekly-co-pilot-dashboard-wi-0661-unbloc/) |

Last activity: 2026-03-30 - Completed quick task 114: WI-0660 draft workbench UI — 7 components, shell wiring, 2 contract test files (16 checks all pass)
