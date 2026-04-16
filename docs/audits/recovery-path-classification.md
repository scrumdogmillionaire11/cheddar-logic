# WI-0907: Recovery-Path Classification Audit

**Created**: 2026-04-16 | **Phase**: Phase 1 (Enumeration) → Phase 2 (Classification)

---

## Purpose

Enumerate and classify all missing/inconsistent input recovery paths across worker, model, and web layers into 6 recovery buckets: hard-fail, soft-pass, degraded-output, hidden-output, retry, fallback.

This audit:
- Maps each failure scenario to current handler code
- Identifies silent degradations (no reason code, masked errors)
- Validates consistency across sports (NBA/NHL/MLB)
- Feeds Phase 4 (code wiring) and Phase 5 (validation)

---

## Failure Scenario Enumeration (Phase 1)

### Execution Gate (apps/worker/src/jobs/execution-gate.js)

| Scenario | Triggered When | Current Handler | Emits Code | blocked_by | Visibility | Status |
|----------|---|---|---|---|---|---|
| Model status non-OK | `modelStatus !== 'MODEL_OK'` | Push to `blocked_by` | ✅ Yes | `MODEL_STATUS_${status}` | execution_gate | Classified |
| No edge computed | `!hasRawEdge` | Push to `blocked_by` | ✅ Yes | `NO_EDGE_COMPUTED` | execution_gate | Classified |
| Net edge insufficient | `netEdge < minNetEdge` | Push to `blocked_by` | ✅ Yes | `NET_EDGE_INSUFFICIENT:${value}` | execution_gate | Classified |
| Confidence below threshold | `confidence < minConfidence` | Push to `blocked_by` | ✅ Yes | `CONFIDENCE_BELOW_THRESHOLD:${value}` | execution_gate | Classified |
| Snapshot expired (EXPIRED tier) | Age > hardMax | Push freshness block | ✅ Yes | `STALE_SNAPSHOT:EXPIRED_HARDMAX:${age}` | execution_gate | Classified |
| Snapshot stale within grace | Age > cadence, < hardMax | Conditional block + flag | ✅ Yes | `STALE_SNAPSHOT:VALID_WITHIN_CADENCE:${age}` | execution_gate | Classified |
| Snapshot age unknown | `!hasSnapshotAge` | Skip freshness eval | ⚠️ Partial | (no block) | execution_gate | Needs gap fill |
| Mixed book source mismatch | `lineSource !== priceSource` | Push to `blocked_by` | ✅ Yes | `MIXED_BOOK_SOURCE_MISMATCH:${src}` | execution_gate | Classified |
| Calibration kill switch active | Check flag | Push to `blocked_by` | ✅ Yes | `CALIBRATION_KILL_SWITCH` | execution_gate | Classified |

**Findings**: execution-gate emits reason codes for all major paths. **Status: Complete for worker gate layer.**

---

### Decision Pipeline (packages/models/src/decision-pipeline-v2.js)

