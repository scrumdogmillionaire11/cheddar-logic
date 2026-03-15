---
phase: quick-45
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/odds/src/config.js
  - apps/worker/src/jobs/run_soccer_model.js
  - packages/data/src/validators/card-payload.js
  - apps/worker/src/jobs/__tests__/run_soccer_model.test.js
autonomous: true
requirements: [WI-0459]

must_haves:
  truths:
    - "Runner no longer exits early with 'No recent SOCCER odds found' — attempts both tracks every run"
    - "When odds are in DB: soccer_ml, soccer_game_total, soccer_double_chance cards emit with real prices"
    - "When odds table is empty: projection-only cards (TSOA, Player Shots, Team Totals) still emit with projection_only:true"
    - "double_chance is no longer in OHIO_BANNED_MARKETS; it is in OHIO_TIER1_MARKETS"
    - "SOCCER config pulls h2h + totals + doubleChance (3 tokens/fetch)"
    - "All existing tests pass; new tests cover both tracks and all three new odds-backed card types"
  artifacts:
    - path: "packages/odds/src/config.js"
      provides: "SOCCER.markets=['h2h','totals','doubleChance'], tokensPerFetch:3"
    - path: "apps/worker/src/jobs/run_soccer_model.js"
      provides: "Two-track runner + new odds-backed builders + updated OHIO_TIER1_MARKETS"
    - path: "packages/data/src/validators/card-payload.js"
      provides: "soccer_ml, soccer_game_total, soccer_double_chance schemas + projection_only flag on soccer-ohio-scope"
    - path: "apps/worker/src/jobs/__tests__/run_soccer_model.test.js"
      provides: "Tests for both tracks and three new card types"
  key_links:
    - from: "run_soccer_model.js Track 2"
      to: "games table (not odds_snapshots table)"
      via: "getUpcomingGames('SOCCER') — no odds dependency"
      pattern: "getUpcomingGames"
    - from: "odds-backed builders"
      to: "validateCardPayload"
      via: "soccer_ml / soccer_game_total / soccer_double_chance card types"
      pattern: "validateCardPayload\\('soccer_(ml|game_total|double_chance)'"
    - from: "soccer-ohio-scope cards with projection_only:true"
      to: "soccerOhioScopeSchema"
      via: "price fields not required when projection_only:true"
      pattern: "projection_only"
---

<objective>
Implement WI-0459: add totals + doubleChance odds markets to SOCCER config, restructure the soccer model runner to use two independent tracks (odds-backed and projection-only), add three new card type schemas to the validator, and update tests to cover both tracks.

Purpose: Soccer currently produces zero cards when EPL odds aren't in the DB. Projection-only markets (TSOA, Player Shots, Team Totals) should run regardless of odds availability. Odds-backed markets (ML, Game Total, Double Chance) need proper schema support.
Output: Working two-track soccer model runner; validator with three new schemas; config pulling 3 markets; full test coverage.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@WORK_QUEUE/WI-0459.md
</context>

<interfaces>
<!-- Key contracts the executor needs. Extracted from codebase. -->

From packages/data/src/validators/card-payload.js — existing soccer schemas:
```js
// soccerOhioScopeSchema covers canonical keys: player_shots, team_totals, to_score_or_assist,
//   player_shots_on_target, anytime_goalscorer, team_corners
// soccerPayloadSchema covers soccer-model-output (moneyline only)
// schemaByCardType maps cardType string -> schema
// validateCardPayload(cardType, payloadData) -> { success, errors }
```

From apps/worker/src/jobs/run_soccer_model.js — key market constants:
```js
const OHIO_TIER1_MARKETS = new Set(['player_shots', 'team_totals', 'to_score_or_assist']);
const OHIO_BANNED_MARKETS = new Set(['draw_no_bet','asian_handicap','match_total','btts',
  'cards','fouls','1x2','double_chance']); // double_chance must move to TIER1
// normalizeToCanonicalSoccerMarket(rawKey) -> string|null
// buildSoccerTier1Payload(gameId, oddsSnapshot, canonicalMarket) -> { cardType, payloadData, pass_reason }
// generateSoccerCard(gameId, oddsSnapshot) -> card object (moneyline, cardType:'soccer-model-output')
```

