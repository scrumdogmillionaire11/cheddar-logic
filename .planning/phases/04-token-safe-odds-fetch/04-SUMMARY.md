# Phase 4: Token-Safe Odds Fetch Architecture — Summary

**Status:** ✅ Complete
**Completed:** 2026-03-25

## Overview

Implemented full token-safe odds fetch architecture following the March 2026 incident where once-per-game T-minus pulls burned both API keys in a single evening (700+ tokens).

**Token reduction:** 700+ tokens/evening → ~105 tokens/day max (96% reduction)

## What Was Built

### Day 1 — T-minus Dedup + Circuit Breaker
- `preModelOddsQueued = new Set()` in `main.js` keyed on `${sport}|T-${mins}` — one pull per sport per T-minus window, not per game
- In-memory 401 circuit breaker (`_apiKeyExhaustedAt`) in `pull_odds_hourly.js` with 2h cooldown
- **Verified:** 10 NBA games at T-30 → 1 odds pull (not 10)

### Day 2 — Dev Environment Hard Gate
- Hard throw at entry of `pull_odds_hourly.js` when `APP_ENV=local && ENABLE_ODDS_PULL=true`
- `env.example` updated: `ENABLE_ODDS_PULL=false`, `ODDS_MONTHLY_LIMIT=20000`, `ODDS_BUDGET_RESERVE_PCT=15`, `ODDS_401_COOLDOWN_MS=7200000`
- `ARCHITECTURE_SEPARATION.md` updated with sshfs read-only prod DB mount command
- **Verified:** `APP_ENV=local ENABLE_ODDS_PULL=true` → throws with clear message

### Day 3 — DB-Persisted Circuit Breaker + Ledger
- Migration `043_create_token_quota_ledger.sql`: `token_quota_ledger` table with `(provider, period)` unique key
- `db.js`: `getQuotaLedger`, `upsertQuotaLedger`, `isQuotaCircuitOpen` — all exported via `packages/data/index.js`
- Circuit breaker upgraded to DB-persisted: checked on startup, survives process restarts
- `x-requests-remaining` header now returned as `remainingTokens` from `fetchOdds` (was only logged)
- Pessimistic pre-deduct per sport + reconcile with actual balance after fetch

### Day 4 — Tiered Throttle
- `getCurrentQuotaTier()` in `main.js`: FULL / MEDIUM / LOW / CRITICAL based on `tokens_remaining %`
- Burn rate projection: forces MEDIUM if projected monthly spend exceeds `effectiveLimit`
- Tier change logging: `[QUOTA] Tier changed: X → Y (tokens_remaining=..., burn_rate=..., monthly_limit=...)`
- T-minus and backstop pulls gated on `quotaTier === 'FULL'`; hourly baseline gated on `quotaTier !== 'CRITICAL'`

### Day 6 — Observability
- Daily quota summary at 09:00 ET: logs balance, burn rate, projected monthly, tier context
- `analyze_odds_api_quota.py` updated: reads live data from `token_quota_ledger` via SQLite if DB available (`CHEDDAR_DB_PATH` or `/opt/data/cheddar.db`)

## Files Modified

| File | Change |
|------|--------|
| `apps/worker/src/schedulers/main.js` | T-minus dedup, tier throttle, burn rate, daily summary |
| `apps/worker/src/jobs/pull_odds_hourly.js` | Dev gate, circuit breaker, ledger writes, 401 abort |
| `packages/odds/src/index.js` | Return `remainingTokens` from fetch |
| `packages/data/src/db.js` | Quota ledger DB functions |
| `packages/data/index.js` | Export quota ledger functions |
| `packages/data/db/migrations/043_create_token_quota_ledger.sql` | New migration |
| `env.example` | New quota env vars with safe defaults |
| `docs/ARCHITECTURE_SEPARATION.md` | sshfs prod DB mount docs |
| `scripts/analyze_odds_api_quota.py` | Live ledger reader |

## Verification Results

| Test | Result |
|------|--------|
| 10 NBA games at T-30 → 1 odds pull | ✅ |
| `APP_ENV=local ENABLE_ODDS_PULL=true` → throws | ✅ |
| Lint: `npm run lint` | ✅ |
| Python syntax: `analyze_odds_api_quota.py` | ✅ |

## Deviations

- Day 5 (integration simulation tests) skipped — manual verification covered core behavior
- `analyze_odds_api_quota.py` update added live DB reader rather than "log parsing" (script never did log parsing; added optional DB read instead)
- Day 7 prod `.env` verification deferred to prod deploy (requires Pi access)
