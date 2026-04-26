---
phase: 4
plan: 1
name: Token-Safe Odds Fetch Architecture
type: phase-plan
autonomous: true
status: in-progress
started: 2026-03-25
---

# Phase 4 Plan: Token-Safe Odds Fetch Architecture (7-Day Execution)

## Incident Summary

T-minus pre-model pulls fired once-per-game instead of once-per-sport-per-window. On a 25-game night: 25 × 4 T-minus windows × 7 tokens = 700 tokens in a single evening. No budget enforcement, no circuit breaker, no dev environment wall. Both keys exhausted.

**After this plan:** Daily max ~105 tokens (96% reduction), dev permanently walled off from the API, scheduler self-governs based on live quota, system survives restart storms and 401s without burning tokens.

---

## Day 1 — Stop the Bleed (T-minus Dedup + Circuit Breaker)

**Task 1.1** Replace per-game pre-model odds push in `main.js` with a `preModelOddsQueued = new Set()` dedup guard keyed on `${sport}|T-${mins}` — one pull per sport per T-minus per tick, not per game. Update change comment from `UNCHANGED` to reflect new behavior.

**Task 1.2** Add `_apiKeyExhaustedAt` in-memory flag in `pull_odds_hourly.js` — on any HTTP 401 response, set flag and skip remaining sport fetches. On next invocation, check flag vs `ODDS_401_COOLDOWN_MS` (default 2h) before proceeding.

**Task 1.3** Test: `DRY_RUN=true` scheduler — confirm single odds pull per sport per T-minus window in logs. Set `ODDS_API_KEY=bad_key` — confirm circuit fires once and skips on second invocation.

> **Token math after Day 1:** 25-game day → 8 deduped T-minus pulls × 7 tokens = 56 + ~49 hourly baseline = **~105 tokens/day max**

---

## Day 2 — Dev Environment Hard Gate

**Task 2.1** Add a hard throw in `pull_odds_hourly.js` at entry: if `APP_ENV=local` and `ENABLE_ODDS_PULL=true`, throw with a clear message: "Dev environment must not hit the odds API — set ENABLE_ODDS_PULL=false or use prod DB read-only mount".

**Task 2.2** Update `.env` to `ENABLE_ODDS_PULL=false` for local. Update `env.example` with: `ENABLE_ODDS_PULL=false`, `ODDS_MONTHLY_LIMIT=20000`, `ODDS_BUDGET_RESERVE_PCT=15`, `ODDS_401_COOLDOWN_MS=7200000`.

**Task 2.3** Configure dev `CHEDDAR_DB_PATH` to point at prod DB via `sshfs babycheeses11@CheddarPi:/opt/data /mnt/cheddar-prod -o ro`. Confirm `getDatabaseReadOnly()` opens it (WAL mode allows concurrent readers, write lock stays with prod worker).

**Task 2.4** Add mount command to `ARCHITECTURE_SEPARATION.md`.

---

## Day 3 — Token Quota Migration + Ledger Writes

**Task 3.1** Create `packages/data/db/migrations/043_create_token_quota_ledger.sql`:
- Table `token_quota_ledger`: `provider`, `period` (YYYY-MM), `tokens_remaining`, `tokens_spent_session`, `monthly_limit`, `circuit_open_until`, `circuit_reason`, `last_updated`, `updated_by`
- Unique index on `(provider, period)`

**Task 3.2** Move circuit breaker from in-memory (Day 1) to DB-persisted — on startup `pull_odds_hourly.js` reads `circuit_open_until` from ledger; if future, return early. This survives process restarts.

**Task 3.3** Update `packages/odds/src/index.js` to return `remainingTokens` from the `x-requests-remaining` header as part of the fetch return payload (currently only logged, not returned).

**Task 3.4** In `pull_odds_hourly.js`: pessimistic pre-deduct before each sport fetch (`tokens_spent_session += tokenCost`), reconcile with actual `remainingTokens` after fetch, write to ledger.

---

## Day 4 — Tiered Throttle Logic in Scheduler

**Task 4.1** Write `getCurrentQuotaTier(db)` in `main.js` — reads ledger, computes tier:

| Tier | Condition | Slot multiplier | T-minus | Backstop |
|------|-----------|-----------------|---------|----------|
| `FULL` | >50% remaining | 1× | ✅ | ✅ |
| `MEDIUM` | 25–50% | 2× | ❌ | ❌ |
| `LOW` | 10–25% | 4× (max 6h) | ❌ | ❌ |
| `CRITICAL` | <10% | hard stop | ❌ | ❌ |

