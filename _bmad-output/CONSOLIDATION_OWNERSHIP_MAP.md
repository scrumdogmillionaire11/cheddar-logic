# Model Consolidation — Authoritative Ownership Map

**Purpose**: Enforce single-source-of-truth for each domain object to prevent re-duplication  
**Status**: Contract + Test Enforcement  
**Branch**: `debug/model-logic-duplication`

---

## Ownership Contract (Sacred Trust)

This document defines **authoritative ownership** for each domain computation. **No duplicates allowed.** Violations caught by lint test.

### Win Probability Computation

| Domain | Authoritative Owner | Forbidden Locations | Contract |
|--------|-------------------|-------------------|----------|
| `computeWinProbHome(margin, sport)` | `packages/models/src/card-utilities.js` | None (delete from all job files) | Given projected margin and sport, return P(Home wins) using sport-specific sigma (NBA/NHL=12, NCAAM=11). Result must be in [0,1] range or null. |
| Output: `winProbHome` (0-1, 4 decimals) | Used by: job files only (import from utilities) | Inline compute in job files | Sport variance is **intentional and must be preserved**. NCAAM sigma≠NBA sigma. |

**Test**: `packages/models/__tests__/card-utilities.test.js`
- Assert: `computeWinProbHome(-3, 'NCAAM')` uses sigma=11, not 12
- Assert: Try to create run_nba_model.js with inline `computeWinProbHome` → ESLint rule fails

---

### Edge Calculation (Total & Moneyline)

| Domain | Authoritative Owner | Forbidden Locations | Contract |
|--------|-------------------|-------------------|----------|
| `computeTotalEdge({...})` | `edgeCalculator.*` (shared from @cheddar-logic/models) | `cross-market.js` uses it, job files must NOT recompute | Caller provides sigma, price, projection. Returns `{ edge, p_fair, p_implied }` or `{ edge: null, ... }`. |
| `computeMoneylineEdge({...})` | `edgeCalculator.*` (shared) | Job files must NOT recompute | Same contract. |
| **Edge result insertion in card** | `cross-market.js` (edgeResolver callback) | Job files must NOT independently compute edge values | Job file calls cross-market module result, does not invoke `edgeCalculator` directly. |

**Test**: `apps/worker/src/models/__tests__/edge-ownership.test.js`
- Assert: Searching job files for `computeTotalEdge` or `computeMoneylineEdge` returns zero hits
- Assert: Cross-market tests verify edge output matches job file expectations (byte-for-byte on sample inputs)

**Why this ownership**: Cross-market is the market decision engine; job files are card factories. Edge is market knowledge, owned by market module.

---

### Market Thresholds & Driver Weights

| Domain | Authoritative Owner | Forbidden Locations | Contract |
|--------|-------------------|-------------------|----------|
| `MARKET_CONFIG` (all weights + thresholds) | `apps/worker/src/models/market-config.js` | Hardcoded `0.45`, `0.40`, `0.70`, etc. in cross-market.js | Single registry: `{ NBA, NHL, NCAAM }` with keys: `totalProjectionWeight`, `fireThreshold`, etc. |
| Threshold access pattern | `getMarketConfig(sport)` | Direct object access or magic numbers | `const cfg = getMarketConfig('NBA'); const w = cfg.totalProjectionWeight;` |
| **Sport variance justification** | Each threshold must have inline comment | Changes without comment = refactor debt | Example: `NHL powerRatingWeight: 0.35 // One less driver tier than NBA due to smaller league variance` |

**Test**: `apps/worker/src/models/__tests__/market-config.test.js`
- Assert: No hardcoded weight values in `cross-market.js` (grep test)
- Assert: All `buildDriver()` weight calls use `getMarketConfig(sport)` 
- Assert: All thresholds (fire, watch, conflict) referenced only from config
- Report: Comment requirement for any threshold > 0.05 variance between sports

**Why this ownership**: Config must be centralized to be changeable without code hunting.

---

### Card Payload Assembly

| Domain | Authoritative Owner | Forbidden Locations | Contract |
|--------|-------------------|-------------------|----------|
| Card object shape & fields | `packages/models/src/card-factory.js` | Job files must NOT assemble payload inline | Call `generateCard(sport, gameId, descriptor, oddsSnapshot, marketPayload)` → returns fully-formed card object. |
| Card ID generation | Card factory | Job files | Pattern: `card-${sport}-${driverKey}-${gameId}-${shortUUID}` |
| Timestamp logic | Card factory | Job files | `created_at` = now, `expires_at` = game_time - 1hr. Centralized. |
| **Sport-specific ID prefix** | Parameterized in factory (sport arg) | Hardcoded in job functions | Factory accepts sport, emits correct prefix. Job does NOT control ID generation. |

