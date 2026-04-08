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
