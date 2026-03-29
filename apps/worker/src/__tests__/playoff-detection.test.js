'use strict';

const {
  isPlayoffGame,
  PLAYOFF_SIGMA_MULTIPLIER,
  PLAYOFF_EDGE_MIN_INCREMENT,
  PLAYOFF_PACE_WEIGHT_CAP,
} = require('../utils/playoff-detection');

describe('isPlayoffGame', () => {
  test('returns true when raw_data.season.type === 3', () => {
    expect(isPlayoffGame({ raw_data: { season: { type: 3 } } })).toBe(true);
  });

  test('returns true when raw_data.gameType === "P"', () => {
    expect(isPlayoffGame({ raw_data: { gameType: 'P' } })).toBe(true);
  });

  test('returns false when raw_data.season.type === 2 (regular season)', () => {
    expect(isPlayoffGame({ raw_data: { season: { type: 2 } } })).toBe(false);
  });

  test('returns false when raw_data is empty object', () => {
    expect(isPlayoffGame({ raw_data: {} })).toBe(false);
  });

  test('returns false when oddsSnapshot is null', () => {
    expect(isPlayoffGame(null)).toBe(false);
  });

  test('returns false when oddsSnapshot is empty object (no raw_data)', () => {
    expect(isPlayoffGame({})).toBe(false);
  });

  test('returns false when raw_data is not an object', () => {
    expect(isPlayoffGame({ raw_data: 'not-an-object' })).toBe(false);
  });
});

describe('exported constants', () => {
  test('PLAYOFF_SIGMA_MULTIPLIER is 1.2', () => {
    expect(PLAYOFF_SIGMA_MULTIPLIER).toBe(1.2);
  });

  test('PLAYOFF_EDGE_MIN_INCREMENT is 0.01', () => {
    expect(PLAYOFF_EDGE_MIN_INCREMENT).toBe(0.01);
  });

  test('PLAYOFF_PACE_WEIGHT_CAP is 0.5', () => {
    expect(PLAYOFF_PACE_WEIGHT_CAP).toBe(0.5);
  });
});