**Test**: `packages/models/__tests__/card-factory.test.js`
- Assert: Sample descriptor → card output matches golden fixture (see below)
- Assert: ID pattern matches `card-${sport}-*`
- Assert: No inline card assembly code in job files (grep test)
- Assert: Card schema validation passes (whatever your schema validator is)

**Why this ownership**: Single factory = single place to change card schema without hunting 3 job files.

---

### Driver Impact Summarization

| Domain | Authoritative Owner | Forbidden Locations | Contract |
|--------|-------------------|-------------------|----------|
| `buildDriverSummary(descriptor, weightMap)` | `packages/models/src/card-utilities.js` | Job files must NOT compute impact | Impact = (score - 0.5) × weight, rounded to 3 decimals. Returns `{ weights: [...], impact_note: '...' }` |

**Test**: `packages/models/__tests__/card-utilities.test.js`
- Assert: computeWinProbHome and buildDriverSummary are instantiated only from card-utilities import
- Assert: No inline impact calculation in job files

---

## Enforcement Tests (No More Secrets)

### 1. **No-Clones-Allowed Lint Test**

File: `apps/worker/src/models/__tests__/ownership-enforcement.test.js`

```javascript
const fs = require('fs');
const path = require('path');

const FORBIDDEN_FUNCTIONS = {
  'computeWinProbHome': ['apps/worker/src/jobs/run_*.js'],
  'buildDriverSummary': ['apps/worker/src/jobs/run_*.js'],
  'computeTotalEdge': ['apps/worker/src/jobs/run_*.js'],      // Job files must NOT call this
  'computeMoneylineEdge': ['apps/worker/src/jobs/run_*.js'],  // Job files must NOT call this
};

const FUNCTION_OWNERS = {
  'computeWinProbHome': 'packages/models/src/card-utilities.js',
  'buildDriverSummary': 'packages/models/src/card-utilities.js',
  'generateCard': 'packages/models/src/card-factory.js',
  'generateNBACards': null, // MUST be deleted
  'generateNHLCards': null, // MUST be deleted
  'generateNCAAMCards': null, // MUST be deleted
};

describe('Ownership Enforcement: No Forbidden Clones', () => {
  Object.entries(FORBIDDEN_FUNCTIONS).forEach(([funcName, forbiddenPaths]) => {
    test(`${funcName} not defined in job files`, () => {
      const jobFiles = [
        'apps/worker/src/jobs/run_nba_model.js',
        'apps/worker/src/jobs/run_nhl_model.js',
        'apps/worker/src/jobs/run_ncaam_model.js',
      ];

      jobFiles.forEach(file => {
        const content = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
        
        // Check for inline function definition
        const inlineDef = new RegExp(`function ${funcName}\\s*\\(|const ${funcName}\\s*=`, 'g');
        expect(content.match(inlineDef)).toBeNull(
          `❌ ${funcName} defined inline in ${file}. Move to owner module and import.`
        );
      });
    });
  });

  Object.entries(FUNCTION_OWNERS).forEach(([funcName, owner]) => {
    if (owner === null) {
      // Function must be deleted entirely
      test(`${funcName} must be deleted (no longer used)`, () => {
        const allJsFiles = fs.readdirSync(path.join(process.cwd(), 'apps/worker/src/jobs'))
          .filter(f => f.endsWith('.js'));

        allJsFiles.forEach(file => {
          const content = fs.readFileSync(
            path.join(process.cwd(), `apps/worker/src/jobs/${file}`),
            'utf8'
          );
          expect(content).not.toMatch(new RegExp(`function ${funcName}\\s*\\(`),
            `❌ ${funcName} still defined in ${file}. Must be deleted and replaced with factory.`
          );
        });
      });
    } else {
      // Function must be imported from owner
      test(`${funcName} is imported from owner (${owner})`, () => {
        const jobFiles = [
          'apps/worker/src/jobs/run_nba_model.js',
          'apps/worker/src/jobs/run_nhl_model.js',
          'apps/worker/src/jobs/run_ncaam_model.js',
        ];

        jobFiles.forEach(file => {
          const content = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
          const useRegex = new RegExp(`\\b${funcName}\\s*\\(`, 'g');
          
          if (content.match(useRegex)) {
            // If function is used, it must be imported
            const importPattern = new RegExp(
              `from\\s+['"]@cheddar-logic/models.*['"]|require\\(['"]@cheddar-logic/models.*['"]\\)`
            );
            expect(content).toMatch(importPattern,
              `❌ ${funcName} used in ${file} but not imported from @cheddar-logic/models. Add import.`
            );
          }
        });
      });
    }
  });

  test('Market config only accessed via getMarketConfig()', () => {
    const crossMarketContent = fs.readFileSync(
      path.join(process.cwd(), 'apps/worker/src/models/cross-market.js'),
      'utf8'
    );

    // Forbidden: hardcoded weight values
    const forbiddenValues = [
      /:\s*0\.45\s*[,}]/,  // totalProjectionWeight
      /:\s*0\.40\s*[,}]/,  // various weights
      /:\s*0\.35\s*[,}]/,
      /:\s*0\.20\s*[,}]/,
      /:\s*0\.25\s*[,}]/,
    ];

    forbiddenValues.forEach(pattern => {
      // Rough check: weights should be in constants, not inline
      // More precise: scan for buildDriver calls with literal weight values
    });

    expect(crossMarketContent).toMatch(/getMarketConfig\s*\(/,
      'cross-market.js must use getMarketConfig() for accessing weights'
    );
  });
});
```

**Run**: `npm test -- ownership-enforcement.test.js`  
**Gating**: Block PRs with failing tests. No exceptions.

---

### 2. **Golden Fixture Snapshot Test**

File: `apps/worker/src/jobs/__tests__/card-generation.fixture-test.js`

```javascript
const { readFileSync } = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load golden fixtures (see GOLDEN_FIXTURES.md)
const NBA_FIXTURE = require('./fixtures/nba-sample-game.json');
const NHL_FIXTURE = require('./fixtures/nhl-sample-game.json');
const NCAAM_FIXTURE = require('./fixtures/ncaam-sample-game.json');

