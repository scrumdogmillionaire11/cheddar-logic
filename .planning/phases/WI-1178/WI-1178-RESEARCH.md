# Phase WI-1178: Normalize POTD Edge Calculation And Scoring Across Sports — Research

**Researched:** 2026-04-25
**Domain:** POTD signal-engine scoring, edge-calculator.js sigma model, noise floor normalization
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| WI-1178-EDGE-01 | NBA total edge computed via `computeTotalEdge()` from edge-calculator.js, not the `/20` linear heuristic. `sigmaTotal` defaults to `getSigmaDefaults('NBA').total` (14). `modelWinProb` and `edgePct` are finite numbers. | computeTotalEdge() fully verified: correct return shape, accepts required params available on NBA TOTAL candidates, produces edge=0.0568 for a 2pt gap vs /20's 0.10. Import must be added. |
| WI-1178-SCORE-01 | `totalScore` formula updated to `(lineValue * 0.5) + (marketConsensus * 0.3) + (edgeComponent * 0.2)` where `edgeComponent = clamp((edgePct / 0.12) + 0.5, 0, 1)` and `EDGE_NORMALIZATION_CAP = 0.12`. Applied to ALL four scoring paths (MLB override, NHL override, NBA TOTAL override, CONSENSUS_FALLBACK). | All four score paths identified at lines 784, 832, 881, 918. Formula change is three-field additive blend replacing two-field blend. edgeComponent clamp boundaries verified. |
| WI-1178-FLOOR-01 | `POTD_NOISE_FLOOR_NBA_TOTAL` default raised from `0.02` to `0.03` in NOISE_FLOORS constant. | NOISE_FLOORS at line 97: `TOTAL: Number(process.env.POTD_NOISE_FLOOR_NBA_TOTAL \|\| 0.02)` — single line change, env-var override preserved. |
</phase_requirements>

---

## Summary

WI-1178 is a precision surgical change to `signal-engine.js` with exactly three independent concerns: (1) replace the NBA total `/20` linear probability shortcut with a call to the existing `computeTotalEdge()` function from `edge-calculator.js`, (2) update the `totalScore` formula across all four scoring branches from a two-term blend to a three-term blend that incorporates a normalized edge component, and (3) raise the NBA TOTAL noise floor default from 0.02 to 0.03.

All required infrastructure already exists. `computeTotalEdge()` is exported from `packages/models/src/edge-calculator.js` and returns exactly the shape needed (`edge`, `p_fair`, `p_implied`, `confidence`, `sigma_used`, `rail_flags`). `getSigmaDefaults('NBA').total` returns 14. The only missing piece is the `require()` import at the top of `signal-engine.js` — no import currently exists. The NBA TOTAL candidate object already carries `oddsContext.total_price_over`, `oddsContext.total_price_under`, `consensusLine`, and `line` — all inputs `computeTotalEdge()` needs.

The scoring formula change affects all four score-assignment lines (784, 832, 881, 918). The formula is mechanically identical across all paths: `(lineValue * 0.5) + (marketConsensus * 0.3) + (edgeComponent * 0.2)` where `edgeComponent = clamp((edgePct / EDGE_NORMALIZATION_CAP) + 0.5, 0, 1)`. Verified: `EDGE_NORMALIZATION_CAP = 0.12` produces clamp-to-1 at `edgePct >= +0.06` and clamp-to-0 at `edgePct <= -0.06`. At a typical NBA 2pt gap, sigma-based `edgePct = 0.0568`, giving `edgeComponent = 0.973` — meaningfully above neutral but below the cap.

**Primary recommendation:** Implement in a single wave. The three changes are tightly coupled (edge path feeds formula feeds noise floor) and small enough for one commit.

---

## Standard Stack

### Core (already in use — no new dependencies)

| Library | Location | Purpose | Status |
|---------|----------|---------|--------|
| `packages/models/src/edge-calculator.js` | Internal package | `computeTotalEdge()`, `getSigmaDefaults()` | Exists, used elsewhere, NOT yet imported in signal-engine.js |
| `apps/worker/src/jobs/potd/signal-engine.js` | Target file | POTD scoring engine | Modify in place |
| `apps/worker/src/jobs/potd/__tests__/signal-engine.test.js` | Test file | 49 existing tests, Jest runner | Add 3–4 tests |

