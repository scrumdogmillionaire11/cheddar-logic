---
phase: quick-2
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/models/index.js
  - apps/worker/src/jobs/run_nhl_model.js
  - packages/data/src/validators/card-payload.js
autonomous: true
requirements: [NHL-DRIVER-CARDS]

must_haves:
  truths:
    - "Running the NHL model for a game produces one card per active NHL driver, not one composite card"
    - "Each driver card has a meaningful cardType (e.g. nhl-goalie, nhl-special-teams) not the generic nhl-model-output"
    - "Each driver card title describes what the driver measured (e.g. 'NHL Goalie Edge: HOME' not 'NHL Model: HOME')"
    - "Each driver card's confidence reflects that driver's strength (0.6-0.85), not a global composite confidence"
    - "Each driver card's prediction is HOME, AWAY, or NEUTRAL based on driver score direction"
    - "Empty Net driver cards are skipped when data is missing (status=missing), not emitted with neutral fallback"
    - "The old nhl-model-output card type is no longer produced"
    - "Card payload validator accepts all new driver card types without error"
  artifacts:
    - path: "apps/worker/src/models/index.js"
      provides: "computeNHLDriverCards() that returns an array of per-driver card descriptors"
      contains: "nhl-goalie"
    - path: "apps/worker/src/jobs/run_nhl_model.js"
      provides: "generateNHLCards() (plural) that maps driver descriptors to insertable card objects"
      contains: "generateNHLCards"
    - path: "packages/data/src/validators/card-payload.js"
      provides: "Validator schema entries for all 5 active NHL driver card types"
      contains: "nhl-goalie"
  key_links:
    - from: "apps/worker/src/jobs/run_nhl_model.js"
      to: "apps/worker/src/models/index.js"
      via: "computeNHLDriverCards(gameId, oddsSnapshot)"
      pattern: "computeNHLDriverCards"
    - from: "apps/worker/src/jobs/run_nhl_model.js"
      to: "packages/data/src/validators/card-payload.js"
      via: "validateCardPayload(card.cardType, card.payloadData)"
      pattern: "validateCardPayload"
---

<objective>
Replace the single monolithic NHL model output card with individual cards per driver. Currently `run_nhl_model.js` produces one card per game with `cardType: 'nhl-model-output'` and `prediction: 'HOME'|'AWAY'` that reflects a composite signal. The drivers (goalie, specialTeams, shotEnvironment, emptyNet, totalFragility, pdoRegression) are buried in `payloadData.drivers` with no surface-level meaning.

Purpose: Each driver is a distinct analytical signal with its own confidence, direction, and rationale. Packaging them as individual cards makes each signal independently readable, filterable by cardType, and displayable on the UI without parsing nested JSON.

Output: 5-6 cards per game (one per active driver), each with a specific cardType, human-readable title, driver-specific confidence, and HOME/AWAY/NEUTRAL direction. Empty Net is skipped when data is missing.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/quick/2-convert-nhl-drivers-into-individual-payl/2-PLAN.md
@apps/worker/src/models/index.js
@apps/worker/src/jobs/run_nhl_model.js
@packages/data/src/validators/card-payload.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add computeNHLDriverCards() to models/index.js</name>
  <files>apps/worker/src/models/index.js</files>
  <action>
Add a new exported function `computeNHLDriverCards(gameId, oddsSnapshot)` directly after the existing `computeNHLDrivers` function. Do NOT remove `computeNHLDrivers` — it is still called internally.

`computeNHLDriverCards` calls `computeNHLDrivers` to get the existing drivers object, then maps each driver to a card descriptor object. Return an array of these descriptors (skip any driver where status === 'missing').

Driver-to-card mapping rules:

```
goalie:
  cardType: 'nhl-goalie'
  cardTitle: 'NHL Goalie Edge: {direction}'
  confidence: clamp(0.65 + Math.abs(score - 0.5) * 0.4, 0.65, 0.85)
  direction: score > 0.52 ? 'HOME' : score < 0.48 ? 'AWAY' : 'NEUTRAL'
  reasoning: 'GSaX goalie tier delta favors {direction} (delta: {inputs.delta?.toFixed(2) ?? "n/a"})'

specialTeams:
  cardType: 'nhl-special-teams'
  cardTitle: 'NHL Special Teams Mismatch: {direction}'
  confidence: clamp(0.60 + Math.abs(score - 0.5) * 0.2, 0.60, 0.70)
  direction: score > 0.52 ? 'HOME' : score < 0.48 ? 'AWAY' : 'NEUTRAL'
  reasoning: 'PP/PK composite mismatch favors {direction} ({inputs.delta?.toFixed(1) ?? "n/a"} pct-pt edge)'

shotEnvironment:
  cardType: 'nhl-shot-environment'
  cardTitle: 'NHL Shot Environment: {direction}'
  confidence: 0.65
  direction: score > 0.52 ? 'HOME' : score < 0.48 ? 'AWAY' : 'NEUTRAL'
  reasoning: 'xGF% 5v5 shot quality profile favors {direction} (delta: {inputs.delta?.toFixed(1) ?? "n/a"} pct)'

emptyNet:
  cardType: 'nhl-empty-net'
  cardTitle: 'NHL Empty Net Tendencies: {direction}'
  confidence: 0.60
  direction: score > 0.52 ? 'HOME' : score < 0.48 ? 'AWAY' : 'NEUTRAL'
  reasoning: 'Coach goalie-pull timing edge favors {direction}'
  SKIP if status === 'missing' (return null, filter from array)

totalFragility:
  cardType: 'nhl-total-fragility'
  cardTitle: 'NHL Total Fragility'
  confidence: 0.60
  direction: 'NEUTRAL'
  reasoning: 'Total near key number {inputs.total} (distance: {inputs.nearest_key_number_distance?.toFixed(2) ?? "n/a"} from 5.5/6.5/7.5)'

pdoRegression:
  cardType: 'nhl-pdo-regression'
  cardTitle: 'NHL PDO Regression Signal: {direction}'
  confidence: clamp(0.70 + Math.abs(score - 0.5) * 0.3, 0.70, 0.85)
  direction: score > 0.52 ? 'HOME' : score < 0.48 ? 'AWAY' : 'NEUTRAL'
  reasoning: 'PDO imbalance (delta: {inputs.delta?.toFixed(3) ?? "n/a"}) suggests regression toward {direction}'
```

Each descriptor object shape:
```js
{
  cardType: string,
  cardTitle: string,
  confidence: number,          // driver-specific, 0.60-0.85
  prediction: string,          // same as direction: 'HOME'|'AWAY'|'NEUTRAL'
  reasoning: string,
  ev_threshold_passed: boolean, // confidence > 0.60
  driverKey: string,           // e.g. 'goalie', 'specialTeams'
  driverInputs: object,        // driver.inputs verbatim
  driverScore: number,         // driver.score
  driverStatus: string,        // driver.status
  inference_source: 'driver',
  is_mock: true
}
```

Export `computeNHLDriverCards` in `module.exports` alongside existing exports.

Update the NHL branch in `getInference` to call `computeNHLDriverCards` instead of `computeNHLDrivers` directly:
```js
if (sport === 'NHL') {
  // Keep computeNHLDrivers for internal score computation.
  // getInference still returns a single composite result for backward compat
  // with any non-card callers. The card generation path uses computeNHLDriverCards.
  const nhl = computeNHLDrivers(gameId, oddsSnapshot);
  return {
    ...nhl,
    inference_source: 'mock',
    model_endpoint: null,
    is_mock: true
  };
}
```
The `getInference` composite path is NOT changed — `computeNHLDriverCards` is called directly from `run_nhl_model.js` in Task 2.
  </action>
  <verify>
Run from repo root:
```bash
node -e "
const { computeNHLDriverCards } = require('./apps/worker/src/models/index.js');
const cards = computeNHLDriverCards('test-game-1', {
  total: 5.7,
  raw_data: JSON.stringify({
    goalie_home_gsax: 1.2, goalie_away_gsax: -0.4,
    pp_home_pct: 22, pk_home_pct: 82, pp_away_pct: 18, pk_away_pct: 79,
    xgf_home_pct: 56, xgf_away_pct: 44,
    pdo_home: 1.005, pdo_away: 0.988
  })
});
console.log('Card count:', cards.length);
cards.forEach(c => console.log(c.cardType, c.prediction, c.confidence.toFixed(2)));
"
```
Expected: 5 cards (emptyNet skipped — no data), each with distinct cardType, valid direction, confidence in 0.60-0.85 range.
  </verify>
  <done>
`computeNHLDriverCards` is exported from models/index.js, returns an array of driver card descriptors, emptyNet is absent when inputs are missing, all other 5 drivers present with correct cardType strings and confidence values in range.
  </done>
</task>

<task type="auto">
  <name>Task 2: Rewrite generateNHLCards in run_nhl_model.js + register card types in validator</name>
  <files>
    apps/worker/src/jobs/run_nhl_model.js
    packages/data/src/validators/card-payload.js
  </files>
  <action>
**In `run_nhl_model.js`:**

1. Import `computeNHLDriverCards` from `'../models'` (add alongside existing `getModel` import).

2. Rename `generateNHLCard` to `generateNHLCards` (note the plural). Change signature to `generateNHLCards(gameId, driverDescriptors, oddsSnapshot)`.

3. The new function maps `driverDescriptors` (the array from `computeNHLDriverCards`) into insertable card objects:

```js
function generateNHLCards(gameId, driverDescriptors, oddsSnapshot) {
  const now = new Date().toISOString();
  let expiresAt = null;
  if (oddsSnapshot?.game_time_utc) {
    const gameTime = new Date(oddsSnapshot.game_time_utc);
    expiresAt = new Date(gameTime.getTime() - 60 * 60 * 1000).toISOString();
  }

  return driverDescriptors.map(descriptor => {
    const cardId = `card-nhl-${descriptor.driverKey}-${gameId}-${uuidV4().slice(0, 8)}`;
    const payloadData = {
      game_id: gameId,
      sport: 'NHL',
      model_version: 'nhl-drivers-v1',
      prediction: descriptor.prediction,
      confidence: descriptor.confidence,
      reasoning: descriptor.reasoning,
      odds_context: {
        h2h_home: oddsSnapshot?.h2h_home,
        h2h_away: oddsSnapshot?.h2h_away,
        spread_home: oddsSnapshot?.spread_home,
        spread_away: oddsSnapshot?.spread_away,
        total: oddsSnapshot?.total,
        captured_at: oddsSnapshot?.captured_at
      },
      ev_passed: descriptor.ev_threshold_passed,
      disclaimer: 'Analysis provided for educational purposes. Not a recommendation.',
      generated_at: now,
      driver: {
        key: descriptor.driverKey,
        score: descriptor.driverScore,
        status: descriptor.driverStatus,
        inputs: descriptor.driverInputs
      },
      meta: {
        inference_source: descriptor.inference_source,
        is_mock: descriptor.is_mock
      }
    };

    return {
      id: cardId,
      gameId,
      sport: 'NHL',
      cardType: descriptor.cardType,
      cardTitle: descriptor.cardTitle,
      createdAt: now,
      expiresAt,
      payloadData,
      modelOutputIds: null
    };
  });
}
```

4. In the game processing loop inside `runNHLModel`, replace the single-card flow with the multi-card flow:

```js
// OLD: const modelOutput = await model.infer(gameId, oddsSnapshot);
// NEW:
const driverCards = computeNHLDriverCards(gameId, oddsSnapshot);

if (driverCards.length === 0) {
  console.log(`  ⏭️  ${gameId}: No driver cards (all data missing)`);
  continue;
}

// Prepare write: delete old nhl-model-output AND all nhl-driver card types
const driverCardTypes = [...new Set(driverCards.map(c => c.cardType))];
for (const ct of driverCardTypes) {
  prepareModelAndCardWrite(gameId, 'nhl-drivers-v1', ct);
}

const cards = generateNHLCards(gameId, driverCards, oddsSnapshot);

for (const card of cards) {
  const validation = validateCardPayload(card.cardType, card.payloadData);
  if (!validation.success) {
    throw new Error(`Invalid card payload for ${card.cardType}: ${validation.errors.join('; ')}`);
  }
  insertCardPayload(card);
  cardsGenerated++;
  console.log(`  ✅ ${gameId} [${card.cardType}]: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`);
}
```

Remove the old `model.infer` call and the `if (modelOutput.ev_threshold_passed)` guard — each driver card emits if it has data.

Remove `insertModelOutput` call (no more composite model_output record per driver — model_outputs are for the composite model only, which is not being run here anymore). Keep the `insertJobRun`/`markJobRunSuccess` pattern intact.

Update `module.exports` to export `generateNHLCards` (remove old `generateNHLCard`).

**In `packages/data/src/validators/card-payload.js`:**

Register all 5 active NHL driver card types in `schemaByCardType`. They all use `basePayloadSchema` but add a `driver` object field:

```js
const driverPayloadSchema = basePayloadSchema.extend({
  driver: z.object({
    key: z.string(),
    score: z.number(),
    status: z.string(),
    inputs: z.record(z.unknown())
  })
});

const schemaByCardType = {
  'nhl-model-output': basePayloadSchema,          // keep for backward compat
  'nhl-goalie': driverPayloadSchema,
  'nhl-special-teams': driverPayloadSchema,
  'nhl-shot-environment': driverPayloadSchema,
  'nhl-empty-net': driverPayloadSchema,
  'nhl-total-fragility': driverPayloadSchema,
  'nhl-pdo-regression': driverPayloadSchema
};
```
  </action>
  <verify>
