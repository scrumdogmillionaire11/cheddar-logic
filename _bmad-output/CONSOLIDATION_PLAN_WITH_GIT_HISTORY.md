# Model Logic Deduplication — Comprehensive Consolidation Plan

**Status**: Ready for Implementation  
**Branch**: `debug/model-logic-duplication`  
**Created**: March 4, 2026

---

## PART A: GIT HISTORY ANALYSIS — ORIGIN TRACING

### 1. Win Probability & Driver Summary Functions

#### Original Implementation
- **First Commit**: `7367940` (Feb XX, 2026) — "feat: port NBA driver framework from personal-dashboard"
- **Function Source**: NBA model job file (run_nba_model.js)
- **Original Code**: `computeWinProbHome()` and `buildDriverSummary()` defined inline

#### Subsequent Implementations (Copies)
- **NHL Job** (run_nhl_model.js):
  - Commit `ad0d4ce` — "feat(quick-2): rewrite run_nhl_model.js + register driver card types"
  - Status: **IDENTICAL COPY** of NBA version (sigma=12)
  - No documented reason for duplication

- **NCAAM Job** (run_ncaam_model.js):
  - Commit `1603929` — "fully operational FPL sage and cheddar board"
  - Status: **Near-identical copy** with ONE INTENTIONAL VARIANCE
  - **Variance**: `sigma = 12` (NBA/NHL) vs `sigma = 11` (NCAAM)
  - **Reason Inferred**: College basketball has lower variance in point spreads (~11 pts) vs NBA (~12 pts)
  - **Last Modified**: Commit `1e8fb50` (Mar 2, 2026) — "Fix: Set canonical DATABASE_PATH"
    - Database fix swept through all three files simultaneously
    - Sigma variance **preserved and maintained** throughout

#### Consolidation Decision
- **Original**: NBA's `run_nba_model.js` (commit 7367940)
- **Action**: Extract to `packages/models/src/card-utilities.js` with **parameterized sigma handling**
- **Sigma Pattern**: Create sports-specific sigma registry in `edgeCalculator` (already has `getSigmaDefaults()`)

---

### 2. Edge Computation Duplication (Split Path)

#### Historical Timeline
1. **Original Edge Logic** (Early design):
   - Lived in job files (run_nba_model.js, run_nhl_model.js)
   - Computed `{ edge, p_fair, p_implied }` for each card

2. **Cross-Market Introduction**:
   - Commit `94061b5` (Feb 28, 2026) — "feat(quick-16): add computeNBAMarketDecisions to cross-market.js"
   - **Intent**: Centralize NBA market decision logic (drivers, weights, thresholds)
   - **Result**: Cross-market module created with `edgeResolver()` callbacks
   - **Problem**:job files **NOT updated** to remove duplicate edge computation
   - Both paths now live side-by-side

3. **Current State**:
   - **Job files** (`run_nba_model.js`, etc): Compute edge independently
   - **Cross-market.js**: Also computes edge via `edgeResolver()`
   - **Using both**: Job creates `marketPayload` from cross-market decisions, then **recomputes edge independently**
   - **Risk**: If edge calc changes, must update **two places**

#### Consolidation Decision
- **Original Intent**: Move edge to cross-market (commit 94061b5 rationale)
- **Current Reality**: Job files own card payload, so edge needed there
- **Solution**: **Single Source of Truth** pattern
  - Option A: Cross-market returns full `{ edge, p_fair, p_implied }` object (not just edge)
  - Option B: Job retrieves edge from cross-market result, never recomputes
  - **Chosen**: **Option B** — Keep job file as consumer, cross-market as provider
  - **Refactor**: Remove redundant edge computation from job files, use cross-market results directly

---

### 3. Market Decision Thresholds (Config Scatter)

#### Current State
- **NBA drivers** in `cross-market.js` lines 541-732:
  - Total projection weight: **0.45**
  - Power rating weight: **0.40**
  - Fire threshold: **~0.70** (implicit in buildDriver signal processing)
  - Watch threshold: **~0.55** (implicit)

