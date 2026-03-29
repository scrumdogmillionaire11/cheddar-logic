import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWave1PickText,
  getPlayWhyCode,
  getRiskTagsFromText,
  hasPlaceholderText,
  toDiagnosticToken,
} from './title-inference';

test('title-inference smoke', () => {
  assert.equal(
    buildWave1PickText(
      { market_type: 'MONEYLINE', price: 115 },
      { homeTeam: 'Celtics', awayTeam: 'Knicks' },
      'HOME',
    ),
    'Celtics ML +115',
  );
  assert.equal(toDiagnosticToken('fetch_reason', 'TEAM_MAPPING_UNMAPPED'), 'fetch_reason:team_mapping_unmapped');
  assert.equal(
    getPlayWhyCode(
      'BET',
      'TOTAL',
      [{ cardTitle: 'Fragility', note: 'key number risk' }] as never,
      [],
    ),
    'KEY_NUMBER_FRAGILITY_TOTAL',
  );
  assert.deepEqual(getRiskTagsFromText('blowout fragility key number'), [
    'RISK_FRAGILITY',
    'RISK_BLOWOUT',
    'RISK_KEY_NUMBER',
  ]);
  assert.equal(hasPlaceholderText('generic analysis for matchup'), true);
});
