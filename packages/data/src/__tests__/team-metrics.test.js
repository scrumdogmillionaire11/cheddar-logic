'use strict';

const { computeMetricsFromGames } = require('../team-metrics');

describe('team-metrics core computations', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns the neutral contract for empty game arrays', () => {
    expect(computeMetricsFromGames([], 'NBA')).toEqual({
      avgPoints: null,
      avgPointsAllowed: null,
      netRating: null,
      restDays: null,
      form: 'Unknown',
      pace: null,
      freeThrowPct: null,
      freeThrowPctSource: null,
      rank: null,
      record: null,
      espn_null_reason: 'NO_GAMES',
    });
  });

  test('computes average scoring, net rating, pace, form, and rest days for NBA fixtures', () => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-01-07T00:00:00Z').getTime());

    const games = [
      { date: '2026-01-01T00:00:00Z', pointsFor: 100, pointsAgainst: 90, result: 'W' },
      { date: '2026-01-03T00:00:00Z', pointsFor: 110, pointsAgainst: 120, result: 'L' },
      { date: '2026-01-05T00:00:00Z', pointsFor: 95, pointsAgainst: 85, result: 'W' },
    ];

    const metrics = computeMetricsFromGames(games, 'NBA');

    expect(metrics.avgPoints).toBeCloseTo(305 / 3, 10);
    expect(metrics.avgPointsAllowed).toBeCloseTo(295 / 3, 10);
    expect(metrics.netRating).toBeCloseTo(10 / 3, 10);
    expect(metrics).toMatchObject({
      restDays: 2,
      form: 'WLW',
      pace: 93.5,
      freeThrowPct: null,
      freeThrowPctSource: null,
      rank: null,
      record: null,
    });
  });

  test('ignores null scoring fields instead of throwing and still computes from valid games', () => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-02-06T00:00:00Z').getTime());

    const games = [
      { date: '2026-02-01T00:00:00Z', pointsFor: 88, pointsAgainst: 80, result: 'W' },
      { date: '2026-02-03T00:00:00Z', pointsFor: null, pointsAgainst: 76, result: 'L' },
      { date: '2026-02-05T00:00:00Z', pointsFor: 92, pointsAgainst: 89, result: 'W' },
    ];

    expect(computeMetricsFromGames(games, 'NCAAM')).toEqual({
      avgPoints: 90,
      avgPointsAllowed: 84.5,
      netRating: 5.5,
      restDays: 1,
      form: 'WLW',
      pace: 82.8,
      freeThrowPct: null,
      freeThrowPctSource: null,
      rank: null,
      record: null,
    });
  });

  test('returns neutral metrics when every game is missing scoring data', () => {
    const games = [
      { date: '2026-03-01T00:00:00Z', pointsFor: null, pointsAgainst: 70, result: 'L' },
      { date: '2026-03-03T00:00:00Z', pointsFor: 72, pointsAgainst: null, result: 'W' },
    ];

    expect(computeMetricsFromGames(games, 'NBA')).toEqual({
      avgPoints: null,
      avgPointsAllowed: null,
      netRating: null,
      restDays: null,
      form: 'Unknown',
      pace: null,
      freeThrowPct: null,
      freeThrowPctSource: null,
      rank: null,
      record: null,
      espn_null_reason: 'NO_SCORED_GAMES',
    });
  });

  test('adds NHL-specific goal aliases and omits pace', () => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-03-10T00:00:00Z').getTime());

    const games = [
      { date: '2026-03-06T00:00:00Z', pointsFor: 4, pointsAgainst: 2, result: 'W' },
      { date: '2026-03-08T00:00:00Z', pointsFor: 3, pointsAgainst: 5, result: 'L' },
    ];

    expect(computeMetricsFromGames(games, 'NHL')).toEqual({
      avgPoints: 3.5,
      avgPointsAllowed: 3.5,
      netRating: 0,
      restDays: 2,
      form: 'WL',
      pace: null,
      freeThrowPct: null,
      freeThrowPctSource: null,
      rank: null,
      record: null,
      avgGoalsFor: 3.5,
      avgGoalsAgainst: 3.5,
    });
  });
});
