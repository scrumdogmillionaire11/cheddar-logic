# Settlement Legacy Code Audit

**Date:** March 4, 2026  
**Status:** Inventory complete — removal phase pending hardening  
**Phase:** Phase 1 Hardening (ESPN score fetching)

---

## Overview

This document catalogs **ALL settlement-related code paths** currently in the codebase. Once Phase 1 (game score fetching) is hardened and passing resilience tests, **all legacy items below must be removed** to ensure a single, canonical settlement workflow.

---

## Current Settlement Artifacts

### ✅ ACTIVE: Phase 1 - Game Score Fetching

**File:** [apps/worker/src/jobs/settle_game_results.js](apps/worker/src/jobs/settle_game_results.js)

| Aspect | Status | Details |
| --- | --- | --- |
| **Code** | Exists, needs hardening | 734 lines, ESPN matching logic complete |
| **CLI** | Yes | `npm run job:settle-games` |
| **Orchestration** | Via pull_odds_hourly.js | Called after odds update (ENABLE_SETTLEMENT=true) |
| **Tests** | settle_game_results.matching.test.js | Matching logic tested |
| **Idempotency** | Yes | jobKey-based dedup |
| **DB Backup** | Yes | Backs up before execution |
| **Error Handling** | Basic | Logs errors but doesn't retry ESPN API |
| **Monitoring** | No | No alerts on failure |

**Resilience Gaps (Target for Phase 1 Hardening):**

- ❌ No ESPN API retry logic (timeouts, rate limits)
- ❌ No ESPN response validation (malformed JSON, missing fields)
- ❌ No timeout safeguards on HTTP requests
- ❌ Scoring bounds validation missing (negative scores, impossible results)
- ❌ No alerting on repeated failures
- ❌ Not scheduled in production (manual trigger only)

---

### ✅ ACTIVE: Phase 2 - Card Settlement

**File:** [apps/worker/src/jobs/settle_pending_cards.js](apps/worker/src/jobs/settle_pending_cards.js)

| Aspect | Status | Details |
| --- | --- | --- |
| **Code** | Exists, needs refactor | 454 lines, settles ALL cards per game (broken) |
| **CLI** | CLI capable | Integrated into pull_odds_hourly |
| **Orchestration** | Via pull_odds_hourly.js | Runs after settle_game_results |
| **Tests** | settle_pending_cards.market-contract.test.js | Market contract tested |
| **Idempotency** | Yes | jobKey-based dedup |
| **Critical Defect** | YES | **Settles all cards, not just top-level** |
| **Tracking Stats** | Partial | Aggregates but records inflated counts |

**Required Changes (Phase 2 hardening):**

- ❌ Add `selectTopLevelCard()` filter (highest confidence)
- ❌ Archive non-top-level cards (optional: keep for diagnostics)
- ❌ Recompute tracking_stats aggregates
- ❌ Update integration test

---

### ✅ ACTIVE: Orchestration Entry Point

**File:** [apps/worker/src/jobs/pull_odds_hourly.js](apps/worker/src/jobs/pull_odds_hourly.js)

| Aspect | Status | Details |
| --- | --- | --- |
| **Settlement Trigger** | Lines 203-225 | Calls both Phase 1 + Phase 2 after odds update |
| **Environment Control** | `ENABLE_SETTLEMENT` | Default: enabled (set to 'false' to disable) |
| **Error Handling** | Catch, warn, continue | Doesn't abort odds fetch if settlement fails |
| **Frequency** | Hourly | Scheduled via job runner |

**Decision Point for Hardening:**

- Should settlement be **decoupled** from odds fetch?
- Should settlement have its **own scheduler/cron**?
- Current: settlement is a "bonus" after odds—low priority
- Better: settlement runs on scheduled cadence independently

---

## Legacy/Migration Code — Candidate for Removal

### ❌ LEGACY: resettle_historical_cards.js

**File:** [apps/worker/src/jobs/resettle_historical_cards.js](apps/worker/src/jobs/resettle_historical_cards.js)

| Aspect | Status | Details |
| --- | --- | --- |
| **Purpose** | One-off migration | Re-grades early cards using recommendation.type instead of raw prediction |
| **Usage** | Manual, one-time run | `node apps/worker/src/jobs/resettle_historical_cards.js` |
| **Status** | Unknown if run | No evidence in git history of recent execution |
| **Current Need** | None | Applies only to already-settled old cards |
| **Risk if kept** | Low | Orphaned, unmaintained code |
| **Recommendation** | **REMOVE after Phase 1 hardening** | Archive to `.archive/resettle_historical_cards.js.archived` |

**Rationale for removal:**

- This was a bridge during the transition from raw `prediction` to `recommendation.type`
- New cards already use correct logic
- Keeping it creates confusion about which path is canonical
- If historical reprocessing is needed, it should be a documented ADR + explicit decision

---

### ❌ LEGACY: npm scripts for backfill

**File:** [apps/worker/package.json](apps/worker/package.json) lines 29-30

```json
"job:backfill-card-results": "node src/jobs/backfill_card_results.js",
"job:backfill-card-results:dry-run": "node src/jobs/backfill_card_results.js --dry-run",
```

| Aspect | Status | Details |
|--------|--------|---------|
| **Related to settlement** | Tangential | Creates missing card_result rows from existing card_payloads |
| **Still needed** | Maybe | Only if there are orphaned card_payloads |
| **Recommendation** | **AUDIT then REMOVE** | Check if any cards lack results; if not, remove |