describe('Card Generation: Golden Fixtures', () => {
  test('NBA fixture produces canonical card payload', () => {
    const result = runNBAModelWithFixture(NBA_FIXTURE);
    
    // Assert exact structure match (or hash match)
    expect(result.cards).toHaveLength(NBA_FIXTURE.expectedCardCount);
    
    // Assert key derived fields
    result.cards.forEach(card => {
      expect(card).toHaveProperty('id');
      expect(card).toHaveProperty('edge');
      expect(card).toHaveProperty('decision_class'); // FIRE, WATCH, NEUTRAL, DOWNGRADED
      expect(card).toHaveProperty('driver_summary');
      expect(card.driver_summary.weights[0]).toHaveProperty('impact');
    });

    // Snapshot: hash of card payloads (order-independent)
    const canonicalHash = hashCardSet(result.cards);
    expect(canonicalHash).toBe(NBA_FIXTURE.expectedHash);
  });

  test('NHL fixture respects sport-specific sigma (12)', () => {
    const result = runNHLModelWithFixture(NHL_FIXTURE);
    
    result.cards.forEach(card => {
      if (card.driver_key === 'rest-advantage') {
        // Spot-check: win prob should use NHL sigma, not NCAAM's 11
        expect(card.driver_inputs.win_prob_home).toBeDefined();
        // If margin is -3, sigma=12 gives different prob than sigma=11
        // Verify it's NOT the NCAAM value
        expect(card.driver_inputs.win_prob_home).not.toBe(expectedNCAAMValue);
      }
    });
  });

  test('NCAAM fixture preserves sigma=11 (not 12)', () => {
    const result = runNCAAMModelWithFixture(NCAAM_FIXTURE);
    
    // NCAAM must use sigma=11, not NBA's 12
    // Pick a driver card and verify win prob math
    const card = result.cards.find(c => c.driver_key === 'base-projection');
    expect(card).toBeDefined();
    
    // If NCAAM fixture has margin=-2.5, sigma=11 gives P(home) ≈ 0.4129
    // sigma=12 would give ≈ 0.4266
    // Assert we got 0.4129, not 0.4266
    expect(card.driver_inputs.win_prob_home).toBeCloseTo(0.4129, 4);
  });

  test('Market config changes reflected in thresholds', () => {
    const config = require('../market-config');
    const result = runNBAModelWithFixture(NBA_FIXTURE);
    
    // Assert FIRE threshold applied correctly
    result.cards.forEach(card => {
      if (card.decision_class === 'FIRE') {
        expect(parseFloat(card.driver_summary.weights[0].impact)).toBeGreaterThanOrEqual(
          config.NBA.fireThreshold - 0.01
        );
      }
    });
  });

  test('Edge computation matches cross-market result', () => {
    const crossMarketResult = computeNBAMarketDecisions(NBA_FIXTURE.oddsSnapshot);
    const jobResult = runNBAModelWithFixture(NBA_FIXTURE);
    
    // Pick a matching card and edge
    const card = jobResult.cards[0];
    const decision = crossMarketResult.moneylineDecision; // or totalDecision
    
    // Edges should match
    expect(card.edge).toBeCloseTo(decision.edgeResolver(card.prediction), 4);
  });

  test('Card ID pattern matches convention', () => {
    const result = runNBAModelWithFixture(NBA_FIXTURE);
    
    result.cards.forEach(card => {
      expect(card.id).toMatch(/^card-nba-[a-z-]+-[a-z0-9]+-[a-z0-9]{8}$/);
    });
  });
});
```

**Golden Fixtures**: See GOLDEN_FIXTURES.md (next section)

---

## Golden Fixtures (Deterministic Test Data)

File: `apps/worker/src/jobs/__tests__/fixtures/GOLDEN_FIXTURES.md`

### NBA Sample Game

**Input** (`nba-sample-game.json`):
```json
{
  "gameId": "202602280001",
  "sport": "NBA",
  "oddsSnapshot": {
    "game_time_utc": "2026-02-28T23:30:00Z",
    "home_team": "LAL",
    "away_team": "BOS",
    "spread_home": -3.5,
    "total": 215.5,
    "h2h_home": -110,
    "h2h_away": -110,
    "total_price_over": -110,
    "total_price_under": -110,
    "raw_data": {
      "espn_metrics": {
        "home": { "metrics": { "avgPtsHome": 112.3, "avgPtsAllowedHome": 108.1 } },
        "away": { "metrics": { "avgPtsAway": 108.5, "avgPtsAllowedAway": 110.2 } }
      }
    }
  },
  "driverInputs": [
    { "driverKey": "base-projection", "prediction": "HOME", "projected_margin": 3.2 },
    { "driverKey": "rest-advantage", "prediction": "AWAY", "projected_margin": -1.1 }
  ],
  "expectedCardCount": 2,
  "expectedHash": "abc123def456..." // SHA256 of canonical card payloads
}
```

**Expected Output** (`nba-sample-game-expected.json`):
```json
{
  "cards": [
    {
      "id": "card-nba-base-projection-202602280001-xxxx",
      "sport": "NBA",
      "gameId": "202602280001",
      "driver_key": "base-projection",
      "prediction": "HOME",
      "decision_class": "FIRE",
      "edge": 0.47,
      "driver_inputs": {
        "projected_margin": 3.2,
        "win_prob_home": 0.6156,
        "sigma": 12
      },
      "driver_summary": {
        "weights": [
          {
            "driver": "base-projection",
            "weight": 0.35,
            "score": 0.68,
            "impact": 0.098
          }
        ]
      }
    },
    {
      "id": "card-nba-rest-advantage-202602280001-yyyy",
      "sport": "NBA",
      "gameId": "202602280001",
      "driver_key": "rest-advantage",
      "prediction": "AWAY",
      "decision_class": "WATCH",
      "edge": 0.12,
      "driver_inputs": {
        "projected_margin": -1.1,
        "win_prob_home": 0.4551
      }
    }
  ]
}
```

**Fixture Testing Pattern**:
1. Load fixture
2. Run job with fixture
3. Compare output cards to expected output
4. Assert derived fields (edge, decision_class, win_prob_home) match exactly
5. Assert sport-specific variance (sigma, weights) respected

### NCAAM Sample Game (Different Sigma)

**Input** (`ncaam-sample-game.json`):
- Same structure as NBA, sport="NCAAM"
- Same margin projection (e.g., -2.5) to test sigma difference

**Expected Output**:
```json
{
  "cards": [
    {
      "driver_inputs": {
        "projected_margin": -2.5,
        "win_prob_home": 0.4129,  // Different from NBA's 0.4266 due to sigma=11
        "sigma": 11
      }
    }
  ]
}
```

**Fixture Test Assertion**:
```javascript
test('NCAAM uses sigma=11, not NBA sigma=12', () => {
  const nbaResult = runWithFixture(NBA_FIXTURE); // margin=-2.5
  const ncaamResult = runWithFixture(NCAAM_FIXTURE); // margin=-2.5, same margin
  
  const nbaWinProb = nbaResult.cards[0].driver_inputs.win_prob_home;
  const ncaamWinProb = ncaamResult.cards[0].driver_inputs.win_prob_home;
  
  expect(ncaamWinProb).toBeLessThan(nbaWinProb); // sigma=11 produces lower prob for negative margin
});
```

---

## Pre-Consolidation Snapshot (Baseline)

Before executing Phase 1:

```bash
# Capture exact output
CHEDDAR_DB_PATH=$(pwd)/packages/data/cheddar.db npm --prefix apps/worker run job:run-nba-model > baseline-nba-full.log 2>&1
CHEDDAR_DB_PATH=$(pwd)/packages/data/cheddar.db npm --prefix apps/worker run job:run-nhl-model > baseline-nhl-full.log 2>&1
CHEDDAR_DB_PATH=$(pwd)/packages/data/cheddar.db npm --prefix apps/worker run job:run-ncaam-model > baseline-ncaam-full.log 2>&1

