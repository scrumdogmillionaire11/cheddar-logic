# Cheddar Board — Non-Breaking Rollout Integration Guide

## Files produced

| File | Purpose |
|------|---------|
| `flags.js` | 4 feature flags, all default false |
| `decision-basis.types.js` | Contract types + `buildDecisionBasisMeta()` |
| `decision-pipeline-v2.patch.js` | Sport+market thresholds + basis block builder |
| `run_nhl_player_shots_model.PATCH.js` | NHL shots model diff instructions |
| `run_soccer_model.PATCH.js` | Soccer model diff instructions |
| `db-telemetry.js` | Two additive tables + CRUD functions |

---

## Step 0 — Copy files into your project

```bash
# Suggested locations (adjust to your monorepo structure)
cp flags.js                            packages/models/src/flags.js
cp decision-basis.types.js             packages/models/src/decision-basis.types.js
cp decision-pipeline-v2.patch.js       packages/models/src/decision-pipeline-v2.patch.js
cp run_nhl_player_shots_model.PATCH.js apps/worker/src/utils/nhl-shots-patch.js
cp run_soccer_model.PATCH.js           apps/worker/src/utils/soccer-patch.js
cp db-telemetry.js                     packages/data/src/db-telemetry.js
```

---

## Step 1 — Apply decision-pipeline-v2.js changes

Open `packages/models/src/decision-pipeline-v2.js`.

### 1a. Add imports at the top (after existing requires)

```js
const { FLAGS } = require('./flags');
const { buildDecisionBasisBlock, getSupportThresholdsV2 } = require('./decision-pipeline-v2.patch');
```

### 1b. Replace getSupportThresholds calls

Find the 3 places `getSupportThresholds(marketType)` is called.
Replace each with `getSupportThresholdsV2(market_type, sport)`.

The `sport` variable is already in scope in `buildDecisionV2` —
it's computed as `normalizeSport(payload?.sport)` near the top.
Pass it through to the helper calls.

### 1c. Add decision_basis_meta to the return object

Find the final `return { ... }` in the `try` block of `buildDecisionV2`.
Add these 2 lines just before it:

```js
const decision_basis_meta = buildDecisionBasisBlock(payload, market_type, edge_pct);
```

And add to the return object (spread at the end):

```js
...(decision_basis_meta ? { decision_basis_meta } : {}),
```

**Verification:** Run existing tests with all flags off.
`ENABLE_DECISION_BASIS_TAGS=false ENABLE_MARKET_THRESHOLDS_V2=false npm test`
All tests should pass with zero behavior change.

---

## Step 2 — Apply run_nhl_player_shots_model.js changes

Open `apps/worker/src/jobs/run_nhl_player_shots_model.js`.

### 2a. Add import near the top

```js
const { buildNhlShotsBasisMeta } = require('../utils/nhl-shots-patch');
```

### 2b. Patch full-game decision block

Find:
```js
decision: {
  edge_pct: Math.round(((mu - syntheticLine) / syntheticLine) * 100 * 10) / 10,
  model_projection: mu,
  market_line: syntheticLine,
  direction: fullGameEdge.direction,
  confidence: confidence,
  market_line_source: usingRealLine ? 'odds_api' : 'projection_floor',
},
```

Replace with:
```js
decision: {
  edge_pct: Math.round(((mu - syntheticLine) / syntheticLine) * 100 * 10) / 10,
  model_projection: mu,
  market_line: syntheticLine,
  direction: fullGameEdge.direction,
  confidence: confidence,
  market_line_source: usingRealLine ? 'odds_api' : 'projection_floor',
  ...buildNhlShotsBasisMeta(usingRealLine, mu, syntheticLine, 'shots_on_goal'),
},
```

### 2c. Patch 1P decision block (same pattern)

```js
decision: {
  ...existing fields...,
  market_line_source: realPropLine1p ? 'odds_api' : 'projection_floor',
  ...buildNhlShotsBasisMeta(!!realPropLine1p, mu1p, syntheticLine1p, 'shots_on_goal_1p'),
},
```

### 2d. Add telemetry call after insertCardPayload (full-game card)

```js
// After: insertCardPayload(card);
const { recordProjectionEntry } = require('@cheddar-logic/data');
if (!usingRealLine) {
  recordProjectionEntry({
    id: `proj-${card.id}`,
    cardId: card.id,
    gameId: resolvedGameId,
    sport: 'NHL',
    propType: 'shots_on_goal',
    playerName: playerName,
    pickSide: fullGameEdge.direction,
    projection: mu,
    propLine: syntheticLine,
    confidence: 'MEDIUM',
    volatilityBand: 'LOW',
    decisionBasis: 'PROJECTION_ONLY',
  });
}
```