- **NHL drivers** in `cross-market.js` lines 186-540:
  - Total projection weight: **0.40** (DIFFERENT)
  - Power rating weight: **0.35** (DIFFERENT)
  - Fire threshold: **~0.70** (same impl)
  - Watch threshold: **~0.55** (same impl)

- **NCAAM drivers** in `cross-market.js`:
  - Sports-specific weights (NCAAM metrics different from NBA/NHL)

#### Consolidation Decision
- **Original Source**: Cross-market weights set in commit 94061b5 (NBA first) and subsequent incremental commits
- **Current Problem**: Weights are magic constants in code, no configuration registry
- **Solution**: Create `apps/worker/src/models/market-config.js`
  ```javascript
  const MARKET_CONFIG = {
    NBA: {
      drivers: {
        totalProjection: { weight: 0.45 },
        powerRating: { weight: 0.40 },
        restAdvantage: { weight: 0.20 },
        matchupStyle: { weight: 0.25 },
        blowoutRisk: { weight: 0.15 }
      },
      thresholds: {
        fire: 0.70,
        watch: 0.55,
        conflictCap: 0.15
      }
    },
    NHL: { /* similar */ },
    NCAAM: { /* similar */ }
  };
  ```
- **Implementation**: Import and use in `cross-market.js` instead of hardcoded values

---

### 4. Card Generation Patterns (Repetition)

#### Timeline
- **NBA Original**: Lines 195-330 in `run_nba_model.js` (commit 7367940)
- **NHL Copy**: Lines 213-350 in `run_nhl_model.js` (commit ad0d4ce)
- **NCAAM Copy**: Different structure but similar payload assembly (commit 1603929)
- **All Three**: Refactored together in commit `1e8fb50` (database path fix)

#### Current Status
- Three nearly-identical functions: `generateNBACards()`, `generateNHLCards()`, `generateNCAAMCards()`
- ~120-135 lines each
- Same structure, sport prefix embedded in card ID
- No centralized factory pattern

#### Consolidation Decision
- **Original**: NBA card generation (run_nba_model.js, commit 7367940)
- **Pattern**: Create `packages/models/src/card-factory.js` with generic `generateCard(sport, ...)`
- **Benefit**: Single place to update card schema, payload structure, UUID generation
- **Implementation**: Parameterize sport prefix, handle sport-agnostic assembly logic

---

### 5. FPL Dual Engines (CRITICAL DIVERGENCE)

#### Timeline & Architecture

**Worker Mock Path** (read from `apps/worker/src/models/index.js`):
- Lines 1028-1031 in current version
- Introduced: **Commit 1603929** — "fully operational FPL sage and cheddar board"
- **Logic**: Odds-based, mock constant fallback
  ```javascript
  const confidence = mockConfig.confidence;
  const predictHome = homeOdds < awayOdds;
  return {
    prediction: predictHome ? 'HOME' : 'AWAY',
    confidence,
    ev_threshold_passed: confidence > 0.55,
    reasoning: `Model prefers ${predictHome ? 'HOME' : 'AWAY'} team...`,
    inference_source: 'mock',
    is_mock: true
  };
  ```

**Python FPL Sage Stack** (cheddar-fpl-sage/):
- Introduced: **Commit 1603929** — Same commit ("fully operational FPL sage and cheddar board")
- **Logic**: Transfer recommendations, captain selection, chip management
- **Files**: 
  - `cheddar-fpl-sage/src/cheddar_fpl_sage/analysis/decision_framework/transfer_advisor.py` (500+ lines)
  - Full game-state analysis (injuries, suspensions, fixtures, transfers)
- **Integration**: Used by `cheddar-fpl-sage/fpl_sage.py` CLI, **NOT by worker**

#### Current Problem
1. **Two parallel systems** compute FPL predictions
2. **No unified contract** for which engine is authoritative
3. **Worker path writes BETTING CARDS** (odds-based, mock confidence)
4. **Sage path computes STRATEGY** (transfer recommendations, not betting bets)
5. **If both active**: Potential for **contradictory signals** reaching UI
6. **No clear integration boundary**