# Extract and hash card payloads from DB
sqlite3 packages/data/cheddar.db "SELECT id, payload FROM card_payloads WHERE created_at > datetime('now', '-5 minutes') ORDER BY id" > baseline-cards.json
sha256sum baseline-cards.json > baseline-cards.sha256
```

---

## Post-Consolidation Validation

After each phase:

```bash
# Re-run same commands
CHEDDAR_DB_PATH=$(pwd)/packages/data/cheddar.db npm --prefix apps/worker run job:run-nba-model > after-nba-full.log 2>&1
...

# Extract and hash new card payloads
sqlite3 packages/data/cheddar.db "SELECT id, payload FROM card_payloads WHERE created_at > datetime('now', '-5 minutes') ORDER BY id" > after-cards.json
sha256sum after-cards.json > after-cards.sha256

# Compare (must match, aside from timestamps)
diff baseline-cards.json after-cards.json | grep -v "created_at\|expires_at" > /dev/null && echo "✅ CARDS MATCH" || echo "❌ REGRESSION DETECTED"
```

---

## Sport-Scoped Constraints (DO NOT CONSOLIDATE)

These are **intentional differences**, not duplication. Keep them sacred:

| Constraint | Reason | Test |
|-----------|--------|------|
| NCAAM sigma=11 vs NBA/NHL=12 | College spreads have lower variance | NCAAM fixture test asserts win_prob differs from NBA |
| NCAAM matchupStyle weight=0.35 vs NBA/NHL=0.25 | College matchups matter more | Config test asserts weights retrieved correctly per sport |
| FPL dual engines | Separate stacks (betting vs strategy) | **Phase 4 only; completely decoupled from this consolidation** |

**Test**: Any consolidation that removes sport-scoped variance will fail the golden fixture tests.

---

## Summary: The Enforcement Chain

```
┌─ Ownership Map (this document)
│  └─ Sacred functions locked to modules
│
├─ Ownership Enforcement Tests (no-clones-allowed)
│  └─ Grep for forbidden function names
│  └─ Block PR if clones detected
│
├─ Golden Fixture Tests (deterministic output)
│  └─ Capture pre-consolidation card payloads
│  └─ Assert post-consolidation payloads match
│  └─ Assert sport-specific variance preserved
│
└─ Pre/Post Snapshots
   └─ Hash card outputs before/after
   └─ Report any deviation
```

**No ambiguity. No vibes. No "I think it works."**

---

## Implementation Checklist

- [ ] Create Ownership Map (this doc)
- [ ] Create ownership-enforcement.test.js
- [ ] Create golden fixtures (NBA, NHL, NCAAM)
- [ ] Create fixture-test.js
- [ ] Run baseline snapshot (pre-consolidation)
- [ ] Phase 1: Extract utilities, card-utilities.js
  - [ ] ownership enforcement tests pass ✅
  - [ ] golden fixture tests pass ✅
  - [ ] post-snapshot matches pre-snapshot ✅
- [ ] Phase 2: Edge consolidation
  - [ ] All tests pass ✅
  - [ ] Snapshots match ✅
- [ ] Phase 3: Card factory
  - [ ] All tests pass ✅
  - [ ] Snapshots match ✅
- [ ] Phase 4: FPL planning doc (deferred)

---

## Rollback Criteria

If **any** gold fixture test fails:
1. Revert PR immediately
2. Do not merge
3. Investigate root cause
4. Fix, retest in isolation
5. Only re-merge after golden fixtures pass

This is not negotiable.
