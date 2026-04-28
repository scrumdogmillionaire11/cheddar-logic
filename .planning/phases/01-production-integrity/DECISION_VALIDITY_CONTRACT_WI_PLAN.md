# Work Plan: Enforce Decision Validity Contract

**Goal:** No canonical decision = INVALID (system failure), not PASS (betting decision)

**Scope:** Smallest safe slices, maximum test coverage, zero production risk

---

## Phase 1: Type & Mapper Layer (Foundational)

### Slice 1.1: Add INVALID Status to DecisionOutcome

**Files:**
- `packages/data/src/decision-outcome.ts` (types)
- `packages/models/src/decision-authority.js` (mapper)

**Changes:**

#### decision-outcome.ts
```diff
- export type DecisionOutcomeStatus = 'PLAY' | 'SLIGHT_EDGE' | 'PASS';
+ export type DecisionOutcomeStatus = 'PLAY' | 'SLIGHT_EDGE' | 'PASS' | 'INVALID';

  export interface DecisionOutcome {
    status: DecisionOutcomeStatus;
    selection: DecisionOutcomeSelection;
    edge: number | null;
    confidence: number | null;
    reasons: DecisionOutcomeReasons;
    verification: DecisionOutcomeVerification;
    source: DecisionOutcomeSource;
+   invalid_reason?: string;  // Why this outcome is invalid (e.g., MISSING_DECISION_V2)
  }
```

#### decision-authority.js
```diff
  const AUTHORITY_STATUSES = Object.freeze({
    PLAY: 'PLAY',
    SLIGHT_EDGE: 'SLIGHT_EDGE',
    PASS: 'PASS',
+   INVALID: 'INVALID',
  });

  function resolveCanonicalDecision(payload, options = {}) {
    // ... existing logic ...
    
    const decisionV2 = payload?.decision_v2 && typeof payload.decision_v2 === 'object'
      ? payload.decision_v2
      : null;
    
+   // CRITICAL: Missing decision_v2 is a system failure, NOT a betting pass
    if (!decisionV2) {
+     return {
+       official_status: 'INVALID',
+       is_actionable: false,
+       tier: 'INVALID',
+       reason_code: 'MISSING_DECISION_V2',
+       source: CANONICAL_DECISION_SOURCE,
+       lifecycle: [{
+         stage: options.stage || 'read_api',
+         status: 'INVALID',
+         reason_code: 'MISSING_DECISION_V2',
+       }],
+     };
    }
    
    // ... rest of existing logic ...
  }
```

**Tests:**
- `packages/models/src/__tests__/decision-authority-invalid-state.test.js` (NEW)
  - Missing decision_v2 returns INVALID, not PASS
  - INVALID has lifecycle entry
  - INVALID has invalid_reason set

**Acceptance:**
- ✅ npm test packages/models passes
- ✅ INVALID status flows through mapper
- ✅ No callers break (tests mock INVALID handling)

---

### Slice 1.2: Runtime Decision Authority Returns INVALID

**Files:**
- `web/src/lib/runtime-decision-authority.ts`

**Changes:**

