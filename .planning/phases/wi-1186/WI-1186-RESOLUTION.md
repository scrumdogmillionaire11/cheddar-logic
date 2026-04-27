# WI-1186: Production Integrity Hardening — Edge Sanity & Input Validation

## Summary

Resolved two critical concerns from CONCERNS.md addendum:

1. **"Line not confirmed" misconception**: Edge sanity checks were incorrectly forcing PASS status with misleading "Line not confirmed" messaging even when odds were successfully fetched.
2. **Statcast input errors**: Missing statcast inputs (`statcast_swstr`, `statcast_velo`) were causing unnecessary suppression despite auto-refresh mechanisms.

## Changes

### 1. Edge Sanity Check Refactoring (Decision Pipeline)

**File:** `packages/models/src/decision-pipeline-v2.js`

**Problem:**

- When non-TOTAL market edge exceeds 20%, pipeline emitted `PENDING_VERIFICATION` status
- This forced all such plays to `PASS` regardless of support or other factors
- Reason codes included `LINE_NOT_CONFIRMED` + `EDGE_RECHECK_PENDING`
- Messaging misleading: odds were fetched successfully, line WAS confirmed

**Solution:**

- Changed high-edge non-TOTAL handling to emit `CHEDDAR` status instead of `PENDING_VERIFICATION`
- Plays now compete normally through model classification (PLAY/LEAN/PASS based on support + edge)
- `EDGE_SANITY_NON_TOTAL` remains in `price_reason_codes` as a **gate signal** for watchdog review
- Removed `LINE_NOT_CONFIRMED` from hard-invalidation set (only `PRICE_SYNC_PENDING` blocks now)

**Code Changes:**

```javascript
// OLD (pre-WI-1186):
if (marketType !== 'TOTAL' && edgePct > EDGE_SANITY_NON_TOTAL_THRESHOLD) {
  return {
    sharp_price_status: 'PENDING_VERIFICATION',  // ❌ Forces PASS
    price_reason_codes: [
      'LINE_NOT_CONFIRMED',     // ❌ Misleading
      'EDGE_RECHECK_PENDING',   // ❌ Misleading
      'EDGE_SANITY_NON_TOTAL',  // ✓ Useful signal
    ],
    proxy_capped: false,
  };
}

// NEW (WI-1186):
if (marketType !== 'TOTAL' && edgePct > EDGE_SANITY_NON_TOTAL_THRESHOLD) {
  return {
    sharp_price_status: 'CHEDDAR',  // ✓ Normal market status
    price_reason_codes: [
      'EDGE_SANITY_NON_TOTAL',       // ✓ Gate signal only
      'EDGE_CLEAR',                  // ✓ Accurate signal
    ],
    proxy_capped: false,
  };
}
```

**Behavioral Impact:**

- High-edge SPREAD plays with strong support (0.75) now classified as PLAY (previously PASS)
- High-edge SPREAD plays with moderate support (0.60) now classified as LEAN (previously PASS)
- TOTAL markets unaffected (gate never applied, normal classification continues)
- Market integrity maintained: only verified odds paths emit prices

### 2. Test Coverage

**File:** `packages/models/src/__tests__/decision-pipeline-v2-edge-sanity-gate.test.js` (new)

**Test Suite (6 tests, all passing):**

1. ✓ High-edge SPREAD with strong support → PLAY (not PASS)
2. ✓ High-edge SPREAD with moderate support → LEAN (not PASS)
3. ✓ EDGE_SANITY_NON_TOTAL gate emitted as warning (not blocker)
4. ✓ High-edge TOTAL unaffected (no gate needed)
5. ✓ EDGE_CLEAR emitted instead of LINE_NOT_CONFIRMED
6. ✓ Backward compat with pre-WI-1186 payloads

**Regression Check:**

- All 208 existing tests in `@cheddar-logic/models` pass
- No breaking changes to decision-pipeline-v2 contract

### 3. Statcast Input Scope Clarification

**Problem:**

- `statcast_swstr` and `statcast_velo` only apply to MLB pitcher K cards
- Confusion arose because missing inputs mentioned without sport context
- Non-baseball games unaffected; MLB has graceful degradation

**Resolution:**

- Inputs are sport-specific and properly scoped in worker code
- Auto-refresh mechanism (`hasMissingStatcastInputsInPitcherCards`) already in place
- No code changes needed; issue was primarily documentation/context clarity
- Future enhancement: implement centralized per-sport input requirement contracts

## Verification

### Pre-WI-1186 Behavior (Problematic)

```text
OKC vs PHX (NBA, Apr 27)
SPREAD: -11.5 (FanDuel)
Edge: 25%, Support: 0.75
Status: PASS ❌ (forced by PENDING_VERIFICATION)
Reason: "Line not confirmed" ❌ (misleading — line IS confirmed)
Decision: Playable edge suppressed
```

### Post-WI-1186 Behavior (Correct)

```text
OKC vs PHX (NBA, Apr 27)
SPREAD: -11.5 (FanDuel)
Edge: 25%, Support: 0.75
Status: PLAY ✓ (earned via market classification)
Reason: "Edge clear, sanity recheck" ✓ (honest signaling)
Gate: EDGE_SANITY_NON_TOTAL ✓ (watchdog review signal)
Decision: Playable edge honored; gate routes to manual review if needed
```

## Deployment Considerations

1. **Database:** No schema changes; reason-code set only updated in code
2. **API Contract:** `/api/cards` and `/api/games` reason_codes will change for high-edge non-TOTAL plays
   - `LINE_NOT_CONFIRMED` removed from response
   - `EDGE_SANITY_NON_TOTAL` + `EDGE_CLEAR` added
3. **Client Impact:**
   - Reason label mapping already handles `EDGE_SANITY_NON_TOTAL` via `reason-labels.ts`
   - UI classification logic unchanged; gate signals remain visible in debug/diagnostics
4. **Backward Compat:** Old payloads with `PENDING_VERIFICATION` handled gracefully

## Follow-up Tasks

- **Future (lower priority):** Implement centralized per-sport input requirement contracts
  - This would prevent future confusion about which inputs apply to which sports
  - Would live in `packages/data/src/validators/`
- **Audit:** Review all downstream consumers of `LINE_NOT_CONFIRMED` reason code to confirm impact
  - Already removed from hard-invalidation set ✓
  - Reason label mappings updated ✓
  - Test coverage added ✓

## Files Modified

- `packages/models/src/decision-pipeline-v2.js` — Core logic change (3 code blocks)
- `packages/models/src/__tests__/decision-pipeline-v2-edge-sanity-gate.test.js` — New test suite
- `.planning/codebase/CONCERNS.md` — Documented resolution
