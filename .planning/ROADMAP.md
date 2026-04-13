# Cheddar-Logic Roadmap

## Milestone 1: Production-Ready Ingest & Inference Pipeline

### Status: In Progress (Pre-Ship Hardening)

All 4 migration phases complete. System is in final hardening before production deployment.

### Phases Completed
- Phase 1: DB + Odds Ingestion ✅
- Phase 2: Model Runner + Card Generation + Web API ✅
- Phase 3: Multi-Sport Runners + Web UI ✅
- Phase 4: Scheduled Runner + Production Cutover ✅
- Step C: API Read Path + Payload Safety Hardening ✅
- Step D: Real Odds Ingest via @cheddar-logic/odds Package ✅

### Current Phase: Pre-Ship Hardening
Tighten operational guarantees before first production deploy:
- Contract checks for normalization failures
- Stable game ID regression tests
- Job key audit across all jobs
- Adapter API clarity
- T-120 documentation
- Ingest proof runbook

### Architecture
```
apps/worker/     → scheduler + ingest + model execution
web/             → Next.js UI + API routes
packages/data/   → DB layer (sql.js + migrations)
packages/odds/   → provider fetch + normalization (NO DB writes)
```

---

## Milestone 2: Play of the Day — Web Feature

### Status: Planning

A product-facing feature on cheddarlogic.com: one best play per day, signal-scored from live odds, published to the site and Discord, with a running $10 bankroll tracker.

### Architecture
```
web/app/play-of-the-day/    → Next.js page route
web/app/api/play-of-day/    → API routes (signal engine, publish, outcomes)
apps/worker/                → Daily cron trigger (12–4PM window)
packages/odds/              → The Odds API fetch (reused)
```

### Phase: potd-01 — Play of the Day: Signal Engine + Page + Discord
**Goal**: Ship a fully working /play-of-the-day page on cheddarlogic.com. The system fetches live game lines from The Odds API daily, scores each game using the 4-dimension signal engine, selects the single best ELITE/HIGH-confidence play, sizes the wager with Quarter-Kelly (20% cap, $10 starting bankroll), publishes to the Cheddar UI page and Discord simultaneously, enforces a one-play-per-day gate, and maintains a persistent bankroll + play history ledger.

**Sports in scope**: NBA, MLB, NHL (game lines only). NFL deferred.
**Posting window**: 12–4PM daily, dynamically timed 90min before first game lock.

**Plans**: TBD

Plans:

- [ ] TBD — planning in progress

---

### Phase: mlb-k-harden — MLB Pitcher-K Pipeline Hardening

**Goal**: Eliminate silent proxy substitution in the MLB pitcher-K model. Install an explicit
input contract, a deterministic quality classifier, per-pitcher pre-model completeness logging,
and card-level flag deduplication. Cards using proxies for core metrics must emit FALLBACK,
not quietly claim DEGRADED_MODEL status.

**Plans**: 4 plans

Plans:
- [ ] mlb-k-harden-01-PLAN.md — Classifier module: classifyMlbPitcherKQuality + 5 unit tests (Wave 1)
- [ ] mlb-k-harden-02-PLAN.md — Spec doc (mlb_projection_input_contract.md) + WI-0742 FALLBACK addendum (Wave 1)
- [ ] mlb-k-harden-03-PLAN.md — Wire classifier into run_mlb_model.js + pre-model audit block + flag dedup (Wave 2)
- [ ] mlb-k-harden-04-PLAN.md — INV-007 audit invariant + update/create MLB_PITCHER_K fixtures (Wave 3)


---

### Phase: di-01-decision-integrity — Decision Source-of-Truth Hardening

**Goal**: Eliminate all multiple-truth-layer decision mutations. Enforce a single canonical decision object per card, fix web reclassification, kill ghost bets from execution gate contradiction, make NHL NO_BET explicit, unify tier vocabularies, complete projection path consolidation, and lock all behavior with regression tests.

**Audit source**: `.planning/codebase/HARDENING_AUDIT.md` — CF-001 through CF-010

**Plans**: 8 plans in 3 waves