From @cheddar-logic/data (already imported in runner):
```js
// getOddsWithUpcomingGames(sport, nowIso, horizonIso) -> oddsSnapshot[]
// Need: getUpcomingGames(sport, nowIso, horizonIso) -> game[] -- check if this exists or use games table directly
// insertCardPayload(card), validateCardPayload(cardType, payload)
```
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: Config + validator — add markets and new card schemas</name>
  <files>
    packages/odds/src/config.js
    packages/data/src/validators/card-payload.js
  </files>
  <action>
**packages/odds/src/config.js**

In the SOCCER entry change:
- `markets: ['h2h']` → `markets: ['h2h', 'totals', 'doubleChance']`
- `tokensPerFetch: 1` → `tokensPerFetch: 3`

Update the comment block at top of file to add a SOCCER line documenting the token cost:
```
 * - SOCCER: h2h + totals + doubleChance = 3 tokens
```

**packages/data/src/validators/card-payload.js**

Add three new Zod schemas after the existing `soccerOhioScopeSchema` definition (before the `schemaByCardType` map):

1. `soccerMlSchema` — for `soccer_ml` card type:
```js
const soccerMlSchema = z.object({
  sport: z.literal('SOCCER'),
  game_id: z.string().min(1),
  home_team: z.string().min(1).nullable(),
  away_team: z.string().min(1).nullable(),
  generated_at: isoDateString,
  market_type: z.literal('MONEYLINE'),
  selection: z.object({ side: z.enum(['HOME', 'AWAY']), team: z.string().min(1).nullable() }),
  price: z.number().int().nullable(),
  edge_basis: z.string().nullable(),
  missing_context_flags: z.array(z.string()),
  pass_reason: z.string().nullable(),
}).passthrough();
```

2. `soccerGameTotalSchema` — for `soccer_game_total` card type:
```js
const soccerGameTotalSchema = z.object({
  sport: z.literal('SOCCER'),
  game_id: z.string().min(1),
  home_team: z.string().min(1).nullable(),
  away_team: z.string().min(1).nullable(),
  generated_at: isoDateString,
  market_type: z.literal('GAME_TOTAL'),
  line: z.number().nullable(),
  over_price: z.number().int().nullable(),
  under_price: z.number().int().nullable(),
  selection: z.enum(['OVER', 'UNDER']).nullable(),
  edge_basis: z.string().nullable(),
  missing_context_flags: z.array(z.string()),
  pass_reason: z.string().nullable(),
}).passthrough();
```

3. `soccerDoubleChanceSchema` — for `soccer_double_chance` card type:
```js
const soccerDoubleChanceSchema = z.object({
  sport: z.literal('SOCCER'),
  game_id: z.string().min(1),
  home_team: z.string().min(1).nullable(),
  away_team: z.string().min(1).nullable(),
  generated_at: isoDateString,
  market_type: z.literal('DOUBLE_CHANCE'),
  outcome: z.enum(['home_or_draw', 'away_or_draw', 'either_to_win']).nullable(),
  price: z.number().int().nullable(),
  edge_basis: z.string().nullable(),
  missing_context_flags: z.array(z.string()),
  pass_reason: z.string().nullable(),
}).passthrough();
```

Update `soccerOhioScopeSchema` base object to accept `projection_only` flag without requiring price fields when it is set:
- Add `projection_only: z.boolean().optional()` to the base object shape.
- In the `superRefine`, wrap price-cap checks in `if (!payload.projection_only)` guards so projection-only cards are not rejected for null prices.

Update `schemaByCardType` to register the three new schemas:
```js
'soccer_ml': soccerMlSchema,
'soccer_game_total': soccerGameTotalSchema,
'soccer_double_chance': soccerDoubleChanceSchema,
```

