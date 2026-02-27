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
