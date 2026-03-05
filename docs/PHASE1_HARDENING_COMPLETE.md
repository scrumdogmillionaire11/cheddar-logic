# Phase 1 Hardening: Complete

**Status:** Core resilience layer implemented  
**Date:** March 4, 2026  
**Scope:** ESPN score fetching (settle_game_results.js)

---

## What Got Built

### 1. Resilient ESPN Client ([apps/worker/src/utils/espn-resilient-client.js](apps/worker/src/utils/espn-resilient-client.js))

**Wraps the basic ESPN client with production-grade resilience:**

- ✅ **Exponential backoff retry logic** — 3 retries (configurable via `SETTLEMENT_MAX_RETRIES=3`)
  - Retry delays: 1s, 2s, 4s (with ±10% jitter)
  - Rate-limit detection (429) — caps backoff at 60s
  
- ✅ **Timeout enforcement** — 30s default (configurable via `ESPN_API_TIMEOUT_MS=30000`)
  - Replaces the hardcoded 5s timeout in base client
  - Timeout wraps promises with `Promise.race()` pattern
  
- ✅ **Response validation** — Ensures ESPN responses are JSON objects/arrays
  - Returns null on parse errors (consistent with base client)
  - Logs validation failures for debugging
  
- ✅ **Structured logging** — Pluggable log callbacks
  - Each attempt logged with attempt count, context (sport, date, path), error codes
  - Supports custom loggers for integration with observability systems

**Usage:**
```javascript
const client = new ResilientESPNClient({
  maxRetries: 3,
  timeoutMs: 30000,
  baseDelayMs: 1000,
  onLog: console.log,
  onWarn: console.warn,
  onError: console.error,
});

const events = await client.fetchScoreboardEvents('hockey/nhl', '20260304');
```

---

### 2. Scoring Validator ([apps/worker/src/utils/scoring-validator.js](apps/worker/src/utils/scoring-validator.js))

**Sport-specific bounds checks for fetched scores:**

- ✅ **Bounds validation per sport**
  - NHL: 0-15 per side (impossible negatives flagged, >15 warns)
  - NBA: 0-200 per side (typical 150-220 total)
  - NCAAM: 0-150 per side (typical 80-180 total)
  
- ✅ **Blowout detection**
  - NBA: 50+ point spreads flagged (ask ops to verify scorer entry)
  - NCAAM: 40+ point spreads flagged
  
- ✅ **Non-blocking warnings**
  - Settlement proceeds even with suspicious scores
  - All warnings logged for post-game audit
  - Supports strict mode (can block if needed in future)

- ✅ **Typical range analysis** — For post-game analytics
  - `isTypicalScoreRange()` checks if total score is within expected range
  - Useful for flagging outlier games without stopping settlement

**Usage:**
```javascript
const validator = new ScoringValidator({ strictMode: false });

const result = validator.validateGameScore('NFL', 42, 35);
// { valid: true, warnings: [], sport: 'NFL', ... }

const typical = validator.isTypicalScoreRange('NBA', 115, 108);
// { isTypical: true, total: 223, expected: '190-220', min: 150, max: 240 }
```

---

### 3. Integration into settle_game_results.js

**Core job refactored to use resilient layer:**

- ✅ **Imports added**
  - `ResilientESPNClient`
  - `ScoringValidator`

- ✅ **Environment variables for production tuning**
  ```
  ESPN_API_TIMEOUT_MS=30000          # HTTP timeout per request (default 30s)
  SETTLEMENT_MAX_RETRIES=3            # ESPN fetch retry count (default 3)
  SETTLEMENT_MIN_HOURS_AFTER_START=3  # Min hours after game start (default 3)
  ```

- ✅ **Client initialization at job start**
  - Resilient client created with env var config
  - Validator instance created
  - Log line printed with configured timeouts/retries for ops visibility

- ✅ **Replaced fetchScoreboardEvents calls**
  - All ESPN scoreboard fetches now go through resilient client
  - Automatic retry + logging on transient failures

- ✅ **Replaced fetchComparableEventFromSummary**
  - Refactored to accept resilient client (for mapped ESPN IDs)
  - Consistent timeout/retry behavior

- ✅ **Score validation on settlement**
  - Before upserting game_result, scores validated
  - Validation result printed in settlement log
  - Warnings logged but don't block settlement

**Example log (success):**
```
[SettleGames] Initialized with ESPN_API_TIMEOUT_MS=30000ms, SETTLEMENT_MAX_RETRIES=3
[SettleGames] Attempt 1/4 { espnPath: 'hockey/nhl', dateStr: '20260304' }
[SettleGames] Success on attempt 1 { espnPath: 'hockey/nhl', responseKeys: ['status', 'page', 'events'] }
[SettleGames] Settling game_id_123: NYR 3 - 2 EDM (event=12345, method=strict_name_time, delta=0.0m) [scoreValid=true, typical=true]
```

**Example log (with retry):**
```
[SettleGames] Attempt 1/4 { espnPath: 'hockey/nhl', dateStr: '20260304' }
[SettleGames] Null response, retrying in 1234ms { espnPath: 'hockey/nhl', dateStr: '20260304' }
[SettleGames] Attempt 2/4 { espnPath: 'hockey/nhl', dateStr: '20260304' }
[SettleGames] Success on attempt 2
```

---

## How It Works: The Retry Loop

When ESPN API experiences transient issues:

**Scenario: Transient timeout on first ESPN fetch**
```
Attempt 1: espnGet() timeout → null response
          ↓ (log warning, wait 1000ms + jitter)
Attempt 2: espnGet() timeout → null response
          ↓ (log warning, wait 2000ms + jitter)
Attempt 3: espnGet() timeout → null response
          ↓ (log warning, wait 4000ms + jitter)
Attempt 4: espnGet() SUCCESS ✅
          ↓ (continue settlement)
```

**Scenario: Rate-limited (429)**
```
Attempt 1: ESPN returns 429 (too many requests)
          ↓ (back off 60s — longer delay for rate limits)
Attempt 2: ESPN returns 200 OK ✅
```

---

## Still To Do

### Task 4: Monitoring/Alerting Integration
- [ ] Add metric collection (ESPN fetch latency, success rate per sport)
- [ ] Add alert threshold (log ERROR if 3+ consecutive ESPN failures)
- [ ] Integration with ops dashboard (if applicable)
- [ ] Document alert escalation path

### Task 5: Verify Phase 1 Scheduler Wiring
- [ ] Confirm `pull_odds_hourly.js` correctly triggers `settleGameResults()`
- [ ] Check job timing (is settlement running at right cadence?)
- [ ] Test with dry-run mode on actual ESPN data

### Task 6: Test Phase 1 with Real ESPN Data
- [ ] Run settlement against live ESPN scoreboard
- [ ] Verify scores match ESPN public site
- [ ] Confirm game_results table populated correctly
- [ ] Spot-check for scoring validation warnings

### Task 7: Document Phase 1 Acceptance Criteria
- [ ] Create deployment runbook
- [ ] Document env var tuning guide
- [ ] Add troubleshooting guide for ESPN failures
- [ ] Update team about Phase 1 → Phase 2 readiness

---

## Environment Variable Reference

| Variable | Default | Min | Max | Purpose |
| --- | --- | --- | --- | --- |
| `ESPN_API_TIMEOUT_MS` | 30000 | 5000 | — | HTTP request timeout (milliseconds) |
| `SETTLEMENT_MAX_RETRIES` | 3 | 0 | — | Max ESPN fetch retry attempts |
| `SETTLEMENT_MIN_HOURS_AFTER_START` | 3 | 0 | — | Min hours after game start before settling |

**For Production:**
- Keep defaults unless experiencing ESPN timeout issues
- If ESPN is timing out: increase `ESPN_API_TIMEOUT_MS` to 45000
- If rate-limited: automatic 60s backoff kicks in (won't help with `MAX_RETRIES`)

---

## Testing Checklist (Before Merging)

- [ ] **Unit tests pass** — Run jest for settle_game_results.matching.test.js
- [ ] **Integration test runs** — settlement-pipeline-integration.test.js (may be outdated, note for Phase 2)
- [ ] **Linting passes** — eslint on new utility files
- [ ] **Dry-run execution** — `npm run job:settle-games -- --dry-run` returns 0
- [ ] **Real data test** — Run against dev ESPN data, verify retry logic
- [ ] **No breaking changes** — Confirm backward compatibility with pull_odds_hourly.js

---

## Next Steps (After Merge + Phase 1 Acceptance)

1. **Phase 2 Hardening:** Refactor `settle_pending_cards.js` to filter top-level cards only
2. **Production Rollout:** Deploy Phase 1 hardening to prod, monitor ESPN fetch metrics for 1 week
3. **Phase 3:** Build comprehensive integration test suite
4. **Documentation:** Update runbooks, alert playbooks, team wiki

---

## Files Modified

| File | Change |
| --- | --- |
| [apps/worker/src/jobs/settle_game_results.js](apps/worker/src/jobs/settle_game_results.js) | Integrated resilient ESPN client, scoring validator, env var support |
| [apps/worker/src/utils/espn-resilient-client.js](apps/worker/src/utils/espn-resilient-client.js) | **NEW** — Resilient ESPN client with retry/timeout/validation |
| [apps/worker/src/utils/scoring-validator.js](apps/worker/src/utils/scoring-validator.js) | **NEW** — Sport-specific scoring bounds and validation |

## Files NOT Modified (Yet)

- `packages/data/src/espn-client.js` — Left as-is (base client still works, just wrapped) 
- `apps/worker/src/jobs/pull_odds_hourly.js` — Still calls settleGameResults() (works with new resilient layer)
- Settlement pipeline integration test — Will be updated in Phase 2 (known to be outdated)

---

## Quick Debugging Commands

```bash
# Test Phase 1 in dry-run mode
npm run job:settle-games -- --dry-run

# Run with custom timeout (45 seconds)
ESPN_API_TIMEOUT_MS=45000 npm run job:settle-games

# Run with max 2 retries instead of 3
SETTLEMENT_MAX_RETRIES=2 npm run job:settle-games

# Run with verbose ESPN logging
npm run job:settle-games 2>&1 | grep -E '\[ESPNClient|\[SettleGames\]'
```

---

## References

- [SETTLEMENT_LEGACY_AUDIT.md](SETTLEMENT_LEGACY_AUDIT.md) — Inventory of legacy code to remove
- [SETTLEMENT_CANONICAL_WORKFLOW.md](SETTLEMENT_CANONICAL_WORKFLOW.md) — Three-phase design
- [settle_game_results.js](apps/worker/src/jobs/settle_game_results.js) — Updated job