```diff
  export type RuntimeCanonicalDecision = {
    officialStatus: 'PLAY' | 'LEAN' | 'PASS';  // NO INVALID HERE YET
    action: 'FIRE' | 'HOLD' | 'PASS';
    classification: 'BASE' | 'LEAN' | 'PASS';
    status: 'FIRE' | 'WATCH' | 'PASS';
    isActionable: boolean;
    reasonCode: string;
    missingCanonicalDecision: boolean;
+   isInvalid: boolean;  // NEW
    lifecycle: CanonicalLifecycleEntry[];
  };

  function readRuntimeCanonicalDecision(
    payload: CanonicalDecisionPayload | null | undefined,
    options: ReadRuntimeDecisionOptions = {},
  ): RuntimeCanonicalDecision {
    const strictTestMode = isCanonicalDecisionStrictTestModeEnabled();

    const canonical = resolveCanonicalDecision(payload ?? null, {
      stage: options.stage ?? 'read_api',
      fallbackToLegacy: false,
      strictSource: true,
      missingReasonCode: MISSING_CANONICAL_DECISION_REASON,
    });

    if (!canonical) {
      if (strictTestMode) {
        throw new Error('Canonical decision missing');
      }

      return {
        officialStatus: 'PASS',
        action: 'PASS',
        classification: 'PASS',
        status: 'PASS',
        isActionable: false,
        reasonCode: MISSING_CANONICAL_DECISION_REASON,
        missingCanonicalDecision: true,
+       isInvalid: true,  // CRITICAL: Mark as invalid, not pass
        lifecycle: MISSING_CANONICAL_LIFECYCLE,
      };
    }

+   // Check if mapper returned INVALID
+   if (canonical.official_status === 'INVALID') {
+     return {
+       officialStatus: 'PASS',  // Display as PASS to consumers
+       action: 'PASS',
+       classification: 'PASS',
+       status: 'PASS',
+       isActionable: false,
+       reasonCode: canonical.reason_code,
+       missingCanonicalDecision: false,
+       isInvalid: true,  // Flag it as invalid internally
+       lifecycle: canonical.lifecycle || [],
+     };
+   }

    const officialStatus = canonicalStatusToOfficialStatus(canonical.official_status);
    const action = actionFromOfficialStatus(officialStatus);

    return {
      officialStatus,
      action,
      classification: classificationFromAction(action),
      status: statusFromAction(action),
      isActionable: Boolean(canonical.is_actionable),
      reasonCode: String(canonical.reason_code || MISSING_CANONICAL_DECISION_REASON),
      missingCanonicalDecision: false,
+     isInvalid: false,
      lifecycle: Array.isArray(canonical.lifecycle) ? canonical.lifecycle : [],
    };
  }
```

**Tests:**
- `web/src/__tests__/runtime-decision-authority-invalid.test.ts` (NEW)
  - Missing decision_v2 sets isInvalid: true
  - isInvalid callers can detect
  - Still renders as PASS to UI (fail-closed)

**Acceptance:**
- ✅ npm test web passes
- ✅ isInvalid flag available to diagnostics
- ✅ Backward compatible (still shows PASS to callers not checking isInvalid)

---

## Phase 2: Web Filters - Remove Legacy Fallback

### Slice 2.1: Fix filters.ts resolveSurfacedOfficialStatus

**Files:**
- `web/src/lib/game-card/filters.ts`

**Changes:**

```diff
  function resolveSurfacedOfficialStatus(
    play: GameCard['play'],
  ): 'PLAY' | 'LEAN' | 'PASS' | null {
    if (!play) return null;

    const surfacedStatus = play.final_market_decision?.surfaced_status;
    if (surfacedStatus === 'PLAY') return 'PLAY';
    if (surfacedStatus === 'SLIGHT EDGE') return 'LEAN';
    if (surfacedStatus === 'PASS') return 'PASS';

-   // OLD FALLBACK: Derives status from legacy fields (REMOVED)
-   if (play.action === 'FIRE' || play.classification === 'BASE') return 'PLAY';
-   if (play.action === 'HOLD' || play.classification === 'LEAN') return 'LEAN';
-   if (play.action === 'PASS' || play.classification === 'PASS') return 'PASS';

+   // NO FALLBACK: Fail closed to null
+   // Callers must handle null explicitly (not render, or mark as invalid diagnostic)
    return null;
  }

+ // NEW: Explicitly check if decision is invalid
+ function isDecisionInvalid(play: GameCard['play']): boolean {
+   if (!play) return false;
+   const decision = readRuntimeCanonicalDecision(
+     {
+       decision_v2: play.decision_v2 ?? null,
+       canonical_decision: play.canonical_decision ?? null,
+     },
+     { stage: 'read_api' },
+   );
+   return decision.isInvalid;
+ }
```

**Tests:**
- `web/src/__tests__/game-card-filter-no-legacy-fallback.test.ts` (NEW)
  - resolveSurfacedOfficialStatus returns null when decision_v2 missing
  - Does NOT derive from action/classification
  - isDecisionInvalid() correctly identifies invalid decisions

**Acceptance:**
- ✅ No legacy fallback in resolveCanonicalOfficialStatus
- ✅ Callers handle null appropriately
- ✅ Web regression tests pass

---

### Slice 2.2: Update resolveCanonicalOfficialStatus to Reject Null

**Files:**
- `web/src/lib/game-card/filters.ts`

**Changes:**