| Scenario | Triggered When | Current Handler | Emits Code | Reason Set | Visibility | Status |
|----------|---|---|---|---|---|---|
| Consistency missing | Decision state incomplete | Watchdog block | ✅ Yes | `WATCHDOG_CONSISTENCY_MISSING` | reason_codes array | Classified |
| Parse failure | Decision parse error | Watchdog block | ✅ Yes | `WATCHDOG_PARSE_FAILURE` | reason_codes array | Classified |
| Stale snapshot detected | Timestamp gate triggered | Watchdog block | ✅ Yes | `WATCHDOG_STALE_SNAPSHOT` | reason_codes array | Classified |
| Stale market input | Market data freshness fail | Watchdog block | ✅ Yes | `STALE_MARKET_INPUT` | reason_codes array | Classified |
| Market unavailable | No market data | Watchdog block | ✅ Yes | `WATCHDOG_MARKET_UNAVAILABLE` | reason_codes array | Classified |
| Goalie unconfirmed (NHL) | Uncertain goalie ID | Watchdog hold | ✅ Yes | `GOALIE_UNCONFIRMED` | reason_codes array | Classified |
| Goalie conflicting (NHL) | Conflicting goalie data | Watchdog hold | ✅ Yes | `GOALIE_CONFLICTING` | reason_codes array | Classified |
| Injury uncertain | Status unknown | Watchdog hold | ✅ Yes | `INJURY_UNCERTAIN` | reason_codes array | Classified |
| Edge clear (price OK) | netEdge > threshold | No block | ✅ Yes | `EDGE_CLEAR` | reason_codes array | Classified |
| No edge at current price | Price fails edge test | Price downgrade | ✅ Yes | `NO_EDGE_AT_PRICE` | reason_codes array | Classified |
| Market price missing | Price data missing | Price downgrade | ✅ Yes | `MARKET_PRICE_MISSING` | reason_codes array | Classified |
| Model prob missing | Model prob missing | Price downgrade | ✅ Yes | `MODEL_PROB_MISSING` | reason_codes array | Classified |
| Sigma fallback degraded | Fallback sigma used | Price downgrade | ✅ Yes | `SIGMA_FALLBACK_DEGRADED` | reason_codes array | Classified |
| Heavy favorite price cap | Wager > threshold | Price cap | ✅ Yes | `HEAVY_FAVORITE_PRICE_CAP` | reason_codes array | Classified |
| Play contradiction capped | Contradiction detected | Price cap | ✅ Yes | `PLAY_CONTRADICTION_CAPPED` | reason_codes array | Classified |

**Findings**: decision-pipeline-v2 has comprehensive watchdog and price reason codes. **Status: Complete for decision layer.**

---

### Model Runners: NBA (apps/worker/src/jobs/run_nba_model.js)

| Scenario | Triggered When | Current Handler | Emits Code | Log/Output | Visibility | Status |
|----------|---|---|---|---|---|---|
| ESPN null metrics (team) | Missing player data | Swallow + silent log | ❌ No | `[ESPN_NULL]` log only | Logs only | **SILENT GAP** |
| Availability gate DB error | DB query fails | Fail-open + comment | ❌ No | `[availability]` error log | Logs only | **SILENT GAP** |
| Line delta computation error | lineDelta calc fails | Catch + return null | ⚠️ Partial | Error logged, null returned | Logs only | **SILENT GAP** |
| Missing lineContext | lineContext validation | Return null | ❌ No | No log, null silently | Silent | **SILENT GAP** |
| Missing capturedAt | capturedAt validation | Return null | ❌ No | No log, null silently | Silent | **SILENT GAP** |
| Invalid capturedAtMs | Timestamp parse fail | Return null | ❌ No | No log, null silently | Silent | **SILENT GAP** |

**Findings**: NBA has multiple silent degradation paths. No reason codes emitted. **Status: Multiple SILENT GAPS identified — Phase 4 action required.**

---

### Model Runners: NHL (apps/worker/src/jobs/run_nhl_model.js)

| Scenario | Triggered When | Current Handler | Emits Code | Log/Output | Visibility | Status |
|----------|---|---|---|---|---|---|
| Missing inputs (all 4 core ESPN metrics) | Missing all 4 ESPN stats | Watchdog block | ✅ Yes | `CONSISTENCY_MISSING` in watchdog_reason_codes | decision envelope | Classified |
| Consistency missing (partial ESPN data) | Some ESPN metrics missing | Watchdog block | ✅ Yes | `CONSISTENCY_MISSING` in watchdog_reason_codes | decision envelope | Classified |
| ESPN null alert send error | Discord webhook fails | Swallow + log | ❌ No | `[NHLModel] Failed to send ESPN null alert` log only | Logs only | **SILENT GAP** |
| Snapshot timestamp resolver error | Timestamp resolver fails | Fallback + log | ⚠️ Partial | `[NHLModel] Snapshot timestamp resolver failed` + violations object | Audit invariants | Partial |
| Stale recovery refresh error | ODDs refresh fails | Swallow + log | ❌ No | `[NHLModel] stale recovery refresh failed` log only | Logs only | **SILENT GAP** |
| Stale recovery snapshot reload error | Snapshot reload fails | Swallow + log | ❌ No | `[NHLModel] stale recovery snapshot reload failed` log only | Logs only | **SILENT GAP** |
| Game ID invalid (getGameIdIfValid) | gameId is falsy | Return null | ❌ No | No log, null silently | Silent | **SILENT GAP** |
| Invariant breach (enforcement) | Invariant failed | Throw error + log | ✅ Yes | Error with code/level | Error thrown | Classified (error path) |

