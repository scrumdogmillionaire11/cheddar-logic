/*
 * Behavioral route contract for /api/games prop decision fields.
 * Run: node web/src/__tests__/api-games-prop-decision-contract.test.js
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const webRoot = path.resolve(repoRoot, 'web');

const behaviorScript = String.raw`
import assert from 'node:assert/strict';
import { buildGamesResponseData } from './src/lib/games/route-handler.ts';
import { ACTIVE_SPORT_CARD_TYPE_CONTRACT, inferMarketFromCardType } from './src/lib/games/market-inference.ts';

assert.equal(inferMarketFromCardType('mlb-full-game-ml'), 'MONEYLINE');
assert.equal(inferMarketFromCardType('mlb-full-game'), 'TOTAL');
assert.ok(ACTIVE_SPORT_CARD_TYPE_CONTRACT.MLB.expectedPlayableMarkets.has('MONEYLINE'));
assert.ok(ACTIVE_SPORT_CARD_TYPE_CONTRACT.MLB.expectedPlayableMarkets.has('TOTAL'));
assert.ok(ACTIVE_SPORT_CARD_TYPE_CONTRACT.NHL.playProducerCardTypes.has('nhl-player-blk'));

const row = {
  id: 'row-1',
  game_id: 'game-1',
  sport: 'MLB',
  home_team: 'Home',
  away_team: 'Away',
  game_time_utc: '2026-04-14T23:00:00Z',
  status: 'scheduled',
  created_at: '2026-04-13T20:00:00Z',
  h2h_home: null,
  h2h_away: null,
  total: null,
  spread_home: null,
  spread_away: null,
  odds_captured_at: null,
  projection_inputs_complete: true,
  projection_missing_inputs: [],
  source_mapping_ok: true,
  source_mapping_failures: [],
  ingest_failure_reason_code: null,
  ingest_failure_reason_detail: null,
};

const play = {
  source_card_id: 'card-1',
  cardType: 'mlb-pitcher-k',
  cardTitle: 'Pitcher Strikeouts',
  prediction: 'OVER',
  confidence: 0.62,
  tier: 'WATCH',
  reasoning: 'Behavioral contract fixture',
  evPassed: false,
  driverKey: 'pitcher-k',
  kind: 'PLAY',
  market_type: 'PROP',
  canonical_market_key: 'pitcher_strikeouts',
  selection: { side: 'OVER', team: 'Pitcher X' },
  player_id: '42',
  player_name: 'Pitcher X',
  action: 'PASS',
  status: 'PASS',
  basis: 'PROJECTION_ONLY',
  execution_status: 'PROJECTION_ONLY',
  pass_reason_code: 'PASS_NO_EDGE',
  market_bookmaker: 'book-a',
  prop_display_state: 'PROJECTION_ONLY',
  prop_decision: {
    verdict: 'PROJECTION',
    lean_side: 'UNDER',
    line: 6.5,
    display_price: -115,
    projection: 6.1,
    line_delta: -0.4,
    fair_prob: 0.52,
    implied_prob: 0.5,
    prob_edge_pp: 2,
    ev: 0.01,
    l5_mean: 5.8,
    l5_trend: 'stable',
    why: 'Projection below line',
    flags: ['PROJECTION_ONLY'],
    k_mean: 6.1,
    probability_ladder: { '5': 0.4 },
    fair_prices: { over: -105, under: -115 },
    playability: { over_playable_at_or_below: -110, under_playable_at_or_above: 105 },
    projection_source: 'SYNTHETIC_FALLBACK',
    status_cap: 'PASS',
    pass_reason_code: 'PASS_NO_EDGE',
    missing_inputs: ['market_price'],
  },
};

const responseRows = buildGamesResponseData([row], 'pregame', {
  playsMap: new Map([[row.game_id, [play]]]),
  truePlayMap: new Map([[row.game_id, play]]),
});

assert.equal(responseRows.length, 1);
assert.equal(responseRows[0].plays.length, 1);
const emittedPlay = responseRows[0].plays[0];
assert.equal(emittedPlay.prop_display_state, 'PROJECTION_ONLY');
assert.equal(emittedPlay.execution_status, 'PROJECTION_ONLY');
assert.equal(emittedPlay.pass_reason_code, 'PASS_NO_EDGE');
assert.equal(emittedPlay.market_bookmaker, 'book-a');
assert.equal(emittedPlay.prop_decision?.projection_source, 'SYNTHETIC_FALLBACK');
assert.equal(emittedPlay.prop_decision?.k_mean, 6.1);
assert.equal(emittedPlay.prop_decision?.lean_side, 'UNDER');
process.exit(0);
`;

execFileSync(process.execPath, ['--import', 'tsx/esm', '--eval', behaviorScript], {
  cwd: webRoot,
  stdio: 'inherit',
});

assert.ok(true);
console.log('API games prop decision behavioral contract test passed');
