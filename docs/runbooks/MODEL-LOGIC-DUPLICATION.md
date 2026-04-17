# Model Logic Duplication Analysis

## Executive Summary

Your three Quickstart commands (NBA/NHL/NCAAM) execute through **one consistent runtime path**, BUT there is **significant internal duplication** that creates maintainability and correctness risk:
- **3 identical helper functions** across job files (`computeWinProbHome`, `buildDriverSummary`)
- **Market decision logic implemented twice** (worker-only `cross-market.js` vs. primitives in shared `packages/models`)
- **Edge/confidence computations split** between job files and cross-market module
- **FPL has two completely separate engines** (worker mock path vs. Python `cheddar-fpl-sage`)

---

## Duplication Hotspot #1: Win Probability & Driver Summary (HIGH RISK)

### Problem
The same utility functions are **rewritten identically** in three job files.

#### Code Location 1: apps/worker/src/jobs/run_nba_model.js (Lines 175-202)
```javascript
function computeWinProbHome(projectedMargin, sport) {
  if (!Number.isFinite(projectedMargin)) return null;
  const sigma = edgeCalculator.getSigmaDefaults(sport)?.margin ?? 12;
  const winProb = marginToWinProbability(projectedMargin, sigma);
  return Number.isFinite(winProb) ? Number(winProb.toFixed(4)) : null;
}

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
```

#### Code Location 2: apps/worker/src/jobs/run_nhl_model.js (Lines 185-212)
```javascript
function computeWinProbHome(projectedMargin, sport) {
  if (!Number.isFinite(projectedMargin)) return null;
  const sigma = edgeCalculator.getSigmaDefaults(sport)?.margin ?? 12;
  const winProb = marginToWinProbability(projectedMargin, sigma);
  return Number.isFinite(winProb) ? Number(winProb.toFixed(4)) : null;
}

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
```

#### Code Location 3: Historical NCAAM runner (removed in current worker package)
```javascript
function computeWinProbHome(projectedMargin, sport) {
  if (!Number.isFinite(projectedMargin)) return null;
  const sigma = edgeCalculator.getSigmaDefaults(sport)?.margin ?? 11;  // ← DIFFERS here (11 vs 12)
  const winProb = marginToWinProbability(projectedMargin, sigma);
  return Number.isFinite(winProb) ? Number(winProb.toFixed(4)) : null;
}

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
```

### Risk Assessment
- **Same logic, three places** → changes require three edits
- **NCAAM has different sigma default** (11 vs 12) → inconsistency risk
- **Should be:** Shared utility in `packages/models/src/card-model.js` or new `card-utilities.js`

### Consolidation Target
Move to `packages/models/src/card-utilities.js` with parameterized sigma handling for NCAAM variant.

---

## Duplication Hotspot #2: Edge Computation & Confidence Splitting (MEDIUM-HIGH RISK)

### Problem
Market decisions and edge calculations happen _twice_ — once in job files and again in `cross-market.js`, with potential for divergence.

#### Path A: In Job File (apps/worker/src/jobs/run_nba_model.js, Lines 249-266)
```javascript
    const totalEdgeResult = hasLockableTotal
      ? edgeCalculator.computeTotalEdge({
        projectionTotal: projectedTotal,
        totalLine,
        totalPriceOver: oddsSnapshot?.total_price_over ?? null,
        totalPriceUnder: oddsSnapshot?.total_price_under ?? null,
        sigmaTotal: edgeCalculator.getSigmaDefaults('NBA')?.total ?? 14,
        isPredictionOver
      })
      : { edge: null, p_fair: null, p_implied: null };
    const moneylineEdgeResult = (isPredictionHome || isPredictionAway)
      ? edgeCalculator.computeMoneylineEdge({
        projectionWinProbHome: winProbHome,
        americanOdds: moneylineOdds,
        isPredictionHome
      })
      : { edge: null, p_fair: null, p_implied: null };
    const edgeResult = isTotalsCard ? totalEdgeResult : moneylineEdgeResult;
```

#### Path B: In Cross-Market Decision (apps/worker/src/models/cross-market.js, Lines 628-706)
```javascript
  edgeResolver: (side) => {
    if (projectedTotal === null || totalLine === null) return null;
    const totalEdge = edgeCalculator.computeTotalEdge({
      projectionTotal: projectedTotal,
      totalLine,
      totalPriceOver: toNumber(oddsSnapshot?.total_price_over),
      totalPriceUnder: toNumber(oddsSnapshot?.total_price_under),
      sigmaTotal: edgeCalculator.getSigmaDefaults('NBA')?.total ?? 14,
      isPredictionOver: side === 'OVER'
    });
    return totalEdge.edge;
  },
```

