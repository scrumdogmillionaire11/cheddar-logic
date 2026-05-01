'use strict';

const {
  PROMOTION_MARKET_THRESHOLDS_V2,
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
const SUPPORTED_PROMOTION_KEYS = [
  'NBA:SPREAD',
  'NBA:TOTAL',
  'NHL:MONEYLINE',
  'NHL:TOTAL',
  'MLB:MONEYLINE',
  'MLB:TOTAL',
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

  test.each(SUPPORTED_PROMOTION_KEYS)('%s has an explicit promotion profile', (key) => {
    const profile = PROMOTION_MARKET_THRESHOLDS_V2[key];

    expect(profile).toBeTruthy();
    expect(typeof profile.edge).toBe('number');
    expect(profile.edge).toBeGreaterThan(0);
    expect(typeof profile.support).toBe('number');
    expect(profile.support).toBeGreaterThan(0);
  });
});