```diff
  function resolveCanonicalOfficialStatus(
    play: GameCard['play'],
  ): 'PLAY' | 'LEAN' | 'PASS' | null {
    const surfaced = resolveSurfacedOfficialStatus(play);
-   if (surfaced) return surfaced;
+   // If surfaced returns null, do NOT fallback to other sources
+   if (surfaced !== null) return surfaced;
    
    const envelope = getCanonicalEnvelope(play);
    const fromEnvelope = envelope?.official_status;
    if (
      fromEnvelope === 'PLAY' ||
      fromEnvelope === 'LEAN' ||
      fromEnvelope === 'PASS'
    ) {
      return fromEnvelope;
    }
    
    const explicit = play?.decision_v2?.official_status;
    return explicit === 'PLAY' || explicit === 'LEAN' || explicit === 'PASS'
      ? explicit
      : null;
  }
```

**Tests:**
- `web/src/__tests__/game-card-filter-canonical-only.test.ts` (NEW)
  - No legacy fallback at any level
  - Returns null when decision_v2 missing
  - Canonical envelope checked correctly

**Acceptance:**
- ✅ Fallback chain is removed
- ✅ Returns null when data insufficient
- ✅ Web tests pass

---

## Phase 3: Results Layer - Use Canonical Mapper

### Slice 3.1: Results Transform-Layer Uses Canonical Mapper

**Files:**
- `web/src/lib/results/transform-layer.ts`

**Changes:**

```diff
+ import { readRuntimeCanonicalDecision } from '@/lib/runtime-decision-authority';

  function resolveTierFromPayload(payload, play) {
    if (!payload) return { tier: 'PASS', source: 'FALLBACK' };
    
-   // OLD: Direct decision_v2 mapping (REMOVED)
-   if (payload.decision_v2 && typeof payload.decision_v2 === 'object') {
-     const d = payload.decision_v2;
-     if (d.official_status === 'PLAY') return { tier: 'PLAY', source: 'DECISION_V2' };
-     if (d.official_status === 'LEAN') return { tier: 'LEAN', source: 'DECISION_V2' };
-     // ...
-   }
    
+   // NEW: Use canonical decision mapper (single source of truth)
+   const decision = readRuntimeCanonicalDecision(
+     {
+       decision_v2: payload.decision_v2 ?? (play?.decision_v2 ?? null),
+       canonical_decision: payload.canonical_decision ?? (play?.canonical_decision ?? null),
+     },
+     { stage: 'read_api' },
+   );
+   
+   // INVALID decisions are excluded from betting aggregation but counted in diagnostics
+   if (decision.isInvalid) {
+     return { tier: 'INVALID', source: 'CANONICAL_INVALID', isInvalid: true };
+   }
    
+   // Map canonical action to tier
+   if (decision.action === 'FIRE') return { tier: 'PLAY', source: 'CANONICAL' };
+   if (decision.action === 'HOLD') return { tier: 'LEAN', source: 'CANONICAL' };
+   return { tier: 'PASS', source: 'CANONICAL' };
  }
```

**Tests:**
- `web/src/__tests__/results-transform-canonical-parity.test.ts` (NEW)
  - Transform tier matches canonical decision mapper
  - INVALID decisions excluded from aggregation
  - Direct decision_v2 mapping no longer used

**Acceptance:**
- ✅ Transform layer uses canonical mapper
- ✅ INVALID rows excluded from betting aggregation
- ✅ Results tests pass

---

### Slice 3.2: Results Query-Layer Excludes INVALID

**Files:**
- `web/src/lib/results/query-layer.ts`

**Changes:**

```diff
  function buildFilteredResultsCte(
    filters: ResultsRequestFilters,
    schema: ResultsSchemaInfo,
  ): { sql: string; params: unknown[] } {
    // ... existing CTE setup ...
    
    return {
      sql: `
        WITH display_log_ranked AS (
          // ... existing logic ...
        ),
        filtered AS (
          SELECT
            cr.id,
            // ... existing selects ...
          FROM card_results cr
          INNER JOIN display_log_latest cdl ON cr.card_id = cdl.pick_id
          LEFT JOIN card_payloads cp ON cr.card_id = cp.id
          WHERE cr.status = 'settled'
+           AND cr.tier IS NOT NULL  // Exclude INVALID rows from aggregation
            ${sportFilter.sql}
            ${categoryFilter.sql}
            ${confidenceFilter}
            ${marketFilter}
        )
      `,
      // ... params ...
    };
  }
```