---

### Model Runners: MLB (apps/worker/src/jobs/run_mlb_model.js)

| Scenario | Triggered When | Current Handler | Emits Code | Log/Output | Visibility | Status |
|----------|---|---|---|---|---|---|
| Timestamp invalid or missing | `!timestamp` | Return null | ❌ No | No log, null silently | Silent | **SILENT GAP** |
| Timestamp parse failure | Timestamp non-numeric | Return null | ❌ No | No log, null silently | Silent | **SILENT GAP** |
| Timestamp age invalid | `ageMs < 0` or non-finite | Return null | ❌ No | No log, null silently | Silent | **SILENT GAP** |
| Bullpen context missing history | DB missing bullpen history | Fallback neutral context | ⚠️ Partial | Return `BULLPEN_CONTEXT_MISSING_HISTORY` | Model inference | Partial |
| Bullpen context query error | DB query fails | Fallback neutral context | ⚠️ Partial | Return `BULLPEN_CONTEXT_QUERY_ERROR` | Model inference | Partial |
| Neutral value coercion | Value null/empty/undefined | Return null | ❌ No | No log, null silently | Silent | **SILENT GAP** |
| Price invalid (0 or non-finite) | Price validation fails | Return null | ❌ No | No log, null silently | Silent | **SILENT GAP** |
| Market price missing | No price data | Block with reason | ✅ Yes | `MARKET_PRICE_MISSING` in blockingReasonCodes | decision envelope | Classified |
| Snapshot timestamp resolver error | Timestamp resolver fails | Fallback + log | ⚠️ Partial | `[MLBModel] Snapshot timestamp resolver failed` + violations object | Audit invariants | Partial |
| Stale recovery refresh error | Odds refresh fails | Swallow + log | ❌ No | `[MLBModel] stale recovery refresh failed` log only | Logs only | **SILENT GAP** |
| Stale recovery snapshot reload error | Snapshot reload fails | Swallow + log | ❌ No | `[MLBModel] stale recovery snapshot reload failed` log only | Logs only | **SILENT GAP** |
| Game ID invalid (getGameIdIfValid) | gameId is falsy | Return null | ❌ No | No log, null silently | Silent | **SILENT GAP** |
| Pricing status MISSING | No pricing | Block reason assigned | ⚠️ Partial | `pricingReason` or `'pricing_status=MISSING'` | Audit object | Partial |

---

### Web Routes: route-handler.ts

| Scenario | Triggered When | Current Handler | Emits Code | API Output | Visibility | Status |
|----------|---|---|---|---|---|---|
| Execution gate drop_reason present | card/play blocked at gate | Normalize + surface | ✅ Yes | `execution_gate.drop_reason` | API debug metadata | Classified |
| Decision watchdog block | decision_v2 watchdog fired | Include in reason_codes | ✅ Yes | `reason_codes` array | API response | Classified |
| Decision reason fallback | No watchdog, use primary | Cascade through layers | ✅ Yes | `reason_codes` array | API response | Classified |
| Transform drop_reason payload | Transform emits drop info | Pass through + expose | ✅ Yes | `transform_meta.drop_reason` | API response | Classified |

**Findings**: route-handler normalizes and surfaces reason codes. **Status: Complete for API layer.**

