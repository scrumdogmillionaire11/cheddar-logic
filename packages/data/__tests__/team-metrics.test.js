'use strict';

const { computeMetricsFromGames } = require('../src/team-metrics');

describe('team-metrics', () => {
  test('computeMetricsFromGames returns neutral for empty input', () => {
    const metrics = computeMetricsFromGames([], 'NBA');
    expect(metrics).toEqual({
      avgPoints: null,
      avgPointsAllowed: null,
      netRating: null,
      restDays: null,
      form: 'Unknown',
      pace: null,
      rank: null,
      record: null
    });
  });

  test('computeMetricsFromGames computes averages and pace', () => {
    const games = [
      { date: '2026-01-01T00:00:00Z', pointsFor: 100, pointsAgainst: 90, result: 'W' },
      { date: '2026-01-03T00:00:00Z', pointsFor: 110, pointsAgainst: 120, result: 'L' }
    ];

    const metrics = computeMetricsFromGames(games, 'NBA');

    expect(metrics.avgPoints).toBeCloseTo(105, 5);
    expect(metrics.avgPointsAllowed).toBeCloseTo(105, 5);
    expect(metrics.netRating).toBeCloseTo(0, 5);
    expect(metrics.form).toBe('WL');
    expect(metrics.pace).toBeCloseTo(96.6, 1);
    expect(metrics.rank).toBeNull();
    expect(metrics.record).toBeNull();
    expect(typeof metrics.restDays).toBe('number');
    expect(metrics.restDays).toBeGreaterThanOrEqual(0);
  });
});