#### Consolidation Decision
**CRITICAL**: This is not a simple deduplication—it's an **architectural decision**:

**Option 1: Replace Worker with Sage**
- Remove mock path from worker
- Worker calls Python FPL Sage backend for FPL predictions
- **Pros**: Single source of truth, game-state aware
- **Cons**: Adds Python dependency, network latency
- **Risk**: Sage engine not yet proven in production

**Option 2: Keep Both, Define Contract**
- Worker path: Non-strategic odds-based bets (props, spreads)
- Sage path: Strategic game-analysis (transfers, captaincy)
- **Pros**: Leverages existing worker infra
- **Cons**: Two separate outputs, potential confusion
- **Trade-off**: Clearer responsibility separation

**Option 3: Merge into Unified FPL Engine**
- Create new `apps/worker/src/models/fpl-model.js`
- Absorb relevant Sage logic (transfer value, captaincy scoring)
- Emit both betting cards AND strategy recommendations
- **Pros**: Single codebase, fast execution (no Python)
- **Cons**: Reimplements Sage logic in JS, maintenance burden

**Recommendation**: **Option 1** (Replace Worker with Sage)
- Rationale: Sage is the more sophisticated engine
- Cost: Requires FPL Sage backend stability verification
- Timeline: Add to later phase, not critical path for NBA/NHL/NCAAM consolidation

**Minimal Viable Action (This Phase)**:
- Document the split clearly in `FPL_DUAL_ENGINES.md`
- Add comments in code explaining both exist
- Flag as "consolidation phase 2" after this dedup is stable

---

## PART B: PHASED CONSOLIDATION PLAN

### Phase 1: Foundation (Low Risk, High Impact)

#### 1.1 Extract Shared Utilities (Helper Functions)

**Files to Create**:
- `packages/models/src/card-utilities.js` (NEW)

**Implementation**:
```javascript
// packages/models/src/card-utilities.js

/**
 * Compute home team win probability from projected margin
 * @param {number} projectedMargin - Projected point margin
 * @param {string} sport - Sport key: 'NBA', 'NHL', 'NCAAM'
 * @returns {number|null} - Win probability (0-1) or null if invalid
 */
function computeWinProbHome(projectedMargin, sport) {
  if (!Number.isFinite(projectedMargin)) return null;
  
  // Use edgeCalculator's sport-specific sigma defaults
  // This respects NCAAM's sigma=11, NBA/NHL sigma=12
  const sigma = edgeCalculator.getSigmaDefaults(sport)?.margin ?? 
    (sport === 'NCAAM' ? 11 : 12);
  
  const winProb = marginToWinProbability(projectedMargin, sigma);
  return Number.isFinite(winProb) ? Number(winProb.toFixed(4)) : null;
}

/**
 * Build driver summary with impact calculation
 * @param {object} descriptor - Driver descriptor with driverKey, driverWeight, driverScore
 * @param {object} weightMap - Map of driverKey to weight (fallback)
 * @returns {object} - Summary with weights array and impact_note
 */
function buildDriverSummary(descriptor, weightMap) {
  const weight = descriptor.driverWeight ?? weightMap[descriptor.driverKey] ?? 1;
  const score = descriptor.driverScore ?? null;
  const impact = score !== null ? Number(((score - 0.5) * weight).toFixed(3)) : null;

  return {
    weights: [
      {
        driver: descriptor.driverKey,
        weight,
        score,
        impact,
        status: descriptor.driverStatus ?? null
      }
    ],
    impact_note: 'Impact = (score - 0.5) * weight. Positive favors HOME, negative favors AWAY.'
  };
}

module.exports = {
  computeWinProbHome,
  buildDriverSummary
};
```

