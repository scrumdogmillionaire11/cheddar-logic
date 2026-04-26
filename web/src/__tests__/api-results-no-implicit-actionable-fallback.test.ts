import assert from 'node:assert';

import { hasActionableProjectionCall } from '../app/api/results/projection-metrics';

{
  const payload = {
    action: 'FIRE',
    play: { action: 'FIRE' },
  } as Record<string, unknown>;

  // No canonical or decision_v2 official status -> fail closed
  assert.strictEqual(hasActionableProjectionCall(payload), false);
}

{
  const payload = {
    decision_v2: {
      canonical_envelope_v2: {
        official_status: 'PLAY',
      },
    },
  } as Record<string, unknown>;

  assert.strictEqual(hasActionableProjectionCall(payload), true);
}

{
  const payload = {
    decision_v2: {
      canonical_envelope_v2: {
        official_status: 'PASS',
      },
    },
  } as Record<string, unknown>;

  assert.strictEqual(hasActionableProjectionCall(payload), false);
}

console.log('API results no implicit actionable fallback tests passed');