Plans:
- [ ] di-01-01-PLAN.md — Kill web-layer reclassification; add NON_CANONICAL_RENDER_FALLBACK guard (Wave 1)
- [ ] di-01-02-PLAN.md — NHL NO_BET explicit skip state; blockingReasonCodes in pipeline state (Wave 1)
- [ ] di-01-03-PLAN.md — Tier vocabulary unification: GOOD/OK/BAD in deriveAction + TIER_SCORE (Wave 1)
- [ ] di-01-04-PLAN.md — applyDecisionVeto helper; execution gate mutation fix; settlement contradiction guard (Wave 2)
- [ ] di-01-05-PLAN.md — Deprecated projectNBA migration in computeNBADriverCards (Wave 2)
- [ ] di-01-06-PLAN.md — Threshold registry completeness: NHL SPREAD/PUCKLINE + exhaustive coverage test (Wave 2)
- [ ] di-01-07-PLAN.md — Stale threshold to env var; EDGE_UPGRADE_MIN recalibrated to 0.04; assertNoDecisionMutation hardened (Wave 3)
- [ ] di-01-08-PLAN.md — Playoff sigma explicit contract + 5-case test suite (Wave 3)

---

### Phase: WI-0914 — Multi-Sport Playoff Overlay Layer

**Goal**: Implement a deterministic playoff overlay layer across NHL/NBA/NFL/MLB that adjusts volatility bands, eligibility strictness, and execution thresholds in the existing single-model paths.

**Requirements:** [PO-OVERLAY-01, PO-OVERLAY-02, PO-OVERLAY-03, PO-NHL-01, PO-NHL-02, PO-NBA-01, PO-NFL-01, PO-MLB-01, PO-THRESH-01]

**Plans:** 3 plans in 2 waves

Plans:
- [ ] WI-0914-01-PLAN.md — Shared playoff overlay contract + scheduler/watchdog + payload validation (Wave 1)
- [ ] WI-0914-02-PLAN.md — NHL + NBA playoff runner/model overlays (Wave 2)
- [ ] WI-0914-03-PLAN.md — NFL + MLB playoff overlays + stricter playoff thresholds (Wave 2)


---

### Phase: ime-01-independent-market-eval — Independent Market Evaluation

**Goal**: Replace winner-take-all market selection with independent evaluation + explicit rejection accounting for MLB and NHL moneyline markets. Every generated market candidate must end in exactly one terminal status with reason codes. No market may disappear without accounting. MLB full_game_ml and NHL ML are first-class markets, not fallback artifacts.

**Audit source**: `.planning/MONEYLINE_AUDIT_FULL_SYSTEM.md`

**Requirements:** [IME-CONTRACT-01, IME-CONTRACT-02, IME-MLB-01, IME-MLB-02, IME-MLB-03, IME-MLB-04, IME-NHL-01, IME-NHL-02, IME-NHL-03]

**Plans:** 5 plans in 3 waves

Plans:
- [ ] ime-01-01-PLAN.md — Shared evaluation contract: evaluateSingleMarket, finalizeGameMarketEvaluation, assertNoSilentMarketDrop, REASON_CODES (Wave 1)
- [ ] ime-01-02-PLAN.md — Kill MLB hardcoded selector: replace selectMlbGameMarket with evaluateMlbGameMarkets (Wave 1)
- [ ] ime-01-03-PLAN.md — Wire evaluateMlbGameMarkets into run_mlb_model.js; multi-market insertion (Wave 2)
- [ ] ime-01-04-PLAN.md — NHL independent evaluation: evaluateNHLGameMarkets + choosePrimaryDisplayMarket; wire into run_nhl_model.js (Wave 2)
- [ ] ime-01-05-PLAN.md — Spec doc docs/market_evaluation_contract.md + VALID_STATUSES export (Wave 3)

---

### Phase: WI-0911 — NHL Player Blocks Projection Settlement Policy

**Goal**: Enforce an explicit, deterministic settlement policy for `nhl-player-blk` so this market cannot silently flow through unsupported grading paths.

**Requirements:** [BLK-SETTLE-01, BLK-SETTLE-02, BLK-SETTLE-03]

**Plans:** 1 plan in 1 wave

Plans:
- [ ] WI-0911-01-PLAN.md — Lock `nhl-player-blk` as projection-audit-only, add market-specific closeout reason metadata, and harden settlement tests (Wave 1)