**Job File Updates**:
- Delete `computeWinProbHome()` from `run_nba_model.js` (lines 175-178)
- Delete `computeWinProbHome()` from `run_nhl_model.js` (lines 185-188)
- Delete `computeWinProbHome()` from `run_ncaam_model.js` (lines 52-55)
- Delete `buildDriverSummary()` from all three job files
- Add import: `const { computeWinProbHome, buildDriverSummary } = require('@cheddar-logic/models/card-utilities');`

**Testing**:
- Run all three QuickStart commands
- Compare card outputs before/after
- Verify NCAAM sigma=11, NBA/NHL sigma=12 in win probabilities
- No regressions allowed

**Safety Gate**:
- Run parallel execution (old vs new) on one game each sport
- Validate card payload signatures match byte-for-byte (except timestamp)

---

#### 1.2 Create Market Configuration Registry

**Files to Create**:
- `apps/worker/src/models/market-config.js` (NEW)

**Implementation**:
```javascript
// apps/worker/src/models/market-config.js

const MARKET_CONFIG = {
  NBA: {
    // TOTAL drivers
    totalProjectionWeight: 0.45,
    paceEnvironmentWeight: 0.35,
    defensiveShellWeight: 0.20,
    
    // SPREAD drivers
    powerRatingWeight: 0.40,
    restAdvantageWeight: 0.20,
    matchupStyleWeight: 0.25,
    blowoutRiskWeight: 0.15,
    
    // Decision thresholds
    fireThreshold: 0.70,
    watchThreshold: 0.55,
    conflictCap: 0.15
  },
  
  NHL: {
    // TOTAL drivers
    totalProjectionWeight: 0.40,
    paceEnvironmentWeight: 0.40,
    defensiveShellWeight: 0.20,
    
    // SPREAD drivers
    powerRatingWeight: 0.35,
    restAdvantageWeight: 0.20,
    matchupStyleWeight: 0.25,
    blowoutRiskWeight: 0.20,
    
    // Decision thresholds
    fireThreshold: 0.70,
    watchThreshold: 0.55,
    conflictCap: 0.15
  },
  
  NCAAM: {
    // TOTAL drivers (adjusted for college game dynamics)
    totalProjectionWeight: 0.45,
    restAdvantageWeight: 0.20,
    matchupStyleWeight: 0.35,  // College matchups more important
    
    // SPREAD drivers
    powerRatingWeight: 0.40,
    restAdvantageWeight: 0.20,
    matchupStyleWeight: 0.30,
    blowoutRiskWeight: 0.10,
    
    // Decision thresholds
    fireThreshold: 0.70,
    watchThreshold: 0.55,
    conflictCap: 0.15
  }
};

function getMarketConfig(sport) {
  return MARKET_CONFIG[sport] || MARKET_CONFIG.NBA;
}

module.exports = {
  MARKET_CONFIG,
  getMarketConfig
};
```

**Cross-Market Updates**:
- Replace all hardcoded weights with `const config = getMarketConfig(sport);`
- Example: Change `weight: 0.45` to `weight: config.totalProjectionWeight`

**Testing**:
- Verify all weights extracted correctly in `cross-market.js`
- Confirm decision thresholds (FIRE/WATCH) unchanged
- Test with all three sports

---

### Phase 2: Edge Computation Consolidation (Medium Risk)

#### 2.1 Unify Edge Logic to Cross-Market Source

**Problem to Solve**:
- Job files currently recompute edge independently
- Cross-market already has edge computation via `edgeResolver()`
- Solution: Use cross-market result, don't recompute

**Current Job Pattern** (`run_nba_model.js` lines 249-266):
```javascript
const totalEdgeResult = hasLockableTotal
  ? edgeCalculator.computeTotalEdge({...})
  : { edge: null, p_fair: null, p_implied: null };
const moneylineEdgeResult = (isPredictionHome || isPredictionAway)
  ? edgeCalculator.computeMoneylineEdge({...})
  : { edge: null, p_fair: null, p_implied: null };
const edgeResult = isTotalsCard ? totalEdgeResult : moneylineEdgeResult;
```

**New Pattern** (after consolidation):
- Retrieve edge from cross-market decision result
- Cross-market already computed via `edgeResolver()`
- No independent recomputation needed

