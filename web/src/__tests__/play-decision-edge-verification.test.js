/*
 * Behavioral tests for edge-verification signal detection in decision-logic.ts.
 * Run: node --import tsx/esm web/src/__tests__/play-decision-edge-verification.test.js
 */

import assert from 'node:assert';

import {
  EDGE_VERIFICATION_TAG,
  EDGE_SANITY_GATE_CODE,
  hasEdgeVerificationSignals,
} from '../lib/play-decision/decision-logic';

console.log('🧪 Play decision edge-verification behavioral tests');

// EDGE_VERIFICATION_TAG value
assert.equal(
  EDGE_VERIFICATION_TAG,
  'LINE_NOT_CONFIRMED',
  'EDGE_VERIFICATION_TAG must equal LINE_NOT_CONFIRMED',
);

// hasEdgeVerificationSignals — returns true when tag is present
assert.equal(
  hasEdgeVerificationSignals({ tags: ['LINE_NOT_CONFIRMED'] }),
  true,
  'hasEdgeVerificationSignals: LINE_NOT_CONFIRMED tag returns true',
);

// hasEdgeVerificationSignals — returns false with unrelated tags
assert.equal(
  hasEdgeVerificationSignals({ tags: ['EDGE_CLEAR'] }),
  false,
  'hasEdgeVerificationSignals: unrelated tag returns false',
);

// BLOCKED_BET_VERIFICATION_REQUIRED in price_reason_codes triggers signal
assert.equal(
  hasEdgeVerificationSignals({
    decision_v2: { price_reason_codes: ['BLOCKED_BET_VERIFICATION_REQUIRED'] },
  }),
  true,
  'hasEdgeVerificationSignals: BLOCKED_BET_VERIFICATION_REQUIRED in price_reason_codes returns true',
);

// BLOCKED_BET_VERIFICATION_REQUIRED in reason_codes triggers signal
assert.equal(
  hasEdgeVerificationSignals({ reason_codes: ['BLOCKED_BET_VERIFICATION_REQUIRED'] }),
  true,
  'hasEdgeVerificationSignals: BLOCKED_BET_VERIFICATION_REQUIRED in reason_codes returns true',
);

// EDGE_SANITY_GATE_CODE in gates triggers signal
assert.equal(
  hasEdgeVerificationSignals({ gates: [{ code: EDGE_SANITY_GATE_CODE }] }),
  true,
  'hasEdgeVerificationSignals: gate with EDGE_SANITY_GATE_CODE returns true',
);

// Gate with a different code does not trigger signal
assert.equal(
  hasEdgeVerificationSignals({ gates: [{ code: 'PROXY_CAP' }] }),
  false,
  'hasEdgeVerificationSignals: gate with unrelated code returns false',
);

// null/undefined play returns false
assert.equal(hasEdgeVerificationSignals(null), false, 'null play returns false');
assert.equal(hasEdgeVerificationSignals(undefined), false, 'undefined play returns false');

console.log('✅ Play decision edge-verification behavioral tests passed');