Also update the `validateCardPayload` function: extend the `cardType !== 'soccer-ohio-scope'` guard to also skip `deriveLockedMarketContext` for the three new soccer card types (`soccer_ml`, `soccer_game_total`, `soccer_double_chance`) since they use self-contained schemas. The cleanest approach is to define a `SOCCER_SELF_CONTAINED_TYPES = new Set(['soccer-ohio-scope','soccer_ml','soccer_game_total','soccer_double_chance'])` and replace the single-value check.
  </action>
  <verify>
    <automated>npm --prefix packages/odds test 2>/dev/null || echo "no odds tests"; npm --prefix packages/data test 2>/dev/null || echo "no data tests"; node -e "const c = require('./packages/odds/src/config.js'); const s = c.SPORTS_CONFIG.SOCCER; console.assert(s.markets.includes('totals'), 'missing totals'); console.assert(s.markets.includes('doubleChance'), 'missing doubleChance'); console.assert(s.tokensPerFetch === 3, 'wrong token count'); console.log('config OK');" && node -e "const {validateCardPayload} = require('./packages/data/src/validators/card-payload.js'); const r = validateCardPayload('soccer_ml', {sport:'SOCCER',game_id:'g1',home_team:'A',away_team:'B',generated_at:new Date().toISOString(),market_type:'MONEYLINE',selection:{side:'HOME',team:'A'},price:-110,edge_basis:'vig_gap',missing_context_flags:[],pass_reason:null}); console.assert(r.success, JSON.stringify(r.errors)); console.log('validator OK');"</automated>
  </verify>
  <done>
    - SOCCER config has markets: ['h2h','totals','doubleChance'] and tokensPerFetch: 3
    - validateCardPayload accepts soccer_ml, soccer_game_total, soccer_double_chance payloads
    - soccerOhioScopeSchema accepts projection_only:true with null price fields (no price-cap rejection)
    - SOCCER_SELF_CONTAINED_TYPES set used in validateCardPayload to skip deriveLockedMarketContext
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Two-track runner — market constants + builders + track split</name>
  <files>apps/worker/src/jobs/run_soccer_model.js</files>
  <behavior>
    - normalizeToCanonicalSoccerMarket('double_chance') returns 'soccer_double_chance' (not null — no longer banned)
    - normalizeToCanonicalSoccerMarket('h2h') returns 'soccer_ml'
    - normalizeToCanonicalSoccerMarket('moneyline') returns 'soccer_ml'
    - normalizeToCanonicalSoccerMarket('totals') returns 'soccer_game_total'
    - normalizeToCanonicalSoccerMarket('game_total') returns 'soccer_game_total'
    - buildSoccerOddsBackedCard(gameId, oddsSnapshot, 'soccer_ml') returns valid soccer_ml card
    - buildSoccerOddsBackedCard(gameId, oddsSnapshot, 'soccer_game_total') returns valid soccer_game_total card
    - buildSoccerOddsBackedCard(gameId, oddsSnapshot, 'soccer_double_chance') returns valid soccer_double_chance card
    - runSoccerModel() proceeds past Track 1 even when getOddsWithUpcomingGames returns []
    - runSoccerModel() calls Track 2 (projection-only) for upcoming games regardless of odds rows
  </behavior>
  <action>
**Market constant changes:**

Remove `'double_chance'` from `OHIO_BANNED_MARKETS`.

Add `'soccer_ml'`, `'soccer_game_total'`, `'soccer_double_chance'` to `OHIO_TIER1_MARKETS`.

**Extend normalizeToCanonicalSoccerMarket** with a lookup table for odds API market keys → canonical soccer card type keys. Place this mapping BEFORE the existing Tier1/Tier2 set lookups:

```js
const ODDS_API_MARKET_MAP = {
  'h2h': 'soccer_ml',
  'moneyline': 'soccer_ml',
  'soccer_ml': 'soccer_ml',
  'totals': 'soccer_game_total',
  'game_total': 'soccer_game_total',
  'soccer_game_total': 'soccer_game_total',
  'double_chance': 'soccer_double_chance',
  'soccer_double_chance': 'soccer_double_chance',
};
```

If `ODDS_API_MARKET_MAP[normalized]` exists, return it immediately (skip the existing Tier1/Tier2/banned set checks — those are for ohio projection-only markets which use different keys).

**Add buildSoccerOddsBackedCard(gameId, oddsSnapshot, canonicalCardType) function:**

