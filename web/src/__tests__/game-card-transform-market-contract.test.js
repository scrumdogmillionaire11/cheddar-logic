/*
 * Behavior-first market transform contract checks.
 * Run: npm --prefix web run test:transform:market
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const webRoot = path.resolve(repoRoot, 'web');

console.log('Behavior market transform contract tests');

// Reuse the existing runtime hardening suite that exercises transform outputs.
execFileSync(
  process.execPath,
  ['--import', 'tsx/esm', 'src/__tests__/game-card-transform-hardening.test.js'],
  {
    cwd: webRoot,
    stdio: 'inherit',
  },
);

const behaviorScript = String.raw`
import assert from 'node:assert/strict';
import { transformToGameCard, transformPropGames } from './src/lib/game-card/transform/index.ts';

function makeGame(overrides = {}) {
  return {
    id: 'market-contract-base',
    gameId: 'market-contract-base',
    sport: 'NHL',
    homeTeam: 'Home Team',
    awayTeam: 'Away Team',
    gameTimeUtc: '2026-04-14T23:00:00Z',
    status: 'scheduled',
    createdAt: '2026-04-13T20:00:00Z',
    projection_inputs_complete: true,
    projection_missing_inputs: [],
    source_mapping_ok: true,
    source_mapping_failures: [],
    ingest_failure_reason_code: null,
    ingest_failure_reason_detail: null,
    odds: {
      h2hHome: -120,
      h2hAway: 110,
      total: 5.5,
      spreadHome: null,
      spreadAway: null,
      spreadPriceHome: null,
      spreadPriceAway: null,
      totalPriceOver: -110,
      totalPriceUnder: -110,
      capturedAt: '2026-04-13T20:05:00Z',
    },
    consistency: { total_bias: 'OK' },
    true_play: null,
    plays: [],
    ...overrides,
  };
}

const missingMarketGame = makeGame({
  id: 'missing-market',
  gameId: 'missing-market',
  plays: [
    {
      source_card_id: 'card-missing-market',
      cardType: 'unknown-card',
      cardTitle: 'Unknown Card Type',
      prediction: 'OVER',
      confidence: 0.7,
      tier: 'BEST',
      reasoning: 'Actionable row intentionally missing canonical market_type.',
      evPassed: true,
      driverKey: 'nhl-totals-call',
      kind: 'PLAY',
      selection: { side: 'OVER' },
      line: 5.5,
      price: -110,
      action: 'FIRE',
      status: 'FIRE',
      model_prob: 0.56,
      reason_codes: [],
    },
  ],
});

const missingMarketCard = transformToGameCard(missingMarketGame);
assert.equal(missingMarketCard.play?.decision, 'PASS');
assert.equal(missingMarketCard.play?.betAction, 'NO_PLAY');
assert.ok(missingMarketCard.play?.reason_codes?.includes('PASS_NO_ACTIONABLE_PLAY'));

const propGame = makeGame({
  id: 'prop-contract',
  gameId: 'prop-contract',
  sport: 'MLB',
  plays: [
    {
      source_card_id: 'card-prop-projection',
      cardType: 'mlb-player-k',
      cardTitle: 'Pitcher Strikeouts: Pitcher X OVER 6.5',
      prediction: 'OVER',
      confidence: 0.6,
      tier: 'WATCH',
      reasoning: 'Projection-only row for props tab.',
      evPassed: false,
      driverKey: 'pitcher-k',
      market_type: 'PROP',
      canonical_market_key: 'pitcher_strikeouts',
      selection: { side: 'OVER', team: 'Pitcher X' },
      player_id: '12',
      player_name: 'Pitcher X',
      line: 7,
      suggested_line: 6.5,
      action: 'PASS',
      status: 'PASS',
      basis: 'PROJECTION_ONLY',
      execution_status: 'PROJECTION_ONLY',
      prop_display_state: 'PROJECTION_ONLY',
      prop_decision: {
        verdict: 'PASS',
        projection_source: 'SYNTHETIC_FALLBACK',
        lean_side: 'UNDER',
        line: 6.5,
        k_mean: 5.9,
        line_delta: -0.6,
      },
    },
  ],
});

const propCards = transformPropGames([propGame]);
assert.equal(propCards.length, 1);
const propRow = propCards[0].propPlays[0];
assert.equal(propRow.propVerdict, 'PROJECTION');
assert.equal(propRow.status, 'NO_PLAY');
assert.equal(propRow.marketLine, 6.5);
assert.equal(propRow.projection, 5.9);
assert.equal(propRow.leanSide, 'UNDER');
`;

execFileSync(process.execPath, ['--import', 'tsx/esm', '--eval', behaviorScript], {
  cwd: webRoot,
  stdio: 'inherit',
});

assert.ok(true);
console.log('Behavior market transform contract tests passed');