**No new npm packages required.** The edge-calculator is a workspace package already resolvable via the monorepo.

**Installation:** None needed. The import path is:
```js
const { computeTotalEdge, getSigmaDefaults } = require('../../../../packages/models/src/edge-calculator');
```

Or if the workspace alias resolves cleanly:
```js
const { computeTotalEdge, getSigmaDefaults } = require('@cheddar-logic/models/src/edge-calculator');
```

Verify the exact require path by checking how `nhl-pace-model` is imported at line 3 of signal-engine.js:
```js
const { resolveGoalieComposite } = require('../../models/nhl-pace-model');
```
This is a relative path from `apps/worker/src/jobs/potd/` to `apps/worker/src/models/`. The edge-calculator is in `packages/models/src/`. Check the monorepo package name before committing.

---

## Architecture Patterns

### Recommended Project Structure (no changes)
```
apps/worker/src/jobs/potd/
├── signal-engine.js       — modify: import, NBA TOTAL block, all 4 totalScore lines, NOISE_FLOORS
└── __tests__/
    └── signal-engine.test.js  — add 3–4 test cases
packages/models/src/
└── edge-calculator.js     — read-only (provides computeTotalEdge, getSigmaDefaults)
```

### Pattern 1: NBA TOTAL Model Override Block (current, lines 868–914)

**What:** Resolves `nbaSignal.totalProjection`, computes `modelOverProb` via linear `/20` heuristic, assigns `modelSelectionProb`, `modelEdge`, `totalScore`.
**Current code (lines 874–881):**
```js
const refLine = isFiniteNumber(candidate.consensusLine) ? candidate.consensusLine : candidate.line;
const modelOverProb = clamp(0.5 + (nbaSignal.totalProjection - refLine) / 20, 0.05, 0.95);
const modelSelectionProb = candidate.selection === 'OVER'
  ? round(modelOverProb, 6)
  : round(1 - modelOverProb, 6);
const modelEdge = round(modelSelectionProb - impliedProb, 6);
const totalScore = round((lineValue * 0.625) + (marketConsensus * 0.375), 6);
```

**Replacement pattern:**
```js
const refLine = isFiniteNumber(candidate.consensusLine) ? candidate.consensusLine : candidate.line;
const isPredictionOver = candidate.selection === 'OVER';
const totalEdgeResult = computeTotalEdge({
  projectionTotal: nbaSignal.totalProjection,
  totalLine: refLine,
  totalPriceOver: candidate.oddsContext?.total_price_over ?? null,
  totalPriceUnder: candidate.oddsContext?.total_price_under ?? null,
  sigmaTotal: getSigmaDefaults('NBA').total,  // 14
  isPredictionOver,
});
const modelSelectionProb = isFiniteNumber(totalEdgeResult?.p_fair)
  ? round(totalEdgeResult.p_fair, 6)
  : null;
if (modelSelectionProb === null) return null;  // guard: edge-calculator returned null
const modelEdge = round(totalEdgeResult.edge, 6);
const edgeComponent = clamp((modelEdge / EDGE_NORMALIZATION_CAP) + 0.5, 0, 1);
const totalScore = round((lineValue * 0.5) + (marketConsensus * 0.3) + (edgeComponent * 0.2), 6);
```

**Source of truth:** `computeTotalEdge()` signature verified from `packages/models/src/edge-calculator.js` lines 295–384. `p_fair` is the selection's fair probability (already direction-adjusted by `isPredictionOver`). `edge = p_fair - p_implied`.

### Pattern 2: The Four totalScore Lines (all four paths get identical formula)

| Line | Path | Current | Replace with |
|------|------|---------|--------------|
| 784 | MLB snapshot override | `round((lineValue * 0.625) + (marketConsensus * 0.375), 6)` | `round((lineValue * 0.5) + (marketConsensus * 0.3) + (edgeComponent * 0.2), 6)` |
| 832 | NHL model override | same | same |
| 881 | NBA TOTAL override | same | same |
| 918 | CONSENSUS_FALLBACK | same | same |

For the MLB (line 784) and NHL (line 832) paths, `edgePct` is already computed before `totalScore`. For CONSENSUS_FALLBACK (line 918), `edgePct` is computed at line 917. In all cases, `edgeComponent` must be computed immediately before the `totalScore` line using the already-available `edgePct` (or `modelEdge` in the NBA path).