**Action items:**
1. Run: `SELECT COUNT(*) FROM card_payloads WHERE card_id NOT IN (SELECT DISTINCT card_id FROM card_results);`
2. If count = 0: Remove backfill script and npm scripts
3. If count > 0: Document why orphans exist and keep for production hotfix

---

## Integration Tests — Status

### [settlement-pipeline-integration.test.js](apps/worker/src/__tests__/settlement-pipeline-integration.test.js)

| Aspect | Status |
| --- | --- |
| **Covers** | Both Phase 1 + Phase 2 together |
| **Current state** | Likely outdated (Phase 2 logic is broken) |
| **Needs update** | Yes, rewrite after Phase 2 refactor |
| **Keep or remove** | KEEP, then update with hardened logic |

---

## Environment Variables — Settlement Control

| Variable | Default | Purpose |
| --- | --- | --- |
| `ENABLE_SETTLEMENT` | 'true' (enabled) | Toggles settlement in pull_odds_hourly |
| `ESPN_API_TIMEOUT_MS` | ❌ NOT SET | **Should exist**: ESPN fetch timeout |
| `SETTLEMENT_MIN_HOURS_AFTER_START` | ❌ NOT SET | **Should exist**: Min hours before settling (default 3) |
| `SETTLEMENT_MAX_RETRIES` | ❌ NOT SET | **Should exist**: ESPN API retry count (default 3) |
| `SETTLEMENT_ALERT_EMAIL` | ❌ NOT SET | **Should exist**: Alert recipient on repeated failure |

**Action:** Add missing env vars to .env.example and docs

---

## Removal Checklist — After Phase 1 Hardening

When Phase 1 (settle_game_results.js) is hardened and passing all resilience tests:

### Files to Remove

- [ ] `apps/worker/src/jobs/resettle_historical_cards.js` → archive
- [ ] `apps/worker/src/jobs/backfill_card_results.js` → archive (if audit shows no orphans)

### Files to Update

- [ ] [pull_odds_hourly.js](apps/worker/src/jobs/pull_odds_hourly.js) → optionally decouple settlement
- [ ] [settle_pending_cards.js](apps/worker/src/jobs/settle_pending_cards.js) → add top-level card filter
- [ ] [settlement-pipeline-integration.test.js](apps/worker/src/__tests__/settlement-pipeline-integration.test.js) → rewrite with new logic

### npm Scripts to Remove

- [ ] `job:backfill-card-results` (if orphan audit = 0)
- [ ] `job:backfill-card-results:dry-run` (if orphan audit = 0)

### Environment Variables to Add

- [ ] `ESPN_API_TIMEOUT_MS=30000` (30 second timeout)
- [ ] `SETTLEMENT_MIN_HOURS_AFTER_START=3`
- [ ] `SETTLEMENT_MAX_RETRIES=3`
- [ ] `SETTLEMENT_ALERT_EMAIL=ops@cheddar.com` (optional, for alerting)

---

## Decision: Settlement Scheduler Architecture

**Current State:**
```
┌──────────────────┐
│  pull_odds_hourly │   ← Runs hourly
└──────────────────┘
         ↓
    ┌─────────────┐
    │ settle_games│   ← Called as side-effect
    │ settle_cards│   ← Called as side-effect
    └─────────────┘
```

**Problem:** Settlement is low-priority "bonus" logic. If odds fetch fails, settlement is skipped.

**Options:**

**Option A: Keep as is (lightweight)**
- Settlement runs as side-effect of odds fetch
- Pros: Simple coupling, shared DB connection
- Cons: Invisible to monitoring, no independent scheduling

**Option B: Decouple with dedicated scheduler (recommended)**
- Independent cron/scheduler for settlement
- Runs on fixed cadence (e.g., every 4 hours, T+3 past game start)
- Pros: Independent monitoring, clear ownership, can retry independently
- Cons: Adds complexity, separate job runner

**Recommendation for Phase 1 Hardening:**
Start with **Option A** (keep coupled to odds fetch) but add comprehensive monitoring so failures are visible. In Phase 4 (production hardening), consider moving to **Option B** if production metrics justify the complexity.

---

## Exit Criteria — Phase 1 Complete

Definition of done for Phase 1 hardening:

- [ ] `settle_game_results.js` passes all resilience tests
- [ ] ESPN API retry logic (3 retries, exponential backoff) implemented
- [ ] Response validation (non-null scores, valid JSON, bounds checks) added
- [ ] Timeout safeguards (30s per request, 5m total job) implemented
- [ ] Monitoring/alerting traces added (structured logs, alert threshold)
- [ ] All legacy settlement code (resettle_historical_cards.js, backfill) removed
- [ ] Integration tests updated + passing
- [ ] Pull request passes all CI/CD checks
- [ ] One successful prod settlement run documented (ESPN data verified)



---

## References

- [SETTLEMENT_CANONICAL_WORKFLOW.md](SETTLEMENT_CANONICAL_WORKFLOW.md) — Three-phase design
- [SETTLEMENT_AUDIT.md](SETTLEMENT_AUDIT.md) — Gap analysis (legacy document)
- `apps/worker/src/jobs/settle_game_results.js` — Phase 1 implementation
- `apps/worker/src/jobs/settle_pending_cards.js` — Phase 2 implementation (needs refactor)