This builds cards for the three odds-backed types. It reads `oddsSnapshot` fields and raw_data. Returns a card object (same shape as `generateSoccerCard` — has `id`, `gameId`, `sport`, `cardType`, `cardTitle`, `createdAt`, `expiresAt`, `payloadData`, `modelOutputIds`).

For `soccer_ml`:
```js
payloadData = {
  sport: 'SOCCER', game_id: gameId,
  market_type: 'MONEYLINE',
  home_team: oddsSnapshot.home_team ?? null,
  away_team: oddsSnapshot.away_team ?? null,
  matchup: buildMatchup(oddsSnapshot.home_team, oddsSnapshot.away_team),
  start_time_utc: oddsSnapshot.game_time_utc ?? null,
  generated_at: now,
  selection: { side: prediction, team: selectionTeam },
  price: oddsSnapshot.h2h_home ?? null,   // use favored side price
  edge_basis: 'vig_normalized_moneyline',
  missing_context_flags: [...],
  pass_reason: null,
  // derive prediction same as generateSoccerCard (use derivePredictionFromMoneyline)
}
```

For `soccer_game_total` — read `rawData.total_line`, `rawData.over_price`, `rawData.under_price` from raw_data; set `selection: rawData.selection ?? null`; `pass_reason = 'MISSING_LINE'` if total_line null.

For `soccer_double_chance` — read `rawData.dc_outcome` → `outcome` field (one of `home_or_draw`, `away_or_draw`, `either_to_win` — default null); `price` from `rawData.dc_price ?? null`; `edge_basis` from `rawData.edge_basis ?? null`.

All three should populate `missing_context_flags` for any null required fields.

**Restructure runSoccerModel into two tracks:**

Replace the early-exit block:
```js
if (oddsSnapshots.length === 0) {
  console.log('[SoccerModel] No recent SOCCER odds found, exiting.');
  markJobRunSuccess(jobRunId);
  return { success: true, jobRunId, cardsGenerated: 0 };
}
```

With:
```js
console.log(`[SoccerModel] Track 1 (odds-backed): ${oddsSnapshots.length} odds snapshots found`);
```

**Track 1 loop** — process `oddsSnapshots` (can be 0 iterations if empty — no bail-out). For each snapshot, derive canonical market from `rawData.market ?? rawData.soccer_market` using `normalizeToCanonicalSoccerMarket`. If canonical key is in `['soccer_ml','soccer_game_total','soccer_double_chance']`, use `buildSoccerOddsBackedCard`. If canonical key is a projection-key (Tier1/Tier2 player market), use existing `buildSoccerTier1Payload` path. Otherwise fall back to `generateSoccerCard`.

**Track 2 — projection-only** — After Track 1 loop completes (regardless of how many odds rows existed):

```js
console.log('[SoccerModel] Track 2 (projection-only): fetching upcoming games...');
// Attempt to get upcoming games directly from games table
let upcomingGames = [];
try {
  // getUpcomingGames may not exist yet — check @cheddar-logic/data exports
  // If not available, fall back to oddsSnapshots game_ids (may be empty)
  const dataExports = require('@cheddar-logic/data');
  if (typeof dataExports.getUpcomingGames === 'function') {
    upcomingGames = dataExports.getUpcomingGames('SOCCER', nowUtc.toISO(), horizonUtc);
  } else {
    // Fallback: use game IDs already seen in Track 1
    upcomingGames = Object.values(gameOdds);
    console.log('[SoccerModel] Track 2: getUpcomingGames not available, using Track 1 game IDs');
  }
} catch (e) {
  console.warn('[SoccerModel] Track 2: could not fetch upcoming games:', e.message);
}
```

For each upcoming game in Track 2, build projection-only cards for the three player/team markets: `to_score_or_assist`, `player_shots`, `team_totals`. Use the existing `buildSoccerTier1Payload` function. Override `payloadData.projection_only = true` on the returned payload before validation/insert. These use `cardType: 'soccer-ohio-scope'` (unchanged).

Track 2 card IDs: `card-soccer-proj-${gameId}-${market}-${uuidV4().slice(0,8)}`