**Task 4.2** Add burn rate projection: `projected_monthly = (tokens_spent_today / hours_elapsed_today) × 24 × 30`. If projected > `monthly_limit × (1 - BUDGET_RESERVE_PCT)`, force `MEDIUM` regardless of `tokens_remaining`.

**Task 4.3** Wire tier check into tick start in `main.js` — gate T-minus pushes and backstop pushes on tier. Wire mid-loop tier re-check in `pull_odds_hourly.js` sport loop — if tier drops to `CRITICAL` mid-run, abort remaining sports.

---

## Day 5 — Integration Testing + Simulation

**Task 5.1** Simulate `CRITICAL` tier: `INSERT INTO token_quota_ledger (tokens_remaining=500, monthly_limit=20000)` — confirm no fetch jobs queue in dry-run.

**Task 5.2** Simulate burn rate alarm: insert high `tokens_spent_session` rows — confirm tier forces to `MEDIUM`.

**Task 5.3** Simulate restart storm: start scheduler with `TICK_MS=5000`, kill 3× mid-tick — confirm T-minus dedup and DB-persisted circuit breaker survive.

**Task 5.4** Simulate 25-game night: inject 25 games via DB, run one tick, count `pull_odds_hourly` jobs queued — confirm ≤8 (one per sport per T-minus window).

---

## Day 6 — Observability

**Task 6.1** Add tier transition log in `main.js`: `[QUOTA] Tier changed: FULL → MEDIUM (tokens_remaining=4823, burn_rate=210/day, projected=6300/month)`.

**Task 6.2** Add daily summary job: at `09:00 ET`, log tokens spent since midnight, projected month-end balance, current tier and what would change it.

**Task 6.3** Update `analyze_odds_api_quota.py` to read from `token_quota_ledger` table instead of raw log parsing.

**Task 6.4** Final `env.example` review — every new var documented with purpose and safe default.

---

## Day 7 — Buffer + Prod Readiness

**Task 7.1** Fix any edge cases found in Day 5 testing.

**Task 7.2** Add a comment block at the top of the T-minus section in `main.js` documenting the March 2026 incident, what the token math looks like now, and why dedup is critical.

**Task 7.3** Verify prod `.env` is the only place with `ENABLE_ODDS_PULL=true`. Confirm `ODDS_MONTHLY_LIMIT=20000` is set.

**Task 7.4** Final `DRY_RUN=true` end-to-end pass — confirm token tier is read, logged, and jobs are gated correctly.

---

## Verification

```bash
# Confirm token math after Day 1
DRY_RUN=true node apps/worker/src/schedulers/main.js 2>&1 | grep -c "pull_odds_hourly"
# Should show ≤8 on a 25-game day (not 80+)

# Confirm circuit breaker persists across restart
ODDS_API_KEY=bad node apps/worker/src/jobs/pull_odds_hourly.js
# restart
node apps/worker/src/jobs/pull_odds_hourly.js  # should skip immediately

# Confirm dev wall
APP_ENV=local ENABLE_ODDS_PULL=true node -e "require('./apps/worker/src/jobs/pull_odds_hourly').pullOddsHourly()"
# should throw
```

---

## Decisions

- **Dev:** read-only prod DB via sshfs — no env var typo can spend tokens
- **Tiered throttle:** T-minus + backstop shut off first at MEDIUM, hourly baseline preserved until CRITICAL
- **Circuit breaker:** DB-persisted (survives restarts) not in-memory — Day 1 ships in-memory, Day 3 upgrades to DB
- **`x-requests-remaining` header** is already returned by every API call — no separate quota endpoint needed

---

## Progress

| Day | Tasks | Status |
|-----|-------|--------|
| Day 1 | T-minus dedup + in-memory circuit breaker | ⬜ |
| Day 2 | Dev env hard gate + env vars | ⬜ |
| Day 3 | Migration 043 + DB-persisted circuit + ledger writes | ⬜ |
| Day 4 | Tiered throttle + burn rate projection | ⬜ |
| Day 5 | Integration tests + simulation | ⬜ |
| Day 6 | Observability | ⬜ |
| Day 7 | Buffer + prod readiness | ⬜ |