**Constant declaration** — place near the top of the file (after NOISE_FLOORS, before scoreCandidate):
```js
const EDGE_NORMALIZATION_CAP = 0.12;
```

### Pattern 3: NOISE_FLOORS Change (line 97)

**Current:**
```js
TOTAL: Number(process.env.POTD_NOISE_FLOOR_NBA_TOTAL || 0.02),
```
**Replace with:**
```js
TOTAL: Number(process.env.POTD_NOISE_FLOOR_NBA_TOTAL || 0.03),
```

### Anti-Patterns to Avoid

- **Computing `p_fair` directly from `totalEdgeResult.p_fair` without checking for null:** `computeTotalEdge()` returns `{ edge: null, ..., reason: 'invalid_total_odds' }` when `p_implied` is null. Always guard `isFiniteNumber(totalEdgeResult?.edge)` or check `totalEdgeResult?.edge !== null` before using.
- **Using `totalEdgeResult.p_fair` as `modelSelectionProb` when prices are missing:** When `totalPriceOver`/`totalPriceUnder` are null, the function returns `VIG_REMOVAL_SKIPPED: true` but will also return `edge: null` via `invalid_total_odds`. Guard appropriately.
- **Forgetting `edgeComponent` in NBA path where `edgePct` is named `modelEdge`:** In the NBA block, `modelEdge` is the variable name for `edgePct`. Use `modelEdge` (not `edgePct`) when computing `edgeComponent` inside the NBA block.
- **Changing `EDGE_SOURCE_CONTRACT`:** The WI spec explicitly prohibits any modification to `EDGE_SOURCE_CONTRACT`, `edgeSourceTag`, or `isModelBackedCandidate` logic.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Normal CDF for sigma-based probability | Custom normal approximation | `computeTotalEdge()` from edge-calculator.js | Already implemented (Abramowitz & Stegun, max |error| < 4.5e-4), tested, handles continuity correction and rail_flags |
| Vig removal for total prices | Inline `p_implied` math | `computeTotalEdge()` — handles `noVigImplied` internally | Two-sided vig removal already embedded; handles null prices with `VIG_REMOVAL_SKIPPED` |
| Sigma defaults per sport | Hardcoded `14` literal | `getSigmaDefaults('NBA').total` | Centralizes calibration; readable signal that 14 is a fallback with known provenance |

---

## Specific Questions — Answered

### Q1: `computeTotalEdge()` return shape

**Verified from `packages/models/src/edge-calculator.js` lines 295–384:**

```js
// Normal return:
{
  edge: Number,        // p_fair - p_implied, 4dp. This IS the edgePct.
  edgePoints: Number,  // projectionTotal - totalLine (raw point gap)
  p_fair: Number,      // direction-adjusted fair win probability
  p_implied: Number,   // vig-removed implied probability
  confidence: Number,  // 0.88 base, adjusted by confidenceContext
  sigma_used: Number,  // sigmaTotal used (e.g., 14)
  rail_flags: Array,   // e.g., ['EDGE_SANITY_CLAMP_APPLIED'] — always present, may be empty
}

// Error return (missing projection or line):
{
  edge: null, edgePoints: null, p_fair: null, p_implied: null,
  reason: 'missing_projection_or_line'
}

// Error return (invalid odds):
{
  edge: null, edgePoints: Number, p_fair: Number, p_implied: null,
  reason: 'invalid_total_odds', rail_flags: Array
}

// Partial return (vig removal skipped):
{
  ...normal fields...,
  VIG_REMOVAL_SKIPPED: true
}
```

**Required params:** `projectionTotal`, `totalLine` (both must be finite numbers or returns null edge).
**Optional params:** `totalPriceOver`, `totalPriceUnder` (null triggers `VIG_REMOVAL_SKIPPED`), `sigmaTotal` (default 14), `isPredictionOver` (default true), `confidenceContext`.

**What to use as `modelSelectionProb` (was `modelOverProb` in old code):** Use `totalEdgeResult.p_fair`. It is already direction-adjusted by `isPredictionOver`.

**What to use as `modelEdge`:** Use `totalEdgeResult.edge`. It equals `p_fair - p_implied`.