**Tests:**
- `web/src/__tests__/results-query-excludes-invalid.test.ts` (NEW)
  - INVALID rows not returned in aggregation
  - But countable in diagnostics (separate query)

**Acceptance:**
- ✅ INVALID rows excluded from betting aggregation
- ✅ Diagnostics can still count them

---

## Phase 4: Pipeline Health Checks

### Slice 4.1: Add decision_v2 Validity Checks

**Files:**
- `apps/worker/src/jobs/check_pipeline_health.js`

**Changes:**

```javascript
// Add new health check function (after existing checks)

function checkDecisionValidityHealth(db, nowEt) {
  const LOOKBACK_MINUTES = 120;
  const THRESHOLD_MISSING_PCT = 0.05;  // Alert if >5% cards missing decision_v2
  const THRESHOLD_INVALID_PCT = 0.02;   // Alert if >2% cards invalid
  
  const cutoffTime = DateTime.utc().minus({ minutes: LOOKBACK_MINUTES }).toISO();
  
  // Count cards by decision validity
  const row = db.prepare(`
    SELECT
      COUNT(*) as total_cards,
      COUNT(DISTINCT CASE WHEN json_extract(payload_data, '$.decision_v2') IS NULL THEN 1 END) as missing_decision_v2,
      COUNT(DISTINCT CASE WHEN json_extract(payload_data, '$.decision_v2.official_status') IS NULL AND json_extract(payload_data, '$.decision_v2') IS NOT NULL THEN 1 END) as invalid_status
    FROM card_payloads
    WHERE created_at > ?
  `).get(cutoffTime);
  
  const missingPct = row.missing_decision_v2 / Math.max(row.total_cards, 1);
  const invalidPct = row.invalid_status / Math.max(row.total_cards, 1);
  
  const results = [];
  
  if (missingPct > THRESHOLD_MISSING_PCT) {
    results.push({
      phase: 'card_output',
      checkName: 'decision_v2_missing_rate',
      status: 'failed',
      reason: `Missing decision_v2: ${(missingPct * 100).toFixed(2)}% of cards (>${(THRESHOLD_MISSING_PCT * 100).toFixed(1)}% threshold)`,
    });
  } else {
    results.push({
      phase: 'card_output',
      checkName: 'decision_v2_missing_rate',
      status: 'passed',
      reason: `Missing decision_v2: ${(missingPct * 100).toFixed(2)}% of cards (OK)`,
    });
  }
  
  if (invalidPct > THRESHOLD_INVALID_PCT) {
    results.push({
      phase: 'card_output',
      checkName: 'decision_v2_invalid_rate',
      status: 'failed',
      reason: `Invalid decision_v2: ${(invalidPct * 100).toFixed(2)}% of cards (>${(THRESHOLD_INVALID_PCT * 100).toFixed(1)}% threshold)`,
    });
  } else {
    results.push({
      phase: 'card_output',
      checkName: 'decision_v2_invalid_rate',
      status: 'passed',
      reason: `Invalid decision_v2: ${(invalidPct * 100).toFixed(2)}% of cards (OK)`,
    });
  }
  
  return results;
}

// In main health check run loop, add:
async function runHealthChecks(db, nowEt) {
  const allResults = [];
  
  // ... existing checks ...
  
  // NEW: Decision validity checks
  const validityResults = checkDecisionValidityHealth(db, nowEt);
  allResults.push(...validityResults);
  
  // ... rest of function ...
}
```

**Tests:**
- `apps/worker/src/__tests__/check-pipeline-health-decision-validity.test.js` (NEW)
  - Detects when >5% cards missing decision_v2
  - Writes failed health check row
  - Sends Discord alert when threshold exceeded

**Acceptance:**
- ✅ Health check detects missing decision_v2
- ✅ Fails with clear diagnostic message
- ✅ Can be tuned via env vars (thresholds)

---

## Phase 5: Test Coverage

### Slice 5.1: Decision Validity End-to-End Tests

**Files:**
- `web/src/__tests__/decision-validity-contract.test.ts` (NEW)

**Test Cases:**