### The Issue
- Job file builds _full edge result_ (`{ edge, p_fair, p_implied }`)
- Cross-market only returns _edge_ value
- If edge calculation changes, must update **both places**
- Job file also computes `marketPayload` from cross-market decisions, but then recomputes edge independently

### Risk Assessment
- **Two independent calculations** of same value
- **Maintenance burden** if edge logic needs to change
- **Potential for divergence** if one path is updated and the other isn't

### Consolidation Target
Decide: Should `cross-market.js` return full `{ edge, p_fair, p_implied }` object, or should job files use the cross-market edge result instead of recomputing?

---

## Duplication Hotspot #3: Market Decision Logic by Sport (MEDIUM RISK)

### Problem
Market decision formulas (drivers, weights, thresholds) exist **only in worker**, not in shared package.

#### NBA Market Decisions: apps/worker/src/models/cross-market.js (Lines 541-732)
```javascript
function computeNBAMarketDecisions(oddsSnapshot) {
  const raw = parseRawData(oddsSnapshot?.raw_data);
  const totalLine = toNumber(oddsSnapshot?.total);
  const spreadHome = toNumber(oddsSnapshot?.spread_home);

  const avgPtsHome = toNumber(raw?.espn_metrics?.home?.metrics?.avgPtsHome ?? raw?.espn_metrics?.home?.metrics?.avgPoints ?? null);
  const avgPtsAway = toNumber(raw?.espn_metrics?.away?.metrics?.avgPtsAway ?? raw?.espn_metrics?.away?.metrics?.avgPoints ?? null);
  const avgPtsAllowedHome = toNumber(raw?.espn_metrics?.home?.metrics?.avgPtsAllowedHome ?? raw?.espn_metrics?.home?.metrics?.avgPointsAllowed ?? null);
  const avgPtsAllowedAway = toNumber(raw?.espn_metrics?.away?.metrics?.avgPtsAllowedAway ?? raw?.espn_metrics?.away?.metrics?.avgPointsAllowed ?? null);
  
  // ... continues with sport-specific driver definitions ...
  
  const totalDrivers = [
    buildDriver({
      driverKey: 'totalProjection',
      weight: 0.45,  // ← NBA-SPECIFIC THRESHOLD
      eligible: projectedTotal !== null && totalLine !== null,
      signal: projectedTotal !== null && totalLine !== null
        ? clamp((projectedTotal - totalLine) / 10, -1, 1)
        : 0,
      status: statusFromNumbers([projectedTotal, totalLine]),
      note: 'Projected total vs. line — positive favors OVER.'
    }),
    // ... more drivers ...
  ];
```

#### NHL Market Decisions: apps/worker/src/models/cross-market.js (Lines 186-540)
```javascript
function computeNHLMarketDecisions(oddsSnapshot) {
  const raw = parseRawData(oddsSnapshot?.raw_data);
  const totalLine = toNumber(oddsSnapshot?.total);
  const spreadHome = toNumber(oddsSnapshot?.spread_home);

  const goalsForHome = toNumber(raw?.espn_metrics?.home?.metrics?.avgGoalsFor ?? raw?.goals_for_home ?? null);
  const goalsForAway = toNumber(raw?.espn_metrics?.away?.metrics?.avgGoalsFor ?? raw?.goals_for_away ?? null);
  
  // ... sport-specific metrics ...
  
  const spreadDrivers = [
    buildDriver({
      driverKey: 'powerRating',
      weight: 0.35,  // ← DIFFERENT: NBA uses 0.40, NHL uses 0.35
      eligible: projectedMargin !== null,
      signal: powerRatingSignal,
      status: statusFromNumbers([projectedMargin]),
      note: 'Projected margin favors HOME when positive.'
    }),
    // ... more drivers ...
  ];
```

### Risk Assessment
- **Market logic embedded in worker** → shared package has only primitives
- **Thresholds differ by sport unsystematically**
  - NBA total driver: `weight: 0.45`
  - NHL power rating: `weight: 0.35` (not 0.40)
- **No centralized registry** for what constitutes a "FIRE" vs "WATCH" decision
- **If thresholds change**, they're scattered across the function rather than in a config