---

### Web Transform: transform/index.ts

| Scenario | Triggered When | Current Handler | Emits Code | Output Field | Visibility | Status |
|----------|---|---|---|---|---|---|
| Explicit execution gate drop | drop_reason with code/layer | Normalize + use | ✅ Yes | `transform_meta.drop_reason` | Card transform | Classified |
| Watchdog firing (decision_v2) | Watchdog reason present | Check + use as fallback | ✅ Yes | Derivable from envelope | Card transform | Classified |
| No explicit reason at all | Silent swallow path | Derive from envelope | ⚠️ Partial | May not emit reason | Card transform | **GAP** |
| Price tier decision (PLAY/LEAN) | Decision price logic | Emit as envelope primary | ✅ Yes | `transform_meta.drop_reason` | Card transform | Classified |

**Findings**: transform has fallback cascading but may miss reason emission in edge cases. **Status: Mostly classified, minor GAP identified.**

---

## Recovery Bucket Mapping (Phase 2 Draft)

### Updated Classification Status (with NHL/MLB trace)

| Recovery Bucket | Count | Example Paths | Status |
|---|---|---|---|
| **hard-fail** | 9 | Model status non-OK, no edge computed, calibration kill switch, EXPIRED freshness, mixed book mismatch, timestamp invalid/missing/parse-fail, game ID invalid (all 3 sports) | ✅ Classified |
| **soft-pass** | 8 | EDGE_CLEAR, within-cadence stale, pass-through decision envelope, edge verification required, availability gate degraded (NBA) | ✅ Classified |
| **degraded-output** | 10 | SIGMA_FALLBACK_DEGRADED, price cap, wager mismatch, heavy favorite price, stale within grace, line delta null (NBA), bullpen context missing/error (MLB), timestamp age invalid (MLB) | ✅ Classified |
| **hidden-output** | 14 | ESPN null silent (NBA/NHL), line delta null (NBA), missing lineContext (NBA), neutral value coercion (MLB), null returns without log (NHL/MLB), ESPN null alert error (NHL), pricing status MISSING (MLB), refresh/reload errors (NHL/MLB), game ID null (NHL/MLB) | ❌ SILENT — Needs remediation |
| **retry** | 1 | Freshness STALE_VALID with retry flag | ⚠️ Partial |
| **fallback** | 12 | Decision envelope fallback cascade, play contradiction capped, model prob missing, market price missing, bullpen neutral context (MLB), timestamp resolver fallback (NHL/MLB), pricing status handling (MLB) | ✅ Classified |

**Summary**:
- ✅ **68% classified** (40 of 59 paths where 59 = 33 initial + 26 from NHL/MLB trace)
- ❌ **14 silent degradations** need reason-code instrumentation (expanded from initial 3)
- ⚠️ **2 partial paths** need clarity on retry vs fallback semantics  
- ✅ **Cross-sport consistency improving** — same patterns (missing inputs, null returns) across all 3 sports

---

## Silent Degradation Discovery

### Critical Gaps Identified (Phase 4 action required)

#### NBA Gaps (3 paths)

1. **ESPN Null Metrics** — Entry: `run_nba_model.js:173-175` — Silent log `[ESPN_NULL]`, no reason-code
2. **Availability Gate DB Error** — Entry: `run_nba_model.js:371-373` — Fail-open, no reason-code
3. **Line Delta Null Return** — Entry: `run_nba_model.js:505-514` — Error logged, null returned silently

#### NHL Gaps (4 paths)

4. **ESPN Null Alert Error** — Entry: `run_nhl_model.js:373-376` — Swallow + silent log
5. **Stale Recovery Refresh Error** — Entry: `run_nhl_model.js:948-953` — Warn log only, no reason-code
6. **Stale Recovery Snapshot Reload Error** — Entry: `run_nhl_model.js:961-962` — Warn log only, no reason-code  
7. **Game ID Invalid** — Entry: `run_nhl_model.js:869` — Return null, no context