**Implementation**:
1. Modify cross-market to return full `{ edge, p_fair, p_implied }` object (if not already)
2. Job files call cross-market and extract edge result
3. Delete edge computation from job files

**Testing**:
- Compare edge values before/after consolidation
- Verify no differences in final payloads
- Test edge boundaries (nil, negative, high positive)

---

### Phase 3: Card Generation Unification (Medium Risk)

#### 3.1 Create Generic Card Factory

**Files to Create**:
- `packages/models/src/card-factory.js` (NEW)

**Implementation**:
```javascript
// packages/models/src/card-factory.js

function generateCard(sport, gameId, descriptor, oddsSnapshot, marketPayload) {
  const cardId = `card-${sport.toLowerCase()}-${descriptor.driverKey}-${gameId}-${uuidV4().slice(0, 8)}`;
  const now = new Date().toISOString();
  
  let expiresAt = null;
  if (oddsSnapshot?.game_time_utc) {
    const gameTime = new Date(oddsSnapshot.game_time_utc);
    expiresAt = new Date(gameTime.getTime() - 60 * 60 * 1000).toISOString();
  }

  const recommendation = buildRecommendationFromPrediction({
    prediction: descriptor.prediction,
    recommendedBetType: descriptor.recommendedBetType || 'moneyline'
  });

  const matchup = buildMatchup(oddsSnapshot?.home_team, oddsSnapshot?.away_team);
  const { start_time_local: startTimeLocal, timezone } = formatStartTimeLocal(oddsSnapshot?.game_time_utc);
  const countdown = formatCountdown(oddsSnapshot?.game_time_utc);
  const market = buildMarketFromOdds(oddsSnapshot);

  return {
    id: cardId,
    gameId,
    sport,
    created_at: now,
    expires_at: expiresAt,
    recommendation,
    matchup,
    driver_key: descriptor.driverKey,
    driver_inputs: descriptor.driverInputs,
    driver_impact: descriptor.driverImpact,
    edge: descriptor.edge,
    confidence: descriptor.confidence,
    decision_class: descriptor.decisionClass,
    action: descriptor.action,
    startTimeLocal,
    countdown,
    timezone,
    market,
    card_type: descriptor.cardType,
    playable: descriptor.playable,
    reasoning: descriptor.reasoning
  };
}

module.exports = { generateCard };
```

**Job File Updates**:
- Replace `generateNBACards()`, `generateNHLCards()`, `generateNCAAMCards()`
- Call `generateCard(sport, gameId, descriptor, oddsSnapshot, marketPayload)` in loop
- Delete ~120 lines per job file

**Testing**:
- Card payloads must match byte-for-byte pre/post consolidation
- Test all sport variants

---

### Phase 4: FPL Consolidation (Lower Priority, Future)

#### 4.1 Document Dual-Engine Contract

**File to Create**:
- `_bmad-output/FPL_DUAL_ENGINES_STRATEGY.md` (Phase 2 planning document)

**Documentation Scope**:
- Worker odds-based betting path (current)
- Python Sage strategic path (current)
- Integration boundary (undefined)
- Migration strategy options (Option 1/2/3 analysis)
- Timeline for Phase 2 consolidation

**No Code Changes This Phase** — Planning only

---

## PART C: IMPLEMENTATION SEQUENCE

### Week 1: Phase 1 (Foundation)
- **Task 1.1**: Extract shared utilities (card-utilities.js)
- **Task 1.1a**: Update job file imports (3 files)
- **Task 1.1b**: Baseline testing and validation
- **Task 1.2**: Create market-config.js
- **Task 1.2a**: Update cross-market.js to use config
- **Task 1.2b**: Testing and validation

### Week 2: Phase 2 (Edge Consolidation)
- **Task 2.1**: Unify edge logic (cross-market as source)
- **Task 2.1a**: Remove job file edge computation
- **Task 2.1b**: Integration testing