### Consolidation Target
Create `apps/worker/src/models/market-config.js` with sport-specific driver weights, decision thresholds (t_fire, t_watch, conflict_cap), and penalty values. Import and use from there.

---

## Duplication Hotspot #4: Card Generation Pattern Repetition (MEDIUM RISK)

### Problem
Card payload assembly follows identical structure across jobs but replicates validation/transformation logic.

#### NBA Card Generation: apps/worker/src/jobs/run_nba_model.js (Lines 195-330, ~135 lines)
```javascript
function generateNBACards(gameId, driverDescriptors, oddsSnapshot, marketPayload) {
  const marketData = marketPayload || {};
  const now = new Date().toISOString();
  let expiresAt = null;
  if (oddsSnapshot?.game_time_utc) {
    const gameTime = new Date(oddsSnapshot.game_time_utc);
    expiresAt = new Date(gameTime.getTime() - 60 * 60 * 1000).toISOString();
  }

  return driverDescriptors.map(descriptor => {
    const cardId = `card-nba-${descriptor.driverKey}-${gameId}-${uuidV4().slice(0, 8)}`;
    const recommendation = buildRecommendationFromPrediction({
      prediction: descriptor.prediction,
      recommendedBetType: 'moneyline'
    });
    const matchup = buildMatchup(oddsSnapshot?.home_team, oddsSnapshot?.away_team);
    const { start_time_local: startTimeLocal, timezone } = formatStartTimeLocal(oddsSnapshot?.game_time_utc);
    const countdown = formatCountdown(oddsSnapshot?.game_time_utc);
    const market = buildMarketFromOdds(oddsSnapshot);
    
    // ... 100+ more lines of identical payload assembly ...
```

#### NHL Card Generation: apps/worker/src/jobs/run_nhl_model.js (Lines 213-350, ~137 lines)
```javascript
function generateNHLCards(gameId, driverDescriptors, oddsSnapshot, marketPayload) {
  const marketData = marketPayload || {};
  const now = new Date().toISOString();
  let expiresAt = null;
  if (oddsSnapshot?.game_time_utc) {
    const gameTime = new Date(oddsSnapshot.game_time_utc);
    expiresAt = new Date(gameTime.getTime() - 60 * 60 * 1000).toISOString();
  }

  return driverDescriptors.map(descriptor => {
    const cardId = `card-nhl-${descriptor.driverKey}-${gameId}-${uuidV4().slice(0, 8)}`;
    // ... IDENTICAL pattern from here forward ...
```

### Risk Assessment
- **Same assembly logic**, three times (NBA, NHL, NCAAM)
- **~120-135 lines per file** could be consolidation target
- **Changes to card schema** require updates in multiple places
- **Sport prefix embedded** (card-nba, card-nhl) → parameterizable

### Consolidation Target
Create generic card factory in `packages/models/src/` or `apps/worker/src/models/` that handles sport-agnostic payload assembly. Pass sport and driver info as parameters.

---

## Duplication Hotspot #5: FPL Dual Engines (CRITICAL RISK)

### Problem
FPL has **two completely separate prediction stacks** that may diverge.

#### Worker Mock Path: apps/worker/src/models/index.js (Lines 1028-1031)
```javascript
  // Remaining sports (NFL, MLB, FPL) — keep mock constant fallback.
  // Note: For FPL this is a shared-contract compatibility signal only;
  // the domain strategy engine is FPL Sage.
  const confidence = mockConfig.confidence;
  const predictHome = homeOdds < awayOdds;

  return {
    prediction: predictHome ? 'HOME' : 'AWAY',
    confidence,
    ev_threshold_passed: confidence > 0.55, // Conservative threshold
    reasoning: `Model prefers ${predictHome ? 'HOME' : 'AWAY'} team at ${confidence.toFixed(2)} confidence`,
    inference_source: 'mock',
    model_endpoint: null,
    is_mock: true
  };
```

#### Python FPL Sage Stack: cheddar-fpl-sage/src/cheddar_fpl_sage/analysis/decision_framework/
- Complete transfer recommendation engine (500+ lines in transfer_advisor.py)
- Captain selector, chip analyzer, injury/suspension processing
- **No integration with worker mock path**
- **Used by FPL Sage CLI** (`fpl_sage.py`), not by worker model jobs

### The Disconnect
- Worker path: Odds-based fallback (confidence thresholded at 0.55)
- FPL Sage: Game-state-based analysis (transfers, captaincy, chip usage)
- **No unified contract** for which engine outputs which decision type

