# Hostile Audit — Betting Decision Pipeline (March 2026)

**Work Item:** WI-0572  
**Auditor:** codex  
**Audit Date:** 2026-03-23  
**Scope:** 10 pipeline files — find places where the system can emit confident-looking but invalid plays, hide missing data, or let downstream layers mutate canonical worker truth.  
**Output constraint:** Findings only. No source code changes in scope.

---

## Audit Scope

| File | Role |
|------|------|
| `packages/models/src/decision-pipeline-v2.js` | Core edge/decision computation (Wave 1) |
| `packages/models/src/decision-pipeline-v2.patch.js` | Threshold profiles + feature flag guard |
| `packages/models/src/decision-gate.js` | Side-flip stability guard |
| `packages/models/src/edge-calculator.js` | Normal-CDF edge math |
| `apps/worker/src/utils/decision-publisher.js` | DB publish + reason_codes mutation |
| `packages/data/src/market-contract.js` | Card type contracts |
| `web/src/app/api/games/route.ts` | API assembly + true_play selection |
| `web/src/lib/game-card/transform.ts` | Quality classification + hasFetchFailureInputs |
| `web/src/lib/game-card/decision.ts` | Decision display layer |
| `web/src/lib/play-decision/decision-logic.ts` | Frontend decision logic |

---

## Findings

### FINDING-01 — CRITICAL: NHL total line continuity-correction bias suppresses OVER edges