### Week 3: Phase 3 (Card Factory)
- **Task 3.1**: Create card-factory.js
- **Task 3.1a**: Update all three job files to use factory
- **Task 3.1b**: Validation testing

### Week 4+: Phase 4 (FPL Planning)
- **Task 4.1**: Document dual-engine strategy
- **Task 4.1a**: Prototype Option 1 (replace with Sage)
- Defer implementation based on Sage stability assessment

---

## PART D: ENFORCEMENT GATES (NOT VIBES-BASED TESTING)

**See companion documents for the complete enforcement architecture:**
- **`CONSOLIDATION_OWNERSHIP_MAP.md`** — Authoritative ownership contract + enforcement tests
- **`GOLDEN_FIXTURES.md`** — Deterministic input-output fixtures for each sport

### The Two Pillars of Validation

#### Pillar 1: Ownership Enforcement (Prevents Re-Duplication)

**Test**: `apps/worker/src/models/__tests__/ownership-enforcement.test.js`

```javascript
// No function can exist in two places
- computeWinProbHome: only in packages/models/src/card-utilities.js ✓
- buildDriverSummary: only in packages/models/src/card-utilities.js ✓
- generateCard: only in packages/models/src/card-factory.js ✓
- generateNBACards, generateNHLCards, generateNCAAMCards: must be DELETED ✓

// Market config only accessed through registry
- getMarketConfig(sport) returns all thresholds & weights ✓
- No hardcoded 0.45, 0.40, 0.35, etc. in cross-market.js ✓
```

**Enforcement**: Fails on PR if clones detected. Non-negotiable.

#### Pillar 2: Golden Fixture Snapshots (Deterministic Regression Detection)

**Fixtures**: Three input-output pairs (see `GOLDEN_FIXTURES.md`)

| Sport | Fixture | Input | Expected Output | Key Assertion |
|-------|---------|-------|-----------------|----------------|
| NBA | `nba-lal-bos-202602280001` | LAL@BOS odds + drivers | Card payloads (3 cards) | Sigma=12, win_prob=0.6156 |
| NHL | `nhl-tor-edm-202602280002` | TOR@EDM odds + drivers | Card payloads (1 card) | Sigma=12, weight=0.35 |
| NCAAM | `ncaam-duke-unc-202602280003` | DUKE@UNC odds + drivers | Card payloads (1 card) | **Sigma=11** (NOT 12), win_prob=0.5686 |

**Test**: `apps/worker/src/jobs/__tests__/card-generation.fixture-test.js`

```bash
# Before consolidation: Capture golden fixtures
npm test -- card-generation.fixture-test.js --generate

# After Phase 1: Verify fixtures match
npm test -- card-generation.fixture-test.js
# ✅ Expected: All pass
# ❌ Actual failure: Revert PR immediately, investigate divergence

# After Phase 2: Re-verify
npm test -- card-generation.fixture-test.js
# Same strict requirement

# After Phase 3: Final validation
npm test -- card-generation.fixture-test.js
# Must still pass; no regression allowed
```

**Critical Canary Test** (NCAAM Sigma Variance):
```javascript
test('NCAAM sigma=11 differs from NBA sigma=12', () => {
  // If this fails, consolidation stripped intentional sport variance
  const nbaProb = computeWinProbHome(-2.5, 'NBA');   // sigma=12 → 0.4266
  const ncaamProb = computeWinProbHome(-2.5, 'NCAAM'); // sigma=11 → 0.4129
  
  expect(ncaamProb).not.toBe(nbaProb);
  expect(ncaamProb).toBeLessThan(nbaProb);
});
```

### Pre-Consolidation: Generate Fixtures

```bash
# Run current code with test data to capture golden fixtures
npm test -- card-generation.fixture-test.js --generate

# This creates:
# - apps/worker/src/jobs/__tests__/fixtures/nba-lal-bos-expected.json
# - apps/worker/src/jobs/__tests__/fixtures/nhl-tor-edm-expected.json
# - apps/worker/src/jobs/__tests__/fixtures/ncaam-duke-unc-expected.json

# Commit these fixtures to git: they are the source of truth
git add apps/worker/src/jobs/__tests__/fixtures/*-expected.json
git commit -m "test: Golden fixture snapshots (pre-consolidation baseline)"
```

