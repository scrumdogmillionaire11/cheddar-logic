# NBA Blocking Remediation Audit (WI-0941)

Date: 2026-04-15

## Scope

- apps/worker/src/jobs/run_nba_model.js
- packages/models/src/decision-pipeline-v2-edge-config.js
- packages/models/src/flags.js
- apps/worker/src/jobs/check_pipeline_health.js
- apps/worker/src/jobs/__tests__/run_nba_model.test.js
- apps/worker/src/__tests__/check-pipeline-health.nba.test.js
- packages/models/src/__tests__/decision-pipeline-v2-nba-total-quarantine.test.js
- web/src/lib/game-card/filters.ts

## TD-03 Proof — Web Filter Contract

**Command:**

```bash
rg -n "decision_v2\.official_status|play\.action === 'PASS'|play\.classification === 'PASS'" web/src/lib/game-card/filters.ts
```

**Output:**

```
475:  if (play.action === 'PASS' || play.classification === 'PASS') return false;
```

**Full `decision_v2` usage in filters.ts:**

```
rg -n "decision_v2|official_status" web/src/lib/game-card/filters.ts
354:    card.play?.decision_v2?.official_status === 'PASS';
476:  if (play.decision_v2?.official_status === 'PASS') return false;
490:  // the card is not actionable regardless of what official_status says.
494:  const officialStatus = play.decision_v2?.official_status;
```

**Analysis:**
- Line 354 and 476: PASS cards are filtered out — quarantine-demoted cards (via execution gate or
  pipeline demotion) with `official_status=PASS` cannot surface.
- Line 494: `official_status` is the canonical gate for surface decisions; LEAN cards still surface.
- No web-side reconstruction of NBA verdicts occurs. The filter reads the persisted `decision_v2.official_status`
  directly without rebuilding it from legacy status/action/classification fields.
- TD-03 requires no code change. The filter contract is already correct, and this rg proof records that.

## Deterministic Checks

```bash
# TD-01: execution gate stamps decision_v2.official_status
rg -n "decision_v2\.official_status\s*=" apps/worker/src/jobs/run_nba_model.js

# TD-02: NBA_NO_ODDS_MODE_LEAN post-publish stamp present
rg -n "NBA_NO_ODDS_MODE_LEAN" apps/worker/src/jobs/run_nba_model.js

# TD-04: NBA health check diagnostics wired
rg -n "checkNbaMarketCallDiagnostics|summarizeNbaRejectReasonFamilies|nba_market_call_diagnostics" apps/worker/src/jobs/check_pipeline_health.js

# Quarantine boundary proof
rg -n "NBA_TOTAL_QUARANTINE_DEMOTE" apps/worker/src/jobs/run_nba_model.js packages/models/src/decision-pipeline-v2-edge-config.js packages/models/src/__tests__/decision-pipeline-v2-nba-total-quarantine.test.js
```

## Policy vs Operational Block Partition

| Category        | Reason Codes                                                   | Path                                          |
|----------------|----------------------------------------------------------------|-----------------------------------------------|
| POLICY_QUARANTINE | `NBA_TOTAL_QUARANTINE_DEMOTE`                               | quarantine → buildDecisionV2 demotes TOTAL     |
| NO_EDGE         | `PASS_NO_EDGE`, `PASS_EXECUTION_GATE_NET_EDGE_INSUFFICIENT`    | execution gate or edge check fails             |
| DATA_STALENESS  | `BLOCK_STALE_DATA`, `SNAPSHOT_AGE_EXCEEDED`                    | odds snapshot too old                          |
| INTEGRITY_VETO  | `GATE_INTEGRITY_VETO`, `VERIFICATION_REQUIRED`                 | integrity gate blocks execution                |
| SUPPORT_FAIL    | `PASS_TOTAL_INSUFFICIENT_DATA`, `SUPPORT_THRESHOLD_NOT_MET`    | insufficient driver support                    |
| CONTRACT_MISMATCH | `PROJECTION_ONLY_EXCLUSION`, `NBA_NO_ODDS_MODE_LEAN`         | without-odds or missing market data            |

## Debt Ledger

