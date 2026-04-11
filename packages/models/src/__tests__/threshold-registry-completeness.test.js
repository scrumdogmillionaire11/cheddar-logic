'use strict';

const {
  SPORT_MARKET_THRESHOLDS_V2,
} = require('../decision-pipeline-v2-edge-config');

const SUPPORTED_THRESHOLD_KEYS = [
  'NBA:MONEYLINE',
  'NBA:SPREAD',
  'NBA:TOTAL',
  'NHL:MONEYLINE',
  'NHL:SPREAD',
  'NHL:TOTAL',
  'NHL:PUCKLINE',
  'NHL:FIRST_PERIOD',
];

describe('threshold registry completeness', () => {
  test.each(SUPPORTED_THRESHOLD_KEYS)('%s has an explicit threshold profile', (key) => {
    const profile = SPORT_MARKET_THRESHOLDS_V2[key];

    expect(profile).toBeTruthy();
    expect(typeof profile.edge.play_edge_min).toBe('number');
    expect(typeof profile.edge.lean_edge_min).toBe('number');
    expect(profile.edge.play_edge_min).toBeGreaterThan(profile.edge.lean_edge_min);
    expect(typeof profile.support.play).toBe('number');
    expect(typeof profile.support.lean).toBe('number');
  });
});