**Severity:** CRITICAL  
**Classification:** Systematic calibration error — produces wrong sign on edge for NHL totals near the line  
**File:** [packages/models/src/edge-calculator.js](../../packages/models/src/edge-calculator.js#L238)

**Why it's a problem:**  
`computeTotalEdge` detects "NHL-style totals" via `isNhlStyleTotal = sigmaTotal <= 3` and unconditionally applies `adjustedLine = L + 0.5`. This shifts the effective line up by half a goal before computing P(X > line). For a standard half-integer NHL line (e.g., 5.5), this means the code computes P(X > 6.0) instead of P(X > 5.5). The +0.5 is a continuity correction that makes sense only for integer lines where a push is possible — it has no mathematical basis for half-integer lines that cannot push.

**Numerical impact at line 5.5, sigma 2.0, projection 5.7:**
- With correction: `p_over = 1 - normCdf((6.0 - 5.7) / 2.0) = 1 - normCdf(0.15) ≈ 0.440`. At -110 implied ≈ 0.476. Edge = **-0.036** → UNDER edge.
- Without correction: `p_over = 1 - normCdf((5.5 - 5.7) / 2.0) = 1 - normCdf(-0.10) ≈ 0.540`. Edge = **+0.064** → OVER edge that clears PLAY threshold.
- A model projection 0.2 goals above the line produces a wrong-sign play call due to this adjustment.

**Current behavior:**  
Half-integer NHL totals at or near the line compute OVER probability ~5–9 percentage points lower than mathematically correct. This can flip OVER plays to PASS or to UNDER.

**Correct behavior:**  
The +0.5 adjustment should only apply to integer lines (where `L % 1 === 0`). For half-integer lines (where `L % 1 === 0.5`), no adjustment is needed or appropriate.

**Recommended fix:**
```javascript
// Only apply continuity correction for integer lines
const lineIsInteger = L % 1 === 0;
const adjustedLine = (isNhlStyleTotal && lineIsInteger) ? L + 0.5 : L;
```

**Dependency notes:**  
Changing this affects `edge_pct` and therefore `official_status` for all NHL TOTAL and NHL FIRST_PERIOD cards. Tests in `edge-calculator.test.js` that assert specific probabilities for half-integer NHL lines would need to be updated to reflect correct values. The `EDGE_SANITY_CLAMP_APPLIED` rail flag may fire less often as edges are computed more accurately.

---

### FINDING-02 — CRITICAL: `buildDecisionV2` silently swallows all exceptions

**Severity:** CRITICAL  
**Classification:** Silent failure — parsing errors produce confident-looking PASS results indistinguishable from legitimate no-plays  
**File:** [packages/models/src/decision-pipeline-v2.js](../../packages/models/src/decision-pipeline-v2.js#L1372)

**Why it's a problem:**  
The entire `buildDecisionV2` computation is wrapped in a `try/catch` that returns a fully-formed decision object on any throw. The catch block sets:
- `watchdog_status: 'BLOCKED'`
- `watchdog_reason_codes: ['PARSE_FAILURE']`
- `official_status: 'PASS'`
- No `console.error`, no metric increment, no re-throw

This means if a payload has a malformed field that causes a TypeError mid-computation (e.g., `.toFixed` on null, array method on a string), the pipeline emits a valid-looking decision object that the publisher writes to DB. The failure surfaces only when the transform sees the stored `pass_reason_code: 'PARSE_FAILURE'` and emits a DEGRADED card — but by then the root error is gone.

**Current behavior:**  
Any runtime exception in the decision pipeline is silently converted to a PASS/BLOCKED synthetic result. No alerting. No log line. No way to distinguish from real watchdog blocks.

**Correct behavior:**  
Catch block must log the error with full stack trace before returning the fallback result. Optionally increment a `pipeline_parse_errors` metric counter.

**Recommended fix:**
```javascript
} catch (error) {
  console.error('[buildDecisionV2] PARSE_FAILURE — returning synthetic BLOCKED result', {
    error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    sport: payload?.sport,
    market_type: payload?.market_type,
    game_id: payload?.game_id,
  });
  return { /* existing fallback object */ };
}
```

**Dependency notes:**  
This is a non-behavioral change in normal operation. Test assertions on the catch-path synthetic result are unaffected.

---

### FINDING-03 — HIGH: `reason_codes` accumulates monotonically — stale contradictory codes never purged

**Severity:** HIGH  
**Classification:** Data integrity corruption — `reason_codes` cannot be trusted to reflect current decision state  
**File:** [apps/worker/src/utils/decision-publisher.js](../../apps/worker/src/utils/decision-publisher.js#L158)

**Why it's a problem:**  
In `applyUiActionFields`, when a Wave 1 PLAY card is processed:
```javascript
payload.reason_codes = Array.from(
  new Set([
    ...(Array.isArray(payload.reason_codes) ? payload.reason_codes : []),
    decisionV2.primary_reason_code,
  ]),
);
```

This appends the new primary reason code to whatever was already in `payload.reason_codes` (loaded from DB). A card that was previously PASS with `SUPPORT_BELOW_LEAN_THRESHOLD` and is now FIRE with `EDGE_CLEAR` will persist with both codes: `["SUPPORT_BELOW_LEAN_THRESHOLD", "EDGE_CLEAR"]`. These are semantically contradictory and cannot both be true simultaneously.

Additionally, `applyPublishedDecisionToPayload` (L237) appends `'DECISION_HELD'` with the same pattern, so a card re-evaluated by the v2 pipeline after being held by the gate ends up with three codes: `["SUPPORT_BELOW_LEAN_THRESHOLD", "EDGE_CLEAR", "DECISION_HELD"]`.

**Current behavior:**  
`reason_codes` is an ever-growing set of historical codes. Any code that was ever true for a card survives indefinitely. The array cannot be used to determine current decision state.

**Correct behavior:**  
`reason_codes` on a PLAY card should be *replaced* (not merged) when the v2 pipeline runs a fresh decision. Historical decision events (the `decision_events` table) are already the appropriate place for lineage. The payload field should reflect current state only.

**Recommended fix:**
```javascript
// Replace instead of merge — only keep current primary reason
payload.reason_codes = Array.from(
  new Set([decisionV2.primary_reason_code].filter(Boolean))
);
```

**Dependency notes:**  
Any consumer filtering on `reason_codes` inclusion of legacy codes would be affected. `transform.ts` uses `pass_reason_code` (not `reason_codes`) for its `collectNoActionablePlayInputs` logic — no impact there. The `PASS_UNREPAIRABLE_LEGACY` logic in transform also reads `play.pass_reason_code`, not `reason_codes`.

---

### FINDING-04 — HIGH: EVIDENCE cards carry permanently stale `reason_codes: ["PASS_UNREPAIRABLE_LEGACY"]`

**Severity:** HIGH  
**Classification:** Data integrity / diagnostic lie — `reason_codes` on EVIDENCE cards never refreshes, misrepresents actual pass reason  
**File:** [apps/worker/src/utils/decision-publisher.js](../../apps/worker/src/utils/decision-publisher.js#L122)

**Why it's a problem:**  
`applyUiActionFields` bails out immediately for non-PLAY cards:
```javascript
if (!payload || payload.kind !== 'PLAY') {
  return payload; // Only apply to PLAY payloads
}
```

EVIDENCE cards have `kind: 'EVIDENCE'` and are never processed by this function. Their `reason_codes` field is set during initial legacy card creation and never updated. In production, every EVIDENCE card in the live `/api/games` response shows `reason_codes: ["PASS_UNREPAIRABLE_LEGACY"]` regardless of the actual pass reason. 

The NHL model fix (WI-0569, commit `9f59c8e`) correctly populates `pass_reason_code` on EVIDENCE cards (`"FIRST_PERIOD_NO_PROJECTION"`, `"SUPPORT_BELOW_LEAN_THRESHOLD"`, etc.), but `reason_codes` continues to hold the legacy sentinel.

**Current behavior:**  
EVIDENCE cards: `pass_reason_code = "FIRST_PERIOD_NO_PROJECTION"` (correct), `reason_codes = ["PASS_UNREPAIRABLE_LEGACY"]` (wrong). The transform reads `pass_reason_code` for its classification logic, so no functional quality bug today — but diagnostic tooling that reads `reason_codes` will misclassify these cards as legacy.

**Correct behavior:**  
When an EVIDENCE card's `pass_reason_code` is written by a model job, `reason_codes` should be updated to match. Or `reason_codes` should be explicitly cleared/replaced when `pass_reason_code` is set.

**Recommended fix:**  
In the model jobs (e.g., `run_nhl_model.js`) where `pass_reason_code` is set on EVIDENCE cards, also reset `reason_codes`:
```javascript
card.pass_reason_code = pass_reason_code;
card.reason_codes = [pass_reason_code].filter(Boolean);
```

**Dependency notes:**  
Transform's `collectNoActionablePlayInputs` uses `play.pass_reason_code` — no impact. Any future tooling reading `reason_codes` on EVIDENCE cards should be informed this was stale and is now fixed.

---

### FINDING-05 — HIGH: `shouldFlip` coerces null edge to 0 when `edge_available=true`

**Severity:** HIGH  
**Classification:** Latent defect — phantom side flip possible when edge contract is violated  
**File:** [packages/models/src/decision-gate.js](../../packages/models/src/decision-gate.js#L271)

**Why it's a problem:**  
```javascript
const edgeComparable = candidateEdgeAvailable && currentEdgeAvailable;
const edgeDelta = edgeComparable ? (candidate.edge ?? 0) - (current.edge ?? 0) : null;
```

`candidateEdgeAvailable = candidate?.edge_available === true || hasFiniteEdge(candidate?.edge)`. If a publisher sets `edge_available: true` on a card but leaves `edge: null` (e.g., a code path that sets the flag before computing the value, or sets it optimistically from a prior run), then:
- `edgeComparable = true`
- `edgeDelta = (null ?? 0) - (current.edge ?? 0) = 0 - current.edge`

If `current.edge` is null (also coerced to 0), then `edgeDelta = 0`. A side flip would then be blocked by `EDGE_UPGRADE_MIN: 0.5` check (`0 < 0.5 → NOT_STABLE` or `EDGE_TOO_SMALL`). However, if `current.edge` is negative (the current decision had a negative edge — a held LEAN that has deteriorated), then `edgeDelta = 0 - (negative) = positive`. If that positive delta exceeds 0.5, the flip is allowed based on `0` vs a deteriorated edge — using 0 as a stand-in for "no data" rather than "neutral edge."

**Current behavior:**  
Side flips are guarded by EDGE_UPGRADE_MIN=0.5, which makes this hard to trigger in practice but not impossible (particularly for LEAN cards that have deteriorated to negative edge). The `edge_available` flag and the actual `edge` value can be in an inconsistent state.

**Correct behavior:**  
`edgeDelta` should be null whenever either actual edge value is not a finite number, regardless of `edge_available` flag:
```javascript
const edgeDelta = (hasFiniteEdge(candidate?.edge) && hasFiniteEdge(current?.edge))
  ? candidate.edge - current.edge
  : null;
```

**Dependency notes:**  
Affects all side-flip decisions in the gate. The stability-run guard (`NOT_STABLE`) and line-move path (`LINE_MOVE_NO_EDGE`) are unaffected. Tests for `EDGE_UPGRADE` path should verify no `?? 0` coercion.

---

### FINDING-06 — HIGH: `truePlayMap` uses first-come ordering — stale LEAN shadows fresh FIRE

**Severity:** HIGH  
**Classification:** Stale data propagation — `true_play` can be set to an older lower-confidence card when multiple play-eligible cards exist  
**File:** [web/src/app/api/games/route.ts](../../web/src/app/api/games/route.ts#L3151)

**Why it's a problem:**  
```typescript
if (truePlayMap.has(canonicalGameId)) continue;
// ... candidate found in displayLogRows
truePlayMap.set(canonicalGameId, candidate);
```

The first `displayLogRows` entry for a game wins, regardless of `decided_at`, `official_status` tier, or `edge_pct`. The `displayLogRows` are ordered by the DB query; if that ordering is not `decided_at DESC`, an older LEAN card can shadow a newer FIRE card published in a subsequent model run.

This is the mechanism by which a card held by the gate (LEAN, `DECISION_HELD`) from a prior run could become `true_play` while a fresh FIRE card from the latest run exists for the same game — as long as the LEAN card appears earlier in `displayLogRows`.

**Current behavior:**  
`true_play` is the first PLAY/LEAN card found in `displayLogRows` order, not the highest-confidence current card.

**Correct behavior:**  
When multiple PLAY/LEAN candidates exist for a game, prefer: PLAY over LEAN, then higher `edge_pct`, then more recent `decided_at`. At minimum, if a FIRE (PLAY) card exists for a game, it must win over any LEAN card.

**Recommended fix:**
```typescript
const officialTier = (c: Play) =>
  c.decision_v2?.official_status === 'PLAY' ? 2 :
  c.decision_v2?.official_status === 'LEAN' ? 1 : 0;

// Replace only if new candidate is strictly better
const existing = truePlayMap.get(canonicalGameId);
if (existing) {
  const existingTier = officialTier(existing);
  const candidateTier = officialTier(candidate);
  if (candidateTier <= existingTier) continue;
}
truePlayMap.set(canonicalGameId, candidate);
```

**Dependency notes:**  
This is a read-path change in `route.ts`. No DB writes. Any test asserting a specific card wins when multiple cards are present must be updated.

---

### FINDING-07 — MEDIUM: Sigma fallbacks are undocumented, uncalibrated constants with no lineage

**Severity:** MEDIUM  
**Classification:** Calibration risk — all edge computations that fall back to hardcoded sigma values may consistently misstate edge magnitude  
**File:** [packages/models/src/edge-calculator.js](../../packages/models/src/edge-calculator.js#L326)

**Why it's a problem:**  
```javascript
// NBA margin=12 (set ~2024, uncalibrated — no lineage in codebase)
// NBA total=14  (set ~2024, uncalibrated — no lineage in codebase)
function getSigmaDefaults(sport) {
  const sigmaMap = {
    NBA: { margin: 12, total: 14 },
    ...
  };
}
```

The file's own comments state these are "uncalibrated." The empirical path (`computeSigmaFromHistory`) computes sigma from `game_results` but requires a `db` argument. Any caller that invokes `buildDecisionV2` without passing the DB connection (or where `computeSigmaFromHistory` fails/returns fallback) uses these constants for all NBA spread and total edge calculations.

With NBA sigma_total=14: a projection 3 goals above the line computes `p_over = 1 - normCdf(3/14) ≈ 1 - normCdf(0.214) ≈ 0.415` — showing an UNDER edge when the model is clearly OVER-leaning. The actual NBA sigma from 2024-25 game logs is approximately 22-24 total points, making 14 a severe underestimate that produces inflated edge percentages and over-fires plays.

**Current behavior:**  
When `getSigmaDefaults` is the operative path (fallback or direct call), NBA total edge computations use sigma=14, likely producing inflated p_fair estimates and inflated edge_pct values that clear PLAY threshold more easily than reality warrants.

**Correct behavior:**  
Every production call to `computeTotalEdge` and `computeSpreadEdge` should use `computeSigmaFromHistory` with a real DB handle. The fallback path should log a warning when it activates so the frequency is observable.

**Recommended fix:**  
Add a warning log to `getSigmaDefaults`:
```javascript
function getSigmaDefaults(sport) {
  console.warn('[edge-calculator] Using FALLBACK sigma for', sport, '— computeSigmaFromHistory unavailable');
  // ...
}
```
Separately, audit all callers of `computeSpreadEdge` / `computeTotalEdge` to confirm they pass empirical sigma values.

**Dependency notes:**  
Changing sigma values changes edge thresholds implicitly for all SPREAD/TOTAL markets using these defaults. Treat as a calibration investigation, not a code patch.

---

### FINDING-08 — MEDIUM: `FLAGS.ENABLE_MARKET_THRESHOLDS_V2` read per-card, not per-run — flag flip mid-batch creates mixed threshold sets

**Severity:** MEDIUM  
**Classification:** Consistency risk — a single model run can produce a mix of default and v2 threshold decisions  
**File:** [packages/models/src/decision-pipeline-v2.patch.js](../../packages/models/src/decision-pipeline-v2.patch.js#L78)

**Why it's a problem:**  
```javascript
function resolveThresholdProfile({ sport, marketType }) {
  // ...
  if (!FLAGS.ENABLE_MARKET_THRESHOLDS_V2) {
    return profile; // use defaults
  }
  // use v2 thresholds
}
```

`FLAGS` is evaluated at the moment `resolveThresholdProfile` is called, which is inside `buildDecisionV2`, which is called once per card. If the feature flag is toggled (e.g., dynamically from a config service or via env var change) during a model batch run that processes 200 cards over several seconds, some cards will use default thresholds and others will use v2 thresholds. There is no snapshot of the flag at run-start.

In practice this is low probability during a single job run, but in environments with live feature flag services (or tests that toggle flags between assertions), this creates non-deterministic threshold application.

**Current behavior:**  
Each card in a batch independently reads the flag. Cards processed before a flag toggle use one threshold set; cards processed after use another.

**Correct behavior:**  
The flag should be read once per model job run and passed to `buildDecisionV2` via context, or `resolveThresholdProfile` should be a pure function that receives the flag value rather than reading from global `FLAGS`.

**Recommended fix:**
```javascript
// In run_nba_model.js / run_nhl_model.js, before the batch:
const useV2Thresholds = FLAGS.ENABLE_MARKET_THRESHOLDS_V2;
// Pass to each buildDecisionV2 call:
payload.threshold_flags = { enable_v2: useV2Thresholds };
```

**Dependency notes:**  
Requires modifying the pipeline context object. Tests that test threshold profile selection need to inject the flag rather than rely on global state.

---

### FINDING-09 — MEDIUM: `DECISION_HELD` and `EDGE_CLEAR` coexist on gate-held FIRE cards

**Severity:** MEDIUM  
**Classification:** Diagnostic contradiction — a published card shows simultaneously "clear edge" and "decision held from prior run"  
**File:** [apps/worker/src/utils/decision-publisher.js](../../apps/worker/src/utils/decision-publisher.js#L237)  
Related: [apps/worker/src/utils/decision-publisher.js](../../apps/worker/src/utils/decision-publisher.js#L160)

**Why it's a problem:**  
`applyUiActionFields` (L160) appends `decisionV2.primary_reason_code` (e.g., `EDGE_CLEAR`) to `reason_codes`. `applyPublishedDecisionToPayload` (L237) appends `DECISION_HELD`. When a card is re-evaluated by v2 and also served from the gate:

1. `applyUiActionFields` runs → `reason_codes = [...legacy, "EDGE_CLEAR"]`
2. `applyPublishedDecisionToPayload` runs → `reason_codes = [...legacy, "EDGE_CLEAR", "DECISION_HELD"]`

`EDGE_CLEAR` means the v2 pipeline computed a clear edge based on current market data. `DECISION_HELD` means the published decision was frozen from a prior run by the gate. Both cannot simultaneously describe the final decision truthfully — either the card is using current edge (EDGE_CLEAR) or a held previous decision (DECISION_HELD).

**Current behavior:**  
Gate-held FIRE cards have `reason_codes` containing both `EDGE_CLEAR` and `DECISION_HELD`. Users/tools reading `reason_codes` cannot determine provenance.

**Correct behavior:**  
If a card is being served from the gate (DECISION_HELD), the `EDGE_CLEAR` code from the fresh v2 run should be quarantined to `decision_v2.primary_reason_code` (where it belongs) and not merged into `reason_codes`. `reason_codes` should reflect the path actually used to emit the card.

**Dependency notes:**  
Touches ordering/separation of `applyUiActionFields` and `applyPublishedDecisionToPayload` calls. The `decision_v2` sub-object on the payload (L155) already stores the clean v2 result — consumers should read trace data from there, not from `reason_codes`.

---

### FINDING-10 — LOW: `FIRST_PERIOD` `totalLine` fallback hardcodes `1.5` when `payload.line` is null

**Severity:** LOW  
**Classification:** Phantom market data — `fair_prob` derived from a fictional line muddies pricing trace  
**File:** [packages/models/src/decision-pipeline-v2.js](../../packages/models/src/decision-pipeline-v2.js#L1139)

**Why it's a problem:**  
```javascript
const totalLine =
  market_type === 'FIRST_PERIOD'
    ? asNumber(payload?.line) ?? 1.5
    : asNumber(oddsCtx?.total);
```

When `payload.line` is null (no 1P market price posted), the pipeline uses `1.5` as a stand-in line. `computeTotalEdge` then computes a `p_fair` from this fictional line. Although `p_implied` is null (no real price), so `edge_pct` correctly comes out null (`fair_prob - null = null`), the computed `fair_prob` is stored in the decision result derived from a fake 1.5 line. The `pricing_trace` shows `market_line: null` (correctly) but the downstream `fair_prob` value was computed against 1.5, not null. Any consumer reading `fair_prob` assumes it was computed against the real market line.

**Current behavior:**  
`FIRST_PERIOD` cards with no 1P price show a non-null `fair_prob` in `decision_v2`, computed against an implicit 1.5 default line. This is a misleading trace artifact.

**Correct behavior:**  
When `payload.line` is null for FIRST_PERIOD, `totalLine` should be null. The `computeTotalEdge` function correctly handles `null` totalLine (`missing_projection_or_line` path, returns `p_fair: null`). Let it return null cleanly.

**Recommended fix:**
```javascript
const totalLine =
  market_type === 'FIRST_PERIOD'
    ? asNumber(payload?.line)          // no fallback — let null propagate
    : asNumber(oddsCtx?.total);
```

**Dependency notes:**  
Affects `fair_prob` on FIRST_PERIOD cards with no market line. `edge_pct` is already null in this case so `official_status` is unaffected. Tests asserting `fair_prob` on no-line FIRST_PERIOD cards need to expect null.

---

## Top 5 by Urgency

| # | Finding | File | Urgency Reason |
|---|---------|------|----------------|
| 1 | FINDING-01: NHL OVER edge suppressed | `edge-calculator.js` | Wrong-sign edge calls on all NHL total half-integer lines — active production plays may be calling UNDER when model says OVER |
| 2 | FINDING-02: Silent exception swallow | `decision-pipeline-v2.js` | Any payload bug producing a throw creates an unlogged DEGRADED card — no observability into pipeline health |
| 3 | FINDING-06: `truePlayMap` first-come | `route.ts` | Stale LEAN can shadow fresh FIRE for the same game in tonight's slate |
| 4 | FINDING-03: `reason_codes` never purged | `decision-publisher.js` | Contradictory codes on FIRE cards undermine any diagnostic tool built on `reason_codes` |
| 5 | FINDING-05: `shouldFlip` null→0 coercion | `decision-gate.js` | Latent phantom-flip path; low probability today but triggered by edge contract violations that are easy to introduce |

---

## Must Fix Before Tonight's Slate

1. **FINDING-01** (NHL line adjustment) — any NHL total game on the tonight slate is likely computing wrong-sign edge for half-integer lines.  
2. **FINDING-06** (`truePlayMap` ordering) — if multiple play-eligible cards exist for a game (gate-held LEAN + fresh FIRE), the LEAN can win as `true_play`.

---

## Calibration Items (Can Wait)

- **FINDING-07** (Sigma fallback constants) — the NBA sigma=14 is likely too small but this requires empirical measurement against `game_results`, not a code change. Investigate before next NBA calibration cycle.
- **FINDING-08** (Flag snapshot per run) — low-probability risk in current deployment (no live flag service). Acceptable risk until a dynamic feature flag service is introduced.
- **FINDING-10** (1.5 fallback line) — harmless to edge calls today (edge_pct is null regardless). Fix improves trace cleanliness only.

---

## Tests That Codify Wrong Behavior

These tests assert current (incorrect) behavior and will need updating alongside fixes:

1. **`edge-calculator.test.js`** — Any test asserting `p_fair` or `edge` for NHL half-integer totals (5.5, 6.5) using the +0.5 adjusted line. After FINDING-01 fix, these values will change.

2. **`decision-publisher.*.test.js`** — Any test asserting `reason_codes` accumulates (e.g., `expect(reason_codes).toContain(['old_code', 'new_code'])`). After FINDING-03 fix, `reason_codes` is replaced not merged.

3. **`decision-gate.flip-threshold.test.js`** — Any test asserting `EDGE_UPGRADE` fires when `candidate.edge_available === true` with `candidate.edge = null`. After FINDING-05 fix, this path should return `EDGE_UNAVAILABLE` not `EDGE_TOO_SMALL`.

4. **`decision-pipeline-v2.js` tests** — Any test asserting `fair_prob` is non-null for a FIRST_PERIOD card with no `payload.line`. After FINDING-10 fix, `fair_prob` will be null.

5. **Route tests** — Any test asserting `true_play` is the first chronologically stored play (not the highest-tier play). After FINDING-06 fix, PLAY tier beats LEAN regardless of insertion order.

---

## Not In Scope (confirmed out of audit scope)

- Source code changes
- Threshold value tuning (FINDING-07 is a calibration investigation note, not a code prescription)
- DB migrations
- Production data repair (stale `reason_codes` in existing rows)
- `market-contract.js`, `decision.ts`, `decision-logic.ts` — audited, no findings surfaced beyond what's captured above from the pipeline layer

---

*Audit complete. All findings are defect-first. No recommendations made outside the listed files. See WI-0572 for test commands and acceptance criteria.*
