import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOptionalOddsSelect, toSqlUtc } from './query-builder';

test('query-builder smoke', () => {
  assert.equal(
    toSqlUtc(new Date('2026-03-29T01:00:00.000Z')),
    '2026-03-29 01:00:00',
  );
  assert.equal(
    buildOptionalOddsSelect(new Set(['spread_home']), 'spread_home'),
    'o.spread_home',
  );
  assert.equal(
    buildOptionalOddsSelect(new Set(['spread_home']), 'spread_away'),
    'NULL AS spread_away',
  );
});
