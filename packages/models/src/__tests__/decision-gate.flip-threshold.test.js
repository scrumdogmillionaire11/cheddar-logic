'use strict';

const {
  CANONICAL_EDGE_CONTRACT,
  shouldFlip,
} = require('../decision-gate');

describe('decision gate flip threshold', () => {
  test('EDGE_UPGRADE_MIN is calibrated to a realistic decimal edge delta', () => {
    expect(CANONICAL_EDGE_CONTRACT.upgrade_min).toBe(0.04);
    expect(CANONICAL_EDGE_CONTRACT.upgrade_min).toBeLessThan(0.2);
  });

  test('shouldFlip allows a four-point edge improvement', () => {
    const result = shouldFlip(
      { edge: 0.02, recommended_side: 'HOME', price: -110 },
      { edge: 0.06, side: 'AWAY', price: -110 },
      { candidateSeenCount: 2 },
    );

    expect(result.allow).toBe(true);
    expect(result.reason_code).toBe('EDGE_UPGRADE');
  });

  test('shouldFlip blocks a one-point edge improvement', () => {
    const result = shouldFlip(
      { edge: 0.02, recommended_side: 'HOME', price: -110 },
      { edge: 0.03, side: 'AWAY', price: -110 },
      { candidateSeenCount: 2 },
    );

    expect(result.allow).toBe(false);
    expect(result.reason_code).toBe('EDGE_TOO_SMALL');
  });
});