**Export** `buildSoccerOddsBackedCard` from the module at bottom.

**Return value** — update to include both counts:
```js
return { success: true, jobRunId, cardsGenerated, track1Cards, track2Cards };
```
  </action>
  <verify>
    <automated>npm --prefix apps/worker test -- src/jobs/__tests__/run_soccer_model.test.js --no-coverage 2>&1 | tail -20</automated>
  </verify>
  <done>
    - normalizeToCanonicalSoccerMarket('double_chance') returns 'soccer_double_chance' (not null)
    - normalizeToCanonicalSoccerMarket('h2h') returns 'soccer_ml'
    - normalizeToCanonicalSoccerMarket('totals') returns 'soccer_game_total'
    - buildSoccerOddsBackedCard exported and produces valid payloads for all three card types
    - runSoccerModel does not bail out when Track 1 finds zero odds rows
    - Track 2 runs unconditionally and emits projection_only:true on soccer-ohio-scope cards
    - All existing tests still pass
  </done>
</task>

<task type="auto">
  <name>Task 3: Update tests — new card types and both tracks</name>
  <files>apps/worker/src/jobs/__tests__/run_soccer_model.test.js</files>
  <action>
Add new describe blocks to the existing test file. Do not remove any existing tests.

Import `buildSoccerOddsBackedCard` from `../run_soccer_model` at the top alongside existing imports.

**New describe: 'normalizeToCanonicalSoccerMarket — odds API market keys'**

Add tests:
- `'h2h' -> 'soccer_ml'`
- `'moneyline' -> 'soccer_ml'`
- `'totals' -> 'soccer_game_total'`
- `'game_total' -> 'soccer_game_total'`
- `'double_chance' -> 'soccer_double_chance'` (no longer banned)
- `'doubleChance' -> 'soccer_double_chance'` (camelCase variant normalizes via replace)

Existing test `"'asian_handicap' -> null (banned)"` and `"'1x2' -> null (banned)"` should still pass (those remain in OHIO_BANNED_MARKETS).

**New describe: 'buildSoccerOddsBackedCard — soccer_ml'**

```js
test('produces valid soccer_ml payload from h2h odds snapshot', () => {
  const snap = buildOddsSnapshot({ h2h_home: -120, h2h_away: 105 });
  const card = buildSoccerOddsBackedCard(snap.game_id, snap, 'soccer_ml');
  expect(card.cardType).toBe('soccer_ml');
  expect(card.payloadData.market_type).toBe('MONEYLINE');
  expect(card.payloadData.missing_context_flags).toEqual([]);
  const v = validateCardPayload('soccer_ml', card.payloadData);
  expect(v.success).toBe(true);
});
```

**New describe: 'buildSoccerOddsBackedCard — soccer_game_total'**

```js
test('produces valid soccer_game_total payload when line provided in raw_data', () => {
  const snap = buildOddsSnapshot({
    raw_data: JSON.stringify({ league: 'EPL', market: 'totals', total_line: 2.5, over_price: -115, under_price: -105, selection: 'OVER' }),
  });
  const card = buildSoccerOddsBackedCard(snap.game_id, snap, 'soccer_game_total');
  expect(card.cardType).toBe('soccer_game_total');
  expect(card.payloadData.market_type).toBe('GAME_TOTAL');
  expect(card.payloadData.line).toBe(2.5);
  expect(card.payloadData.pass_reason).toBeNull();
  const v = validateCardPayload('soccer_game_total', card.payloadData);
  expect(v.success).toBe(true);
});

test('sets pass_reason=MISSING_LINE when total_line absent', () => {
  const snap = buildOddsSnapshot({ raw_data: JSON.stringify({ league: 'EPL', market: 'totals' }) });
  const card = buildSoccerOddsBackedCard(snap.game_id, snap, 'soccer_game_total');
  expect(card.payloadData.pass_reason).toBe('MISSING_LINE');
});
```

**New describe: 'buildSoccerOddsBackedCard — soccer_double_chance'**

