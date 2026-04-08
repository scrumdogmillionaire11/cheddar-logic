'use strict';

jest.mock('@cheddar-logic/data', () => ({
  getDatabase: jest.fn(),
}));

const { getDatabase } = require('@cheddar-logic/data');
const { daysBetween, computeRestDays } = require('../rest-days');

describe('daysBetween', () => {
  it('back-to-back (< 24 h gap) yields 0', () => {
    expect(daysBetween('2024-04-07T19:00:00Z', '2024-04-07T22:00:00Z')).toBe(0);
  });

  it('50 h gap yields 2', () => {
    expect(daysBetween('2024-04-05T00:00:00Z', '2024-04-07T02:00:00Z')).toBe(2);
  });

  it('96 h gap is capped at 3 (well-rested plateau)', () => {
    expect(daysBetween('2024-04-03T00:00:00Z', '2024-04-07T00:00:00Z')).toBe(3);
  });

  it('120 h gap is still capped at 3', () => {
    expect(daysBetween('2024-04-02T00:00:00Z', '2024-04-07T00:00:00Z')).toBe(3);
  });
});

describe('computeRestDays', () => {
  let mockGet;

  beforeEach(() => {
    mockGet = jest.fn();
    getDatabase.mockReturnValue({
      prepare: jest.fn(() => ({ get: mockGet })),
    });
  });

  afterEach(() => { jest.clearAllMocks(); });

  it('returns default when no prior game found', () => {
    mockGet.mockReturnValue(null);
    const result = computeRestDays('Boston Celtics', 'nba', '2024-04-08T00:00:00Z');
    expect(result).toEqual({ restDays: 1, restSource: 'default' });
  });

  it('returns restDays=0 and restSource=computed for back-to-back', () => {
    mockGet.mockReturnValue({ game_time_utc: '2024-04-07T22:00:00Z' });
    const result = computeRestDays('Boston Celtics', 'nba', '2024-04-08T01:00:00Z');
    expect(result).toEqual({ restDays: 0, restSource: 'computed' });
  });

  it('returns restDays=2 for 50 h gap', () => {
    mockGet.mockReturnValue({ game_time_utc: '2024-04-05T00:00:00Z' });
    const result = computeRestDays('Boston Celtics', 'nba', '2024-04-07T02:00:00Z');
    expect(result).toEqual({ restDays: 2, restSource: 'computed' });
  });

  it('returns restDays=3 (cap hit) for 96 h+ gap', () => {
    mockGet.mockReturnValue({ game_time_utc: '2024-04-03T00:00:00Z' });
    const result = computeRestDays('Boston Celtics', 'nba', '2024-04-07T00:00:00Z');
    expect(result).toEqual({ restDays: 3, restSource: 'computed' });
  });
});
