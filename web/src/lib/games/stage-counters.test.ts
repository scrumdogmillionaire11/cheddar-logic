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

  const games = new Map<string, Map<string, Set<string>>>();
  registerGameWithPlayableMarket(games, 'NHL', 'TOTAL', 'game-1');
  assert.equal(games.get('NHL')?.get('TOTAL')?.has('game-1'), true);

  const diagnostics = buildPlayableMarketFamilyDiagnostics(counters, {
    NHL: {
      playProducerCardTypes: new Set(['nhl-totals-call']),
      evidenceOnlyCardTypes: new Set(['nhl-model-output']),
      expectedPlayableMarkets: new Set(['TOTAL']),
    },
  });
  assert.deepEqual(diagnostics.emitted_playable_markets.NHL, ['TOTAL']);
  assert.equal(COUNTER_ALL_MARKET, 'ALL');
});
