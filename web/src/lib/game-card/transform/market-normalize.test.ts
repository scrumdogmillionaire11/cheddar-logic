import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMarketKey,
  buildMarkets,
  inferMarketFromPlay,
  normalizeSideToken,
} from './market-normalize';

test('market-normalize smoke', () => {
  const inferred = inferMarketFromPlay({
    cardType: 'nhl-totals-call',
    cardTitle: 'NHL totals',
    prediction: 'OVER',
    kind: 'PLAY',
    market_type: 'TOTAL',
    line: 6.5,
    selection: { side: 'OVER' },
  });
  assert.equal(inferred.canonical, 'TOTAL');

  const downgraded = inferMarketFromPlay({
    cardType: 'nhl-totals-call',
    cardTitle: 'NHL totals',
    prediction: 'OVER',
    kind: 'PLAY',
    line: 6.5,
    selection: { side: 'OVER' },
  });
  assert.equal(downgraded.canonical, 'INFO');
  assert.equal(downgraded.market, 'UNKNOWN');
  assert.equal(downgraded.reasonCodes.includes('PASS_MISSING_MARKET_TYPE'), true);

  assert.equal(normalizeSideToken('away'), 'AWAY');
  assert.equal(buildMarketKey('TOTAL', 'OVER'), 'TOTAL|OVER');
  assert.deepEqual(
    buildMarkets({
      h2hHome: -120,
      h2hAway: 100,
      total: 6.5,
      spreadHome: -1.5,
      spreadAway: 1.5,
    }),
    {
      ml: { home: -120, away: 100 },
      spread: { home: -1.5, away: 1.5 },
      total: { line: 6.5 },
    },
  );
});