Run a dry-run end-to-end smoke test:
```bash
node -e "
const { computeNHLDriverCards } = require('./apps/worker/src/models/index.js');
const { generateNHLCards } = require('./apps/worker/src/jobs/run_nhl_model.js');
const { validateCardPayload } = require('./packages/data/src/validators/card-payload.js');

const mockSnap = {
  total: 5.7,
  h2h_home: -120, h2h_away: 100,
  captured_at: new Date().toISOString(),
  game_time_utc: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
  raw_data: JSON.stringify({
    goalie_home_gsax: 1.2, goalie_away_gsax: -0.4,
    pp_home_pct: 22, pk_home_pct: 82, pp_away_pct: 18, pk_away_pct: 79,
    xgf_home_pct: 56, xgf_away_pct: 44,
    pdo_home: 1.005, pdo_away: 0.988
  })
};

const descriptors = computeNHLDriverCards('test-game-1', mockSnap);
const cards = generateNHLCards('test-game-1', descriptors, mockSnap);

let allValid = true;
cards.forEach(card => {
  const v = validateCardPayload(card.cardType, card.payloadData);
  if (!v.success) { allValid = false; console.error('INVALID:', card.cardType, v.errors); }
  else console.log('OK:', card.cardType, card.payloadData.prediction, card.payloadData.confidence.toFixed(2));
});
console.log('All valid:', allValid, '| Cards:', cards.length);
"
```
Expected: 5 lines of "OK: nhl-goalie|nhl-special-teams|nhl-shot-environment|nhl-total-fragility|nhl-pdo-regression", all valid=true, no nhl-empty-net (missing data), no nhl-model-output.
  </verify>
  <done>
Smoke test shows 5 cards, all passing validation, each with a distinct driver cardType. `run_nhl_model.js` exports `generateNHLCards`. `card-payload.js` schema accepts all 5 new types without errors.
  </done>
</task>

</tasks>

<verification>
Full round-trip check (no live DB required):

```bash
node -e "
const { computeNHLDriverCards } = require('./apps/worker/src/models/index.js');
const { generateNHLCards } = require('./apps/worker/src/jobs/run_nhl_model.js');
const { validateCardPayload } = require('./packages/data/src/validators/card-payload.js');

// Test 1: full data — expect 5 cards (emptyNet skipped)
const snap1 = {
  total: 6.0, h2h_home: -115, h2h_away: 105,
  captured_at: new Date().toISOString(),
  game_time_utc: new Date(Date.now() + 4 * 3600000).toISOString(),
  raw_data: JSON.stringify({
    goalie_home_gsax: 0.8, goalie_away_gsax: -0.2,
    pp_home_pct: 21, pk_home_pct: 80, pp_away_pct: 17, pk_away_pct: 78,
    xgf_home_pct: 54, xgf_away_pct: 46,
    pdo_home: 1.010, pdo_away: 0.990
  })
};
const desc1 = computeNHLDriverCards('g1', snap1);
const cards1 = generateNHLCards('g1', desc1, snap1);
console.assert(cards1.length === 5, 'Expected 5 cards, got ' + cards1.length);
cards1.forEach(c => {
  const v = validateCardPayload(c.cardType, c.payloadData);
  console.assert(v.success, c.cardType + ' failed validation: ' + JSON.stringify(v.errors));
  console.assert(c.cardType !== 'nhl-model-output', 'Old card type nhl-model-output should not appear');
});

// Test 2: empty net data present — expect 6 cards
const snap2 = { ...snap1, raw_data: JSON.stringify({
  ...JSON.parse(snap1.raw_data),
  empty_net_pull_home_sec: 90, empty_net_pull_away_sec: 75
})};
const desc2 = computeNHLDriverCards('g2', snap2);
const cards2 = generateNHLCards('g2', desc2, snap2);
console.assert(cards2.length === 6, 'Expected 6 cards when emptyNet data present, got ' + cards2.length);
console.assert(cards2.some(c => c.cardType === 'nhl-empty-net'), 'Expected nhl-empty-net card');

// Test 3: NEUTRAL direction on total fragility
const fragCard = cards1.find(c => c.cardType === 'nhl-total-fragility');
console.assert(fragCard.payloadData.prediction === 'NEUTRAL', 'totalFragility must be NEUTRAL');

console.log('All assertions passed.');
"
```
</verification>

<success_criteria>
- Each NHL game produces 5 cards (or 6 if emptyNet data present) instead of 1 composite card
- Card types: nhl-goalie, nhl-special-teams, nhl-shot-environment, nhl-empty-net (when data available), nhl-total-fragility, nhl-pdo-regression
- No card with cardType 'nhl-model-output' is produced by run_nhl_model.js
- totalFragility direction is always NEUTRAL
- emptyNet card absent when raw_data has no pull seconds fields
- All new card types pass validateCardPayload without errors
- Smoke tests pass without DB access
</success_criteria>

<output>
After completion, create `.planning/quick/2-convert-nhl-drivers-into-individual-payl/2-SUMMARY.md` with:
- What changed (files modified, new functions, removed functions)
- Card types produced before vs after
- Any edge cases handled
- Test commands that verified correctness
</output>
