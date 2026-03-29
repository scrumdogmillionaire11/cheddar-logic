import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getSourcePlayAction,
  getSportCardTypeContract,
  isEvidenceItem,
  isPlayItem,
  resolveSourceModelProb,
} from './legacy-repair';

test('legacy-repair smoke', () => {
  assert.ok(getSportCardTypeContract('NHL'));
  assert.equal(
    isPlayItem(
      {
        cardType: 'nhl-totals-call',
        cardTitle: 'NHL totals',
        prediction: 'OVER',
        confidence: 0.7,
        tier: 'BEST',
        reasoning: 'edge',
        evPassed: true,
        driverKey: 'nhl',
        kind: 'PLAY',
      },
      'NHL',
    ),
    true,
  );
  assert.equal(
    isEvidenceItem(
      {
        cardType: 'nhl-model-output',
        cardTitle: 'NHL model',
        prediction: 'OVER',
        confidence: 0.7,
        tier: 'WATCH',
        reasoning: 'context',
        evPassed: true,
        driverKey: 'nhl',
        kind: 'EVIDENCE',
      },
      'NHL',
    ),
    true,
  );
  assert.equal(
    getSourcePlayAction({ action: 'FIRE', cardType: 'x', cardTitle: 'x', prediction: 'HOME', confidence: 1, tier: 'BEST', reasoning: 'x', evPassed: true, driverKey: 'x' }),
    'FIRE',
  );
  assert.equal(resolveSourceModelProb({ model_prob: 0.62 } as never), 0.62);
});
