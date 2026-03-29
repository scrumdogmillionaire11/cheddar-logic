import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isExplicitNoEdgeReasonCode,
  isFetchFailureReasonCode,
  normalizePassReasonCode,
} from './reason-codes';

test('reason-codes smoke', () => {
  assert.equal(normalizePassReasonCode('missing_edge'), 'PASS_MISSING_EDGE');
  assert.equal(isFetchFailureReasonCode('TEAM_MAPPING_UNMAPPED'), true);
  assert.equal(isExplicitNoEdgeReasonCode('PASS_NO_EDGE'), true);
});