```typescript
describe('Decision Validity Contract', () => {
  
  test('Missing decision_v2 returns INVALID, not PASS', () => {
    const payload = { play: { action: 'FIRE', classification: 'BASE' } };
    const decision = readRuntimeCanonicalDecision(payload, { stage: 'read_api' });
    
    expect(decision.isInvalid).toBe(true);
    expect(decision.reasonCode).toContain('MISSING_DECISION_V2');
    expect(decision.action).toBe('PASS');  // Displays as PASS fail-closed
  });
  
  test('Web filter does NOT fallback to action/classification', () => {
    const play = {
      action: 'FIRE',
      classification: 'BASE',
      decision_v2: null,
      final_market_decision: null,
    };
    
    const status = resolveSurfacedOfficialStatus(play);
    expect(status).toBe(null);  // NO fallback
  });
  
  test('Results transform uses canonical mapper', () => {
    const payload = {
      decision_v2: {
        official_status: 'PLAY',
        lifecycle: [{ stage: 'model', status: 'CLEARED', reason_code: 'OK' }],
      },
      play: {},
    };
    
    const tier = resolveTierFromPayload(payload, {});
    expect(tier.source).toBe('CANONICAL');
    expect(tier.tier).toBe('PLAY');
  });
  
  test('INVALID decisions excluded from betting aggregation', async () => {
    const db = setupTestDb();
    
    // Insert settled card with INVALID decision
    insertCard(db, { id: 'card-1', tier: 'INVALID' });
    
    const results = querySettledCards(db);
    expect(results).not.toContainEqual(
      expect.objectContaining({ id: 'card-1' })
    );
  });
  
  test('Pipeline health detects missing decision_v2 spike', async () => {
    const db = setupTestDb();
    
    // Insert 100 cards, 10 missing decision_v2
    for (let i = 0; i < 100; i++) {
      insertCard(db, {
        decision_v2: i < 10 ? null : { official_status: 'PLAY' },
      });
    }
    
    const results = checkDecisionValidityHealth(db, nowEt);
    expect(results).toContainEqual(
      expect.objectContaining({
        checkName: 'decision_v2_missing_rate',
        status: 'failed',
        reason: expect.stringContaining('10.00%'),
      })
    );
  });
});
```

**Acceptance:**
- ✅ All 5 test cases pass
- ✅ Invalid contract enforced end-to-end
- ✅ No false positives on valid decisions

---

## Implementation Sequence (Minimal Risk)

### Wave 1: Foundational (2-3 hours)
1. **Slice 1.1:** Add INVALID to DecisionOutcome types
   - Tests for INVALID status existing
   - No behavioral changes yet

2. **Slice 1.2:** Runtime decision authority returns isInvalid flag
   - New field only, backward compatible
   - No callers change yet

### Wave 2: Filter Removal (1-2 hours)
3. **Slice 2.1:** Remove legacy fallback from filters
   - Fail-closed to null
   - Tests validate null handling

4. **Slice 2.2:** Reject null in resolveCanonicalOfficialStatus
   - Prevents accidental fallback

### Wave 3: Results Canonicalization (2-3 hours)
5. **Slice 3.1:** Results transform uses canonical mapper
   - Direct decision_v2 mapping removed
   - INVALID rows excluded

6. **Slice 3.2:** Query-layer excludes INVALID from aggregation

### Wave 4: Observability (1-2 hours)
7. **Slice 4.1:** Add decision validity health checks
   - Detects missing/invalid spike
   - Configurable thresholds

### Wave 5: Testing & Validation (2-3 hours)
8. **Slice 5.1:** End-to-end decision validity tests
   - All slices validated together

---

## Files Changed Summary

### Core Decision Logic
- `packages/data/src/decision-outcome.ts` — Add INVALID status type
- `packages/models/src/decision-authority.js` — Return INVALID on missing decision_v2
- `web/src/lib/runtime-decision-authority.ts` — Expose isInvalid flag

### Web Filters
- `web/src/lib/game-card/filters.ts` — Remove legacy fallback, add isDecisionInvalid()

### Results Layer
- `web/src/lib/results/transform-layer.ts` — Use canonical mapper, exclude INVALID
- `web/src/lib/results/query-layer.ts` — Exclude INVALID from aggregation

### Pipeline Health
- `apps/worker/src/jobs/check_pipeline_health.js` — Add decision validity checks