### Q2: Existing import from edge-calculator.js in signal-engine.js?

**No existing import.** The only external require in signal-engine.js is:
```js
const { resolveGoalieComposite } = require('../../models/nhl-pace-model');
```
A new require must be added. Verify the exact path — `nhl-pace-model` is at `apps/worker/src/models/nhl-pace-model.js` (relative `../../models/`). The edge-calculator is at `packages/models/src/edge-calculator.js`. The correct relative path from `apps/worker/src/jobs/potd/` depends on monorepo layout. Check if there is a package alias (e.g., `@cheddar-logic/models`).

### Q3: Test infrastructure

- **Test file:** `apps/worker/src/jobs/potd/__tests__/signal-engine.test.js` — 1270 lines, 49 existing tests
- **Test command:** `npm --prefix apps/worker run test -- src/jobs/potd/__tests__/signal-engine.test.js --runInBand`
- **Candidate factory:** `buildGame(overrides)` function exists at line 16 of test file. Takes an overrides object. Sports, market rows, and model snapshots are injected via `overrides`.
- **NBA TOTAL candidate pattern:** Use `buildGame({ sport: 'basketball_nba', nbaSnapshot: { totalProjection: N, projection_source: 'NBA_TOTALS_MODEL' }, market: { totals: [...] } })` then `buildCandidates(game)` to get real candidate objects with all `oddsContext` fields populated.
- **scoreCandidate** is exported and tested directly with hand-built candidates (see MLB and NHL test patterns in file).
- **No existing NBA TOTAL scoreCandidate test.** All existing NBA tests are in `per-sport pool` and `fixed-line runline` tests that don't test the NBA TOTAL model path.

### Q4: Exact formula change for the /20 path (line 876)

Current block (lines 875–881):
```js
const modelOverProb = clamp(0.5 + (nbaSignal.totalProjection - refLine) / 20, 0.05, 0.95);
const modelSelectionProb = candidate.selection === 'OVER'
  ? round(modelOverProb, 6)
  : round(1 - modelOverProb, 6);
const modelEdge = round(modelSelectionProb - impliedProb, 6);
const totalScore = round((lineValue * 0.625) + (marketConsensus * 0.375), 6);
```

Replace with (see Pattern 1 above). The `clamp(0.5..., 0.05, 0.95)` safety rail is not needed because `computeTotalEdge()` returns `p_fair` which is already bounded by the normal CDF (never reaches 0 or 1 for finite inputs), and extreme values are handled by the NHL-specific clamp logic inside the function that does not apply at NBA's sigma=14.

### Q5: Is EDGE_NORMALIZATION_CAP = 0.12 sensible for NBA totals at sigma=14?

**Empirically verified:**

| Projection gap | sigma-based edgePct | edgeComponent |
|---------------|---------------------|---------------|
| 1 pt | 0.0285 | 0.738 |
| 2 pt | 0.0568 | 0.973 |
| 3 pt | 0.0848 | 1.000 (capped) |
| 4 pt | 0.1125 | 1.000 (capped) |
| 5 pt | 0.1395 | 1.000 (capped) |

