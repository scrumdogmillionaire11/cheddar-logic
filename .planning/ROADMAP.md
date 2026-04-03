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
