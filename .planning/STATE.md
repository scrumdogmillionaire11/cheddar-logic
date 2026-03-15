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

- Last reviewed: 2026-03-13
- Next action for operators/agents: assess and prioritize directly from `WORK_QUEUE/`

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

Last activity: 2026-03-15 - Completed quick task 45: WI-0459 Soccer odds + projection-only market rework — two-track runner, 3 new card schemas, SOCCER config 3 markets/3 tokens