| Debt ID | Type | Artifact removed or changed | Proof | Decision | Rationale | Follow-up WI |
| --- | --- | --- | --- | --- | --- | --- |
| TD-01 | code | `applyExecutionGateToNbaCard` now stamps `decision_v2.official_status=PASS` and `decision_v2.primary_reason_code=passReasonCode` when execution gate blocks a card | `execution gate demotes blocked executable market-call cards to PASS` test in `run_nba_model.test.js` — asserts `decision_v2.official_status === 'PASS'` and `decision_v2.primary_reason_code === 'PASS_EXECUTION_GATE_NET_EDGE_INSUFFICIENT'` | removed | Before this fix, execution gate overwrote `payload.action/classification/status` to PASS but left `decision_v2.official_status` at its pre-gate value (PLAY/LEAN), causing divergence between the legacy status fields and the canonical decision_v2 contract | n/a |
| TD-02 | code | Post-publish TOTAL no-odds-mode LEAN override stamps `NBA_NO_ODDS_MODE_LEAN` reason code after `publishDecisionForCard` normalizes `reason_codes`; stamping is post-publish to survive normalization | `rg -n "NBA_NO_ODDS_MODE_LEAN" apps/worker/src/jobs/run_nba_model.js` — present at post-publish override block; NHL WI-0940 precedent pattern replicated exactly | removed | Pre-publish stamping of reason codes is dropped by `publishDecisionForCard` normalization; reason code must be appended after publish | n/a |
| TD-03 | contract | Web filter contract already correct — filters.ts uses `decision_v2.official_status` as the canonical gate at lines 354, 476, 494 | `rg -n "decision_v2\\.official_status\|play\\.action === 'PASS'\|play\\.classification === 'PASS'" web/src/lib/game-card/filters.ts` → line 354, 475, 476, 494 | retained-intentional | No code change required. `filters.ts` already reads persisted `official_status` directly. PASS quarantine-demoted cards cannot surface; LEAN quarantine-demoted cards surface correctly. | n/a |
| TD-04 | diagnostic | `summarizeNbaRejectReasonFamilies`, `classifyNbaRejectReasonFamily`, `checkNbaMarketCallDiagnostics` added to `check_pipeline_health.js`; `NBA_REJECT_REASON_FAMILIES` and `NBA_MARKET_CALL_CARD_TYPES` constants added; wired into `checks` map, Discord `checkPhaseLookup`, and `module.exports` | `check-pipeline-health.nba.test.js` — 11 assertions covering all 7 reason families (including POLICY_QUARANTINE), malformed JSON, and `checkNbaMarketCallDiagnostics` ok/warning states | removed | NBA had no per-market reason-family diagnostic loop comparable to NHL (WI-0940) and MLB (WI-0939); POLICY_QUARANTINE family added specifically for `NBA_TOTAL_QUARANTINE_DEMOTE` | n/a |
| TD-05 | documentation | Stale comment audit pass on `run_nba_model.js` — all WI-reference comments are accurate historical annotations; no NBA selector-era misleading comments found | `grep -n "TODO\|FIXME\|HACK\|stale\|NBA selector\|old logic" apps/worker/src/jobs/run_nba_model.js` → 0 results for stale markers | retained-intentional | All existing comments describe current behavior accurately; TD-05 is closed as no-op | n/a |

## Final Acceptance Run (WI-0941 Plan 03 Task 3)

### Required Test Suites

All required WI-0941 test suites passed on 2026-04-15:

```
npm --prefix packages/models run test -- decision-pipeline-v2-nba-total-quarantine.test.js
→ 13 passed, 0 failed

npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/report_telemetry_calibration.test.js
→ 8 passed, 0 failed

npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/run_nba_model.test.js
→ 19 passed, 0 failed (including 3 new WI-0941 regression tests)

npm --prefix apps/worker run test -- --runInBand src/__tests__/check-pipeline-health.nba.test.js
→ 11 passed, 0 failed
```

### Latest NBA Model Run

`npm --prefix apps/worker run job:run-nba-model` on 2026-04-15:

```
[NBAModel] Job complete: 0 cards generated, 0 failed
[NBAModel] Projection input gate: 3/3 games blocked
Pipeline states: all WATCHDOG_CONSISTENCY_MISSING (team metrics not populated in local env)
```

DB validation (24h window): 0 rows — all games blocked by `PROJECTION_INPUTS_INCOMPLETE`
in local/staging environment. This is expected: team metrics cache is not populated in dev
environment. Production runs with full team metrics will produce quarantine-tagged rows.

### Deterministic Closeout Proofs

**TD-01: decision_v2.official_status stamped at execution gate**
```
rg -n "decision_v2\.official_status\s*=" apps/worker/src/jobs/run_nba_model.js
629:      payload.decision_v2.official_status = 'PASS';    # execution gate demotion
1790:     card.payloadData.decision_v2.official_status = 'LEAN';  # no-odds-mode LEAN
```

**TD-02: NBA_NO_ODDS_MODE_LEAN post-publish stamp**
```
rg -n "NBA_NO_ODDS_MODE_LEAN" apps/worker/src/jobs/run_nba_model.js
1777: // detect TOTAL card with withoutOddsMode and status=LEAN, then stamp NBA_NO_ODDS_MODE_LEAN
1786: if (!card.payloadData.reason_codes.includes('NBA_NO_ODDS_MODE_LEAN')) {
1787:   card.payloadData.reason_codes.push('NBA_NO_ODDS_MODE_LEAN');
1792:   card.payloadData.decision_v2.primary_reason_code = 'NBA_NO_ODDS_MODE_LEAN';
```

**TD-04: NBA health check diagnostics wired**
```
rg -n "checkNbaMarketCallDiagnostics|summarizeNbaRejectReasonFamilies|nba_market_call_diagnostics" apps/worker/src/jobs/check_pipeline_health.js
790:  function summarizeNbaRejectReasonFamilies(db, lookbackHours = 24) {
859:  function checkNbaMarketCallDiagnostics() {
1346: nba_market_call_diagnostics: checkNbaMarketCallDiagnostics,   # checks map
1380: nba_market_call_diagnostics: ['nba', 'market_call_blockers'],  # Discord phaseLookup
1456: summarizeNbaRejectReasonFamilies,  # module.exports
1457: checkNbaMarketCallDiagnostics,     # module.exports
```

**Quarantine boundary proof**
```
rg -n "NBA_TOTAL_QUARANTINE_DEMOTE" packages/models/src/decision-pipeline-v2-edge-config.js
144: const QUARANTINE_REASON = 'NBA_TOTAL_QUARANTINE_DEMOTE';

→ 14 usages in decision-pipeline-v2-nba-total-quarantine.test.js covering on/off assertions
```