#### MLB Gaps (7 paths)

8. **Timestamp Invalid/Missing** — Entry: `run_mlb_model.js:739` — Return null silently
9. **Timestamp Parse Failure** — Entry: `run_mlb_model.js:741` — Return null silently
10. **Timestamp Age Invalid** — Entry: `run_mlb_model.js:743` — Return null silently
11. **Neutral Value Coercion** — Entry: `run_mlb_model.js:140` — Return null silently
12. **Price Invalid** — Entry: `run_mlb_model.js:1717` — Return null silently
13. **Stale Recovery Refresh Error** — Entry: `run_mlb_model.js:2143-2148` — Warn log only, no reason-code
14. **Stale Recovery Snapshot Reload Error** — Entry: `run_mlb_model.js:2156` — Warn log only, no reason-code

**Action Plan**: Add structured reason-codes to all 14 paths with appropriate recovery bucket assignment (Phase 4).

---

## Cross-Sport Consistency Matrix

| Failure Class | NBA | NHL | MLB | Consistency | Note |
|---|---|---|---|---|---|
| Model status non-OK | execution_gate | TBD | TBD | pending | Execution gate handles uniformly |
| Missing key stats | ❌ Silent | ❌ Silent* | ❌ Silent* | **INCONSISTENT** | All three have gaps |
| Stale data | ✅ `STALE_SNAPSHOT` | TBD | TBD | pending | Execution gate unified |
| Freshness tier gate | ✅ Yes | TBD | TBD | pending | Should be uniform across sports |
| Goalie/Player injury | ✅ Watchdog | TBD | TBD | pending | Should be uniform |

*Pending detailed trace of NHL and MLB runners.

---

## Mapper Prompt Directive (Future Reference)

For CONFIG_AND_STATE_TRUTH_AUDIT in mapper system prompt (Phase 4):

> When introducing new input handling or fallback logic in model runners:
> 1. Classify the path: hard-fail | soft-pass | degraded-output | hidden-output | retry | fallback
> 2. Emit machine-readable reason-code to reason_codes array or execution_gate.blocked_by
> 3. Don't return null/undefined without reason — always emit reason (log + metadata)
> 4. Test path by injecting the failure scenario and verifying reason code in API response
> 5. Cross-check against same class in other sports for consistency (e.g., missing stats in NBA should emit same code as missing stats in NHL)

---

## Phase 2 Deliverable Checklist

- [ ] Trace NHL runner (run_nhl_model.js) for all missing data paths
- [ ] Trace MLB runner (run_mlb_model.js) for all missing data paths
- [ ] Audit decision-pipeline-v2 for any unlisted watchdog/price paths
- [ ] Confirm 6-bucket classification for all 33 detected scenarios
- [ ] Mark each as: `hard-fail`, `soft-pass`, `degraded-output`, `hidden-output`, `retry`, or `fallback`
- [ ] Identify any additional silent paths not listed
- [ ] Validate cross-sport consistency (same failure class → same reason code)
- [ ] Update matrix in Phase 3 audit doc

---

## Phase 3 Documentation Scope

Will update this file with:
1. **Classification Matrix** — all 33+ scenarios grouped by bucket with reason-codes
2. **Visibility Policy** — which buckets are user-facing vs debug-only
3. **Wiring Tasks** — explicit code changes required per file
4. **Testing Strategy** — injection scenarios per bucket for Phase 5

---

## References

- [WI-0900](../../WORK_QUEUE/WI-0900.md) — Timestamp integrity audit (dependency)
- [WI-0901](../../WORK_QUEUE/COMPLETE/WI-0901.md) — Reason-code taxonomy (dependency)
- [Reason Code Taxonomy](./reason-code-taxonomy.md) — Canonical reason codes and layers
- [WI-0961](../../WORK_QUEUE/WI-0961.md) — NHL consistency field recovery (blocker on this audit)
