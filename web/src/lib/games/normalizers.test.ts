import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractShotsFromRecentGames,
  normalizeMarketType,
  normalizePassReasonCode,
  parseJsonObject,
} from './normalizers';

test('normalizers smoke', () => {
  assert.deepEqual(parseJsonObject('{"ok":true}'), { ok: true });
  assert.equal(normalizeMarketType('double_chance'), 'MONEYLINE');
  assert.equal(normalizePassReasonCode('missing_line'), 'PASS_MISSING_LINE');
  assert.deepEqual(
    extractShotsFromRecentGames([{ shots: 3 }, { shots: '5' }]),
    [3, 5],
  );
});