---

## Step 3 — Apply run_soccer_model.js changes

Open `apps/worker/src/jobs/run_soccer_model.js`.

### 3a. Add imports

```js
const { buildSoccerBasisMeta } = require('../utils/soccer-patch');
const { recordProjectionEntry } = require('@cheddar-logic/data');
```

### 3b. Track 1 — attach basis meta in buildSoccerOddsBackedCard

Before the `return { ... }` statement, add:

```js
const basisMeta = buildSoccerBasisMeta({
  track: 'track1',
  canonicalMarket: canonicalCardType,
  payloadData,
});
if (basisMeta.decision_basis_meta) {
  payloadData.decision_basis_meta = basisMeta.decision_basis_meta;
}
```

### 3c. Track 2 — attach basis meta after projection_only flag

Find:
```js
tier1Result.payloadData.projection_only = true;
```

Add immediately after:
```js
const track2BasisMeta = buildSoccerBasisMeta({
  track: 'track2',
  canonicalMarket: market,
  payloadData: tier1Result.payloadData,
});
if (track2BasisMeta.decision_basis_meta) {
  tier1Result.payloadData.decision_basis_meta = track2BasisMeta.decision_basis_meta;
}
```

### 3d. Track 2 — add projection telemetry after insertCardPayload

```js
// After: insertCardPayload(card);
recordProjectionEntry({
  id: `proj-${card.id}`,
  cardId: card.id,
  gameId,
  sport: 'SOCCER',
  propType: market,
  pickSide: tier1Result.payloadData.selection?.side?.toUpperCase() || 'OVER',
  projection: tier1Result.payloadData.edge_ev ?? 0,
  propLine: null,
  confidence: 'LOW',
  volatilityBand: market === 'player_shots' ? 'LOW' : 'MEDIUM',
  decisionBasis: 'PROJECTION_ONLY',
});
```

---

## Step 4 — Wire db-telemetry.js into db.js

Add at the bottom of `packages/data/src/db.js`, before `module.exports`:

```js
const {
  recordClvEntry,
  settleClvEntry,
  recordProjectionEntry,
  settleProjectionEntry,
  getProjectionWinRates,
} = require('./db-telemetry');
```

Add to `module.exports`:
```js
recordClvEntry,
settleClvEntry,
recordProjectionEntry,
settleProjectionEntry,
getProjectionWinRates,
```

---

## Step 5 — Rollout sequence

```bash
# Phase 1: NHL props + soccer (lowest risk — projection models you already have)
ENABLE_DECISION_BASIS_TAGS=true \
ENABLE_PROJECTION_PERF_LEDGER=true \
npm --prefix apps/worker run scheduler

# Verify:
#   - NHL shots cards: decision.decision_basis present in payloadData
#   - Soccer Track 2 cards: execution_eligible=false
#   - projection_perf_ledger table created and receiving rows
#   - All existing tests pass
#   - /api/games returns same shape (new fields are optional additions)

# Phase 2: Enable sport+market thresholds
ENABLE_MARKET_THRESHOLDS_V2=true npm --prefix apps/worker run scheduler

# Phase 3: CLV ledger (after confirming odds-backed plays are working cleanly)
ENABLE_CLV_LEDGER=true npm --prefix apps/worker run scheduler
```

---

## Regression test checklist

- [ ] `ENABLE_DECISION_BASIS_TAGS=false` → no new fields in any payload
- [ ] `ENABLE_MARKET_THRESHOLDS_V2=false` → `official_status` identical to baseline
- [ ] NHL shots card with real line → `execution_eligible: true`, `decision_basis: ODDS_BACKED`
- [ ] NHL shots card with synthetic line → `execution_eligible: false`, `decision_basis: PROJECTION_ONLY`
- [ ] Soccer Track 2 card → `execution_eligible: false`, `projection_only: true`
- [ ] Soccer Track 1 ML card → `execution_eligible: true`, `decision_basis: ODDS_BACKED`
- [ ] `/api/games` response: no breaking changes, all existing fields present
- [ ] `card_results` table: unmodified, settlement flow unchanged
- [ ] `card_display_log` table: unmodified
- [ ] `projection_perf_ledger` rowcount increases after worker run with flag on
- [ ] `getProjectionWinRates()` returns correct win rate after settling 10+ plays