### Risk Assessment
- **TWO INDEPENDENT SYSTEMS** compute FPL signals
- Worker writes **betting cards** with **mock logic**
- Sage computes **transfer strategy** with **game knowledge**
- If both are active: **Unclear which is authoritative**
- **Potential for contradictory recommendations** (mock prefers Home, Sage prefers Away for same game)

### Consolidation Target
**CRITICAL:** Define FPL data contract:
- Does worker path generate FPL betting cards? (Using odds-based mock logic?)
- Does Sage Path replace worker entirely, or complement it?
- Should they be merged into single FPL decision engine?
- Document the integration boundary clearly.

---

## Summary Table: Consolidation Priority

| Hotspot | Type | Severity | Consolidation Target | Estimated Impact |
|---------|------|----------|----------------------|-----------------|
| Win Prob + Driver Summary | Helper duplication | HIGH | `packages/models/src/card-utilities.js` | 3 functions → 1 shared |
| Edge computation split | Logic redundancy | MEDIUM-HIGH | Consolidate to one authoritative path | 2 implementations → 1 |
| Market decision config | Scattered thresholds | MEDIUM | `apps/worker/src/models/market-config.js` | Centralize all weights/thresholds |
| Card payload generation | Structure repetition | MEDIUM | New `generateCard()` factory | 4 functions → 1 template |
| FPL dual engines | Separate systems | CRITICAL | Define integration contract | Clarify which engine is authoritative |

---

## Recommended Action Sequence

### Step 1: Extract Shared Helpers (HIGH PRIORITY)
- Create `packages/models/src/card-utilities.js`
- Move `computeWinProbHome(projectedMargin, sport, sigmaSetting?)` with parameterized sigma
- Move `buildDriverSummary(descriptor, weightMap)`
- Update imports in all three job files to use shared version
- **Test:** Verify identical outputs for NBA/NHL; confirm NCAAM still uses sigma=11

### Step 2: Consolidate Edge Logic (MEDIUM-HIGH PRIORITY)
- Decide: Does job file own edge computation or uses cross-market result?
- If job owns: Ensure cross-market provides full `{ edge, p_fair, p_implied }` object
- If cross-market owns: Job calls to retrieve edge, never recomputes
- **Test:** Compare post-consolidation edge values against baseline

### Step 3: Extract Market Decision Config (MEDIUM PRIORITY)
- Create `apps/worker/src/models/market-config.js` with sport-specific settings:
  ```javascript
  const MARKET_CONFIG = {
    NBA: {
      totalProjectionWeight: 0.45,
      powerRatingWeight: 0.40,
      fireThreshold: 0.70,
      watchThreshold: 0.55,
      conflictCap: 0.15
    },
    NHL: {
      totalProjectionWeight: 0.40,
      powerRatingWeight: 0.35,
      fireThreshold: 0.70,
      watchThreshold: 0.55,
      conflictCap: 0.15
    },
    NCAAM: { /* similar */ }
  };
  ```
- Import and use in `cross-market.js` instead of hardcoded values

### Step 4: Unify Card Generation (MEDIUM PRIORITY)
- Create `packages/models/src/card-factory.js` with:
  ```javascript
  function generateCard(sport, gameId, descriptor, oddsSnapshot, marketPayload) {
    // Sport-agnostic assembly logic
    const cardId = `card-${sport.toLowerCase()}-${descriptor.driverKey}-${gameId}-...`;
    // ... common payload transformation ...
    return card;
  }
  ```
- Replace `generateNBACards`, `generateNHLCards`, `generateNCAAMCards` with calls to factory

### Step 5: Document FPL Contract (CRITICAL PRIORITY)
- Decide: Is worker mock path live for card writes, or deprecated?
- If live: Integrate with Python FPL Sage or replace with it
- If deprecated: Mark clearly, add deprecation warning, document transition plan
- **Test:** Verify no divergent FPL decisions reaching UI

---

## Testing Strategy

After each consolidation step:
1. Run QuickStart commands for all three sports
2. Compare card outputs before/after consolidation
3. Verify no edge values changed (or document intentional changes)
4. Confirm NCAAM still produces correct sigma-11 win probabilities
5. Check database for new cards and validate schema compliance

---

## Risk Mitigation

While consolidating:
- **Keep original functions in place** until all tests pass
- **Use feature flags** to toggle between old and new implementations
- **Run parallel predictions** (old vs. new) for a testing period
- **Document all threshold changes** (weights, decision points) in commit messages
- **Add comments** linking consolidated functions back to original locations for audit