### Tests (NEW)
- `packages/models/src/__tests__/decision-authority-invalid-state.test.js`
- `web/src/__tests__/runtime-decision-authority-invalid.test.ts`
- `web/src/__tests__/game-card-filter-no-legacy-fallback.test.ts`
- `web/src/__tests__/game-card-filter-canonical-only.test.ts`
- `web/src/__tests__/results-transform-canonical-parity.test.ts`
- `web/src/__tests__/results-query-excludes-invalid.test.ts`
- `apps/worker/src/__tests__/check-pipeline-health-decision-validity.test.js`
- `web/src/__tests__/decision-validity-contract.test.ts`

**Total files:** 15 (8 modifications, 8 new tests)

---

## Before/After Examples

### Example 1: Missing decision_v2

**BEFORE:**
```javascript
// Model fails to write decision_v2
payload = {
  action: 'FIRE',
  classification: 'BASE',
  decision_v2: null,  // ← Bug in model
};

// Web filter fallback
const status = resolveSurfacedOfficialStatus(payload);
// Returns 'PLAY' (derived from action/classification)
// ✗ WRONG: Card displayed as PLAY when model crashed

// No alert
// ✓ Card silently shows as PLAY
// ✗ Operator has no idea model is broken
```

**AFTER:**
```javascript
payload = {
  action: 'FIRE',  // Ignored
  classification: 'BASE',  // Ignored
  decision_v2: null,  // ← Bug detected
};

// Runtime decision authority
const decision = readRuntimeCanonicalDecision(payload, { stage: 'read_api' });
// {
//   officialStatus: 'PASS',
//   action: 'PASS',
//   isInvalid: true,  // ← Flag set
//   reasonCode: 'MISSING_DECISION_V2',
//   lifecycle: [{ stage: 'read_api', status: 'INVALID', reason_code: 'MISSING_DECISION_V2' }],
// }

// Web filter
const status = resolveSurfacedOfficialStatus(payload);
// Returns null (NO fallback)
// Card filtered out of display

// Pipeline health alert
// checkDecisionValidityHealth detects spike
// Writes: {
//   phase: 'card_output',
//   checkName: 'decision_v2_missing_rate',
//   status: 'failed',
//   reason: 'Missing decision_v2: 100% of MLB cards (>5% threshold)',
// }
// Discord: @ops MLB decision_v2 missing spike!
```

### Example 2: Results Aggregation

**BEFORE:**
```javascript
// Direct decision_v2 mapping
function resolveTierFromPayload(payload) {
  if (payload.decision_v2) {
    if (payload.decision_v2.official_status === 'PLAY') return 'PLAY';
    if (payload.decision_v2.official_status === 'LEAN') return 'LEAN';
  }
  return 'PASS';  // Default
}

// Bug: Canonical mapper has lifecycle check that would block PLAY
// But direct mapping bypasses it
// Result: Inconsistent between web and results
```

**AFTER:**
```javascript
// Canonical mapper used
function resolveTierFromPayload(payload) {
  const decision = readRuntimeCanonicalDecision(payload, { stage: 'read_api' });
  
  if (decision.isInvalid) {
    return 'INVALID';  // Excluded from aggregation
  }
  
  if (decision.action === 'FIRE') return 'PLAY';
  if (decision.action === 'HOLD') return 'LEAN';
  return 'PASS';
}

// Consistent: Results tier matches web tier exactly
// Bug fixes in canonical mapper apply to both
```

### Example 3: Web Filter Fallback Removed

**BEFORE:**
```javascript
play = {
  action: 'FIRE',
  classification: 'BASE',
  final_market_decision: null,
  decision_v2: null,
};

// Fallback logic
const status = resolveSurfacedOfficialStatus(play);
if (surfaced) return surfaced;  // Falls through
if (play.action === 'FIRE') return 'PLAY';  // ← WRONG FALLBACK
// Returns 'PLAY' even though no canonical decision exists
```

**AFTER:**
```javascript
play = {
  action: 'FIRE',  // Ignored
  classification: 'BASE',  // Ignored
  final_market_decision: null,
  decision_v2: null,
};

// No fallback
const status = resolveSurfacedOfficialStatus(play);
// Returns null
// Caller must handle: either don't render or mark as invalid diagnostic
```