The cap of 0.12 means: any sigma-based edge of 6%+ scores `edgeComponent = 1.0` (maximum). At sigma=14, this requires ~2.1pt projection gap. Typical NBA projection gaps for POTD candidates are 1–4pt, so the cap is reached for gaps of 3+pts — which is correct behavior (signal ceiling beyond which more edge doesn't meaningfully differentiate). For a 2pt gap (most common signal), `edgeComponent = 0.973`, contributing `0.973 * 0.2 = 0.195` to `totalScore` vs 0.0 under the old formula.

**Verdict:** Cap is sensible. It prevents extreme projection outliers from dominating while providing meaningful differentiation in the 1–2pt range where most real signals live.

### Q6: Are there other callers of the totalScore formula beyond the four identified lines?

**Verified by audit of signal-engine.js:** The `totalScore` variable is assigned in exactly four places within `scoreCandidate()`:
- Line 784: MLB snapshot override return
- Line 832: NHL model override return
- Line 881: NBA TOTAL model override return
- Line 918: CONSENSUS_FALLBACK return (the catch-all)

All four must be updated. The formula is not called from any helper outside `scoreCandidate`. `selectTopPlays` and `selectBestPlay` consume `totalScore` but do not compute it.

### Q7: REQUIREMENTS.md entries relevant to POTD edge or scoring

**REQUIREMENTS.md does not exist** at `.planning/REQUIREMENTS.md`. The WI-1178 spec in `WORK_QUEUE/WI-1178.md` is the authoritative acceptance criteria document.

---

## Common Pitfalls

### Pitfall 1: Using `totalEdgeResult.edge` as `modelSelectionProb`
**What goes wrong:** `edge` = `p_fair - p_implied`. It is the probability advantage, not the win probability. Using `edge` as `modelSelectionProb` would set win probability to 0.05–0.15 instead of 0.50–0.65.
**How to avoid:** Use `totalEdgeResult.p_fair` as the replacement for `modelSelectionProb`. Use `totalEdgeResult.edge` as the replacement for `modelEdge`.

### Pitfall 2: Null guard on computeTotalEdge output
**What goes wrong:** If `candidate.oddsContext.total_price_over` is null (rare but possible for legacy hand-crafted candidates), `computeTotalEdge()` returns `{ edge: null, reason: 'invalid_total_odds' }`. Without a guard, `round(null, 6)` returns `null`, `totalScore` becomes NaN, and the candidate is silently dropped.
**How to avoid:** After calling `computeTotalEdge()`, check `isFiniteNumber(totalEdgeResult?.edge)`. If false, either fall back to the consensus path or `return null`. The WI spec says `modelWinProb` and `edgePct` must be finite numbers, so return null is correct.

### Pitfall 3: edgeComponent uses wrong variable name in NBA block
**What goes wrong:** Inside the NBA TOTAL block, the edge variable is named `modelEdge` (not `edgePct`). Other blocks use `edgePct`. Copy-paste errors are likely.
**How to avoid:** In the NBA block, `edgeComponent = clamp((modelEdge / EDGE_NORMALIZATION_CAP) + 0.5, 0, 1)`. In all other blocks, `edgeComponent = clamp((edgePct / EDGE_NORMALIZATION_CAP) + 0.5, 0, 1)`.

### Pitfall 4: Placing EDGE_NORMALIZATION_CAP constant inside scoreCandidate
**What goes wrong:** Constant is redeclared on every call; tests cannot inspect or stub it.
**How to avoid:** Declare `const EDGE_NORMALIZATION_CAP = 0.12;` at module scope, near NOISE_FLOORS.

### Pitfall 5: Incorrect require path for edge-calculator
**What goes wrong:** signal-engine.js uses `require('../../models/nhl-pace-model')` (relative to `apps/worker/src/`). The edge-calculator is in `packages/models/src/` — a different package root. A naive relative path like `../../../../../../packages/models/src/edge-calculator` is fragile.
**How to avoid:** Check the package.json workspace setup. If `packages/models` has a `name` field (e.g. `@cheddar-logic/models`), use that. Otherwise resolve the correct relative depth from `apps/worker/src/jobs/potd/`.

### Pitfall 6: Forgetting that WI spec requires `confidenceLabel` still uses `totalScore`
**What goes wrong:** If the scoring formula weight change causes all scores to shift below 0.5, all candidates become LOW confidence and the POTD engine produces no nominees.
**How to avoid:** The new formula with `edgeComponent * 0.2` is additive — it cannot reduce `totalScore` below what the old two-term formula produced at the same `lineValue`/`marketConsensus`, provided `edgeComponent >= 0`. Since `edgeComponent` is clamped to [0, 1] and old weights sum to 1.0, new weights also sum to 1.0. The score range is preserved.

---

## Code Examples

### computeTotalEdge() call pattern for NBA TOTAL
```js
// Source: packages/models/src/edge-calculator.js lines 295–384
const isPredictionOver = candidate.selection === 'OVER';
const totalEdgeResult = computeTotalEdge({
  projectionTotal: nbaSignal.totalProjection,
  totalLine: refLine,
  totalPriceOver: candidate.oddsContext?.total_price_over ?? null,
  totalPriceUnder: candidate.oddsContext?.total_price_under ?? null,
  sigmaTotal: getSigmaDefaults('NBA').total,  // 14
  isPredictionOver,
});

if (!isFiniteNumber(totalEdgeResult?.edge) || !isFiniteNumber(totalEdgeResult?.p_fair)) {
  return null;
}

const modelSelectionProb = round(totalEdgeResult.p_fair, 6);
const modelEdge = round(totalEdgeResult.edge, 6);
const edgeComponent = clamp((modelEdge / EDGE_NORMALIZATION_CAP) + 0.5, 0, 1);
const totalScore = round((lineValue * 0.5) + (marketConsensus * 0.3) + (edgeComponent * 0.2), 6);
```

### edgeComponent formula for paths where edgePct already exists
```js
// MLB path (line ~783), NHL path (line ~831), CONSENSUS_FALLBACK (line ~917)
// edgePct is computed before totalScore in each of these paths
const edgeComponent = clamp((edgePct / EDGE_NORMALIZATION_CAP) + 0.5, 0, 1);
const totalScore = round((lineValue * 0.5) + (marketConsensus * 0.3) + (edgeComponent * 0.2), 6);
```

### NOISE_FLOORS change
```js
// Line 97 in signal-engine.js
TOTAL: Number(process.env.POTD_NOISE_FLOOR_NBA_TOTAL || 0.03),  // was 0.02
```

### Module-scope constant declaration
```js
// Add after EDGE_SOURCE_CONTRACT block, before scoreCandidate function
const EDGE_NORMALIZATION_CAP = 0.12;
```

---

## Validation Architecture

`workflow.nyquist_validation` is absent from `.planning/config.json` — treat as enabled.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Jest (via `npm --prefix apps/worker run test`) |
| Config file | `apps/worker/package.json` `"test"` script |
| Quick run command | `npm --prefix apps/worker run test -- src/jobs/potd/__tests__/signal-engine.test.js --runInBand` |
| Full suite command | `npm --prefix apps/worker run test -- src/jobs/potd/ --runInBand` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| WI-1178-EDGE-01 | NBA TOTAL with 2pt gap produces edgePct < 0.10 (sigma path) | unit | `npm --prefix apps/worker run test -- src/jobs/potd/__tests__/signal-engine.test.js --runInBand -t "NBA sigma"` | ❌ Wave 0 |
| WI-1178-EDGE-01 | modelWinProb and edgePct are finite numbers (not null) | unit | same file | ❌ Wave 0 |
| WI-1178-SCORE-01 | edgeComponent clamps to 1 at edgePct >= +0.06 | unit | same file | ❌ Wave 0 |
| WI-1178-SCORE-01 | edgeComponent clamps to 0 at edgePct <= -0.06 | unit | same file | ❌ Wave 0 |
| WI-1178-FLOOR-01 | NBA TOTAL noise floor resolves to 0.03 when env var unset | unit | same file | ❌ Wave 0 |
| Regression | All 49 existing tests still pass | regression | full command above | ✅ Exists |

### Required Test Cases (new — Wave 0 gaps to add to signal-engine.test.js)

**Test 1: NBA sigma path produces smaller edge than /20**
```js
test('NBA TOTAL sigma path: 2pt projection gap produces edgePct < 0.10', () => {
  const candidate = {
    sport: 'basketball_nba',
    marketType: 'TOTAL',
    selection: 'OVER',
    // ... full candidate shape with nbaSnapshot.totalProjection = line + 2
    // oddsContext.total_price_over = -110, oddsContext.total_price_under = -110
  };
  const scored = scoreCandidate(candidate);
  expect(scored.edgePct).toBeGreaterThan(0);
  expect(scored.edgePct).toBeLessThan(0.10);  // /20 would give 0.10
  expect(Number.isFinite(scored.modelWinProb)).toBe(true);
  expect(Number.isFinite(scored.edgePct)).toBe(true);
});
```

**Test 2: edgeComponent clamp behavior**
```js
test('edgeComponent clamps correctly at 0 and 1', () => {
  // high edge candidate (edgePct >= 0.06): edgeComponent should be 1.0 → totalScore ceiling
  // zero edge: edgeComponent = 0.5 (neutral)
  // negative edge: edgeComponent < 0.5, clamps to 0 at -0.06
});
```

**Test 3: noise floor default reads 0.03**
```js
test('POTD_NOISE_FLOOR_NBA_TOTAL defaults to 0.03', () => {
  const { resolveNoiseFloor } = require('../signal-engine');
  delete process.env.POTD_NOISE_FLOOR_NBA_TOTAL;
  // must re-evaluate — since NOISE_FLOORS is module-level, this only works if
  // the constant is evaluated lazily OR the test uses a fresh require.
  // Use jest.resetModules() + fresh require pattern.
  expect(resolveNoiseFloor('NBA', 'TOTAL')).toBe(0.03);
});
```

**Note on noise floor test:** `NOISE_FLOORS` is evaluated at module load time from `process.env`. To test the default, use `jest.resetModules()` and `delete process.env.POTD_NOISE_FLOOR_NBA_TOTAL` before re-requiring. Alternatively, simply assert `resolveNoiseFloor('NBA', 'TOTAL') === 0.03` in the test environment where the env var is not set — this is valid if tests run without `.env` setting the variable.

### Sampling Rate

- **Per task commit:** `npm --prefix apps/worker run test -- src/jobs/potd/__tests__/signal-engine.test.js --runInBand`
- **Per wave merge:** `npm --prefix apps/worker run test -- src/jobs/potd/ --runInBand`
- **Phase gate:** Full suite green before marking WI-1178 complete

### Wave 0 Gaps

- [ ] Add 3–4 test cases to `apps/worker/src/jobs/potd/__tests__/signal-engine.test.js` — covers WI-1178-EDGE-01, WI-1178-SCORE-01, WI-1178-FLOOR-01
- [ ] No new test files needed — existing file and infrastructure sufficient

---

## Open Questions

1. **`require()` path for edge-calculator**
   - What we know: signal-engine.js only imports from `../../models/nhl-pace-model` (relative, within apps/worker). The edge-calculator is at `packages/models/src/edge-calculator.js`.
   - What's unclear: Whether a workspace package alias (e.g. `@cheddar-logic/models`) is configured in `apps/worker/package.json`.
   - Recommendation: Before implementing, run `node -e "require('@cheddar-logic/models/src/edge-calculator')"` from `apps/worker/` to test. If it resolves, use that. Otherwise, determine the relative path: from `apps/worker/src/jobs/potd/` to `packages/models/src/edge-calculator.js` the relative path is `../../../../../packages/models/src/edge-calculator`.

2. **Behavior when `oddsContext` is absent on NBA TOTAL candidates**
   - What we know: `buildTotalCandidates()` always populates `oddsContext.total_price_over` and `total_price_under` on canonical candidates. Legacy or hand-crafted test candidates may not.
   - What's unclear: Whether any existing test constructs NBA TOTAL candidates without `oddsContext`.
   - Recommendation: Use `candidate.oddsContext?.total_price_over ?? null` (optional chain + nullish coalesce). `computeTotalEdge()` handles null prices gracefully via `VIG_REMOVAL_SKIPPED`. Guard the final `isFiniteNumber(totalEdgeResult.edge)` check.

---

## Sources

### Primary (HIGH confidence)
- `packages/models/src/edge-calculator.js` — Full function signatures, return shapes, and implementation for `computeTotalEdge()`, `getSigmaDefaults()`, `normCdf()`. All claims verified by direct code inspection.
- `apps/worker/src/jobs/potd/signal-engine.js` — Current implementation including NOISE_FLOORS (lines 85–99), EDGE_SOURCE_CONTRACT (lines 106–111), scoreCandidate function (lines 701–951), all four totalScore assignments.
- `apps/worker/src/jobs/potd/__tests__/signal-engine.test.js` — Test infrastructure, factory functions, 49 existing tests, imports verified.

### Secondary (MEDIUM confidence)
- Manual computation via `node -e` scripts: sigma-based edge values verified numerically against the actual `computeTotalEdge()` implementation running in-process.
- `WORK_QUEUE/WI-1178.md` — Acceptance criteria and regression scenarios used to drive all research questions.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all relevant code inspected directly, no third-party research needed
- Architecture: HIGH — four totalScore sites explicitly identified, NBA TOTAL block fully read
- Pitfalls: HIGH — verified empirically via node execution and code reading
- Test infrastructure: HIGH — test file inspected, 49 existing tests counted, factory functions confirmed

**Research date:** 2026-04-25
**Valid until:** 2026-05-25 (stable codebase — 30-day window appropriate)
