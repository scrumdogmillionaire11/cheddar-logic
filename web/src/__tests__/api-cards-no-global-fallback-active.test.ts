import assert from 'node:assert';

import { shouldApplyGlobalRunFallback } from '../lib/runtime-decision-authority';

assert.strictEqual(
  shouldApplyGlobalRunFallback('active'),
  false,
  'active lifecycle mode must be fail-closed (no global fallback)',
);

assert.strictEqual(
  shouldApplyGlobalRunFallback('pregame'),
  true,
  'pregame lifecycle mode may use global fallback for rollback compatibility',
);

console.log('API cards [gameId] active fallback behavior tests passed');