```js
test('produces valid soccer_double_chance payload', () => {
  const snap = buildOddsSnapshot({
    raw_data: JSON.stringify({ league: 'EPL', market: 'doubleChance', dc_outcome: 'home_or_draw', dc_price: -145, edge_basis: 'vig_gap_0.04' }),
  });
  const card = buildSoccerOddsBackedCard(snap.game_id, snap, 'soccer_double_chance');
  expect(card.cardType).toBe('soccer_double_chance');
  expect(card.payloadData.market_type).toBe('DOUBLE_CHANCE');
  expect(card.payloadData.outcome).toBe('home_or_draw');
  const v = validateCardPayload('soccer_double_chance', card.payloadData);
  expect(v.success).toBe(true);
});
```

**New describe: 'Track 2 projection-only cards'**

```js
test('soccer-ohio-scope card with projection_only:true passes validator without price', () => {
  const payload = {
    canonical_market_key: 'to_score_or_assist',
    market_family: 'tier1',
    sport: 'SOCCER',
    game_id: 'game-proj-001',
    home_team: 'Arsenal',
    away_team: 'Chelsea',
    generated_at: new Date().toISOString(),
    missing_context_flags: ['price'],
    pass_reason: null,
    projection_basis: 'xg_xa_combined_0.55',
    edge_ev: 0.04,
    price: null,
    projection_only: true,
  };
  const v = validateCardPayload('soccer-ohio-scope', payload);
  expect(v.success).toBe(true);
});
```

Run full test suite after writing to confirm all existing + new tests pass.
  </action>
  <verify>
    <automated>npm --prefix apps/worker test -- src/jobs/__tests__/run_soccer_model.test.js --no-coverage 2>&1 | tail -30</automated>
  </verify>
  <done>
    - All existing tests still pass
    - New normalizeToCanonicalSoccerMarket tests for odds API keys pass
    - buildSoccerOddsBackedCard tests for soccer_ml, soccer_game_total, soccer_double_chance all pass
    - Validator accepts soccer-ohio-scope with projection_only:true and null price
    - No test regressions
  </done>
</task>

</tasks>

<verification>
After all tasks complete:

1. Config check: `node -e "const c=require('./packages/odds/src/config.js'); const s=c.SPORTS_CONFIG.SOCCER; console.log('markets:', s.markets, 'tokens:', s.tokensPerFetch);"`
   Expected: markets: [ 'h2h', 'totals', 'doubleChance' ] tokens: 3

2. Full test run: `npm --prefix apps/worker test -- src/jobs/__tests__/run_soccer_model.test.js --no-coverage`
   Expected: all tests pass, no failures

3. Acceptance check from WI-0459:
   - double_chance NOT in OHIO_BANNED_MARKETS: `node -e "const {normalizeToCanonicalSoccerMarket}=require('./apps/worker/src/jobs/run_soccer_model.js'); console.log(normalizeToCanonicalSoccerMarket('double_chance'));"`
     Expected: `soccer_double_chance`
   - Runner dry-run: `npm --prefix apps/worker run job:run-soccer-model:test`
     Expected: proceeds to both tracks, no immediate "No recent SOCCER odds found" exit
</verification>

<success_criteria>
- SOCCER config: markets=['h2h','totals','doubleChance'], tokensPerFetch=3
- double_chance removed from OHIO_BANNED_MARKETS; soccer_ml/soccer_game_total/soccer_double_chance in OHIO_TIER1_MARKETS
- normalizeToCanonicalSoccerMarket maps odds API keys (h2h→soccer_ml, totals→soccer_game_total, double_chance→soccer_double_chance)
- buildSoccerOddsBackedCard function exists, exported, produces valid payloads for all three card types
- runSoccerModel: Track 1 runs over odds snapshots (0 or more), Track 2 runs unconditionally for projection-only player markets with projection_only:true
- validator: soccer_ml, soccer_game_total, soccer_double_chance schemas registered; soccer-ohio-scope accepts projection_only:true without requiring price
- All existing tests pass; new tests cover both tracks and three new card types
</success_criteria>

<output>
After completion, create `.planning/quick/45-wi-0459-soccer-odds-projection-only-mark/45-SUMMARY.md` using the standard summary template.
</output>
