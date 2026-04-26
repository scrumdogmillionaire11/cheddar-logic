import assert from 'node:assert';

import { resolvePlayDisplayDecision } from '../lib/game-card/decision';

{
  const resolved = resolvePlayDisplayDecision({
    action: 'FIRE',
    classification: 'BASE',
    decision_v2: {
      official_status: 'PLAY',
      canonical_envelope_v2: {
        official_status: 'PASS',
      },
    },
    final_market_decision: {
      surfaced_status: 'PLAY',
    } as never,
  });

  assert.strictEqual(resolved.action, 'PASS');
  assert.strictEqual(resolved.status, 'PASS');
  assert.strictEqual(resolved.classification, 'PASS');
}

{
  const resolved = resolvePlayDisplayDecision({
    action: 'FIRE',
    classification: 'BASE',
    decision_v2: {
      official_status: 'PLAY',
    },
  });

  // Missing canonical envelope falls back to existing display behavior.
  assert.strictEqual(resolved.action, 'FIRE');
}

{
  const resolved = resolvePlayDisplayDecision({
    action: 'HOLD',
    classification: 'LEAN',
  });

  // Legacy rows without decision_v2 keep compatibility behavior.
  assert.strictEqual(resolved.action, 'HOLD');
}

console.log('Decision authority single-source tests passed');