---

## Pipeline Health Row Example

```javascript
// When missing decision_v2 exceeds threshold

{
  id: 'health-check-20260427-143012',
  phase: 'card_output',
  check_name: 'decision_v2_missing_rate',
  status: 'failed',
  reason: 'Missing decision_v2: 12.35% of cards (>5.0% threshold). Affected sports: NHL (342 cards), MLB (1205 cards). Last seen: 2026-04-27T14:30:00Z',
  created_at: '2026-04-27T14:30:12Z',
  metadata: {
    lookback_minutes: 120,
    threshold_pct: 5.0,
    observed_pct: 12.35,
    affected_cards: {
      NHL: 342,
      MLB: 1205,
      NBA: 15,
    },
    by_card_type: {
      'MLB_PITCHER_K': 890,
      'NHL_1P_TOTAL': 234,
      // ...
    },
  },
}

// Discord alert
@ops_channel
ALERT: card_output/decision_v2_missing_rate FAILED
Missing decision_v2: 12.35% of cards (>5.0% threshold)
Affected: NHL (342), MLB (1205), NBA (15)
Action: Check model output; verify decision_v2 is being written
```

---

## Risk Mitigations

| Risk | Mitigation | Owner |
|------|-----------|-------|
| Backward compatibility break | isInvalid is NEW flag; existing action/classification still available | Test suite verifies |
| Results aggregation gap | INVALID rows excluded explicitly; diagnostics query separately available | Query-layer tests |
| Silent failures still happen | Health check detects missing_decision_v2 spike immediately | Health check tests |
| Model side effects | No model changes; only decision consumption changes | Design: read-only |
| Deployment order | Foundational wave deploys first; filters last; safe to roll back any wave | Wave testing |

---

## Success Criteria

### Wave 1-5 Complete When:
1. ✅ All 8 test files pass
2. ✅ No new test failures in existing suites
3. ✅ TypeScript compilation clean
4. ✅ INVALID decisions properly excluded from betting aggregation
5. ✅ Pipeline health fails predictably when decision_v2 missing
6. ✅ Discord alert fires on threshold exceeded
7. ✅ Can toggle back to old behavior via feature flag if needed (for safety)

### Production Readiness:
- ✅ Manual smoke test in staging: missing decision_v2 → alert fires
- ✅ Manual smoke test in staging: results tier matches web tier
- ✅ No legacy fallback reachable in web filters
- ✅ One code review sign-off

---

## Deployment Safety

### Pre-Deploy Validation:
```bash
# 1. Run full test suite
npm --prefix web test
npm --prefix apps/worker test
npm --prefix packages/models test

# 2. Type check
npx tsc --noEmit --project tsconfig.json

# 3. Verify no legacy fallback paths
grep -r "play.action\|play.classification" web/src/lib/game-card/filters.ts  # Should have zero results

# 4. Verify results uses canonical mapper
grep -n "decision_v2.official_status" web/src/lib/results/transform-layer.ts  # Should reference canonical mapper only

# 5. Health check loads
npm --prefix apps/worker run job:check-pipeline-health  # Should complete without error
```

### Rollback Plan:
- Each wave is independently rollbackable
- Feature flag `ENFORCE_DECISION_VALIDITY_CONTRACT` can disable new checks if needed
- Old code paths remain available (not deleted)

---

## Estimated Effort

| Wave | Slices | Effort | Risk |
|------|--------|--------|------|
| 1 | 1.1, 1.2 | 2-3h | LOW (types only) |
| 2 | 2.1, 2.2 | 1-2h | LOW (filter-only) |
| 3 | 3.1, 3.2 | 2-3h | MEDIUM (results change) |
| 4 | 4.1 | 1-2h | LOW (observability) |
| 5 | 5.1 | 2-3h | LOW (tests) |
| **Total** | 8 slices | **8-13h** | **MEDIUM** |

---

## Key Constraints

1. **Do not broaden legacy fallback** — Remove, don't extend
2. **Do not change model thresholds** — Only decision consumption
3. **Do not treat INVALID as PASS** — These are different (system failure vs betting decision)
4. **Do not delete legacy code yet** — Only stop using it; test-proven-unused deletion in later WI
5. **Keep MLB settled legacy adapter scoped** — If needed for historical results, mark source explicitly