### Per-Phase Validation

**Phase 1 Complete?**
```bash
npm test -- ownership-enforcement.test.js
npm test -- card-generation.fixture-test.js
# Both pass = ready to merge
# Any fail = revert, fix, retest
```

**Phase 2 Complete?**
```bash
npm test -- ownership-enforcement.test.js  # Edge ownership rules
npm test -- card-generation.fixture-test.js  # Card outputs unchanged
# Both pass = ready to merge
```

**Phase 3 Complete?**
```bash
npm test -- ownership-enforcement.test.js  # Card factory ownership
npm test -- card-generation.fixture-test.js  # Card outputs unchanged
# Both pass = ready to merge
```

### Rollback Criteria (Absolute)

**If ANY enforcement test fails:**
1. Revert PR immediately (do not merge)
2. Do not proceed to next phase
3. Investigate root cause
4. Fix + retest in isolation
5. Only re-merge after ALL tests pass

This is not a recommendation. This is the contract.

---

## PART E: GIT COMMIT STRATEGY

### Commit Structure
Each phase = one feature branch, one PR

```bash
# Phase 1a: Extract utilities
git checkout -b refactor/extract-card-utilities
# ... implement 1.1 ...
git commit -m "refactor: Extract computeWinProbHome and buildDriverSummary to shared utilities

- Create packages/models/src/card-utilities.js
- Parameterize sigma handling for NCAAM (11) vs NBA/NHL (12)
- Update imports in run_nba_model.js, run_nhl_model.js, run_ncaam_model.js
- All job files now use shared utilities (DRY principle)
- Tests: Verified byte-for-byte card payload match"
```

### Commit Message Pattern
```
refactor: [Phase/Task] Description of change

Why:
- Rationale from git history analysis

What:
- Specific files changed
- Functions moved/deleted
- Imports updated

How:
- Testing approach
- Safety gates applied

Risk:
- Mitigation strategies (parallel execution, feature flags, etc.)
```

---

## PART F: ROLLBACK & SAFETY

### If Regression Detected
1. **Immediate**: Revert PR
2. **Investigate**: Compare old vs new outputs line-by-line
3. **Root Cause**: Identify which consolidation caused regression
4. **Fix**: Correct logic, test isolatedly
5. **Retest**: Run full baseline comparison again

### Keep-Alive Strategy
- Original functions stay in job files for 2 weeks post-consolidation
- Commented-out, marked as "deprecated"
- Fully removed once stability confirmed in production

---

## PART G: SUMMARY TABLE

| Phase | Task | Risk | Impact | Duration | Owner |
|-------|------|------|--------|----------|-------|
| 1.1 | Extract shared utilities | LOW | HIGH (3 files deduplicated) | 1 day | Engineer |
| 1.2 | Market config registry | LOW | MEDIUM (centralized config) | 1 day | Engineer |
| 2.1 | Edge consolidation | MEDIUM | HIGH (removes duplication) | 2 days | Engineer |
| 3.1 | Card factory | MEDIUM | MEDIUM (removes 120 LOC) | 2 days | Engineer |
| 4.1 | FPL strategy documentation | LOW | MEDIUM (planning) | 1 day | Engineer |

**Total Effort**: ~7-8 days  
**Go-Live**: Phase 3 complete (Week 3)  
**Phase 4**: Deferred to post-stabilization

---

## NEXT STEPS

1. ✅ **Git History Traced** — All variants genealogized
2. ✅ **Plan Created** — Phased consolidation strategy ready
3. 🔄 **Ready for Implementation** — Awaiting approval

**Ask from Ajcolubiale**:
- Approve phased sequence?
- Any adjustments to risk tolerance?
- Preferred FPL strategy (Option 1/2/3)?
- Start Phase 1 immediately or additional planning?
