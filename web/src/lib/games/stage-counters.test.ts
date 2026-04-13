import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPlayableMarketFamilyDiagnostics,
  COUNTER_ALL_MARKET,
  createStageCounters,
  incrementStageCounter,
  registerGameWithPlayableMarket,
} from './stage-counters';

test('stage-counters smoke', () => {
  const counters = createStageCounters();
  incrementStageCounter(counters, 'plays_emitted', 'NHL', 'TOTAL');
  incrementStageCounter(counters, 'plays_emitted', 'MLB', 'TOTAL');
  incrementStageCounter(counters, 'plays_emitted', 'MLB', 'MONEYLINE');

  const games = new Map<string, Map<string, Set<string>>>();
  registerGameWithPlayableMarket(games, 'NHL', 'TOTAL', 'game-1');
  assert.equal(games.get('NHL')?.get('TOTAL')?.has('game-1'), true);

  const diagnostics = buildPlayableMarketFamilyDiagnostics(counters, {
    NHL: {
      playProducerCardTypes: new Set(['nhl-totals-call']),
      evidenceOnlyCardTypes: new Set(['nhl-model-output']),
      expectedPlayableMarkets: new Set(['TOTAL']),
    },
    MLB: {
      playProducerCardTypes: new Set(['mlb-full-game', 'mlb-full-game-ml']),
      evidenceOnlyCardTypes: new Set(['mlb-model-output']),
      expectedPlayableMarkets: new Set(['FIRST_5_INNINGS', 'MONEYLINE', 'PROP', 'TOTAL']),
    },
  });
  assert.deepEqual(diagnostics.emitted_playable_markets.NHL, ['TOTAL']);
  assert.deepEqual(diagnostics.emitted_playable_markets.MLB, ['MONEYLINE', 'TOTAL']);
  assert.deepEqual(diagnostics.missing_playable_markets.MLB, ['FIRST_5_INNINGS', 'PROP']);
  assert.equal(COUNTER_ALL_MARKET, 'ALL');
});
