/**
 * Regression test: stable game IDs across repeated ingest runs.
 * Seeds a fixed normalized payload for 2 games, runs ingest logic twice,
 * asserts game IDs are identical. No network. Pure deterministic.
 */
'use strict';

jest.mock('@cheddar-logic/odds', () => ({
  fetchOdds: jest.fn(),
  getActiveSports: jest.fn(() => ['NHL']),
  getTokensForFetch: jest.fn(() => 2)
}));

jest.mock('@cheddar-logic/data', () => ({
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  shouldRunJobKey: jest.fn().mockReturnValue(true),
  upsertGame: jest.fn(),
  insertOddsSnapshot: jest.fn(),
  withDb: jest.fn(async (fn) => fn())
}));

const { fetchOdds } = require('@cheddar-logic/odds');
const { upsertGame } = require('@cheddar-logic/data');
const { pullOddsHourly } = require('../jobs/pull_odds_hourly');

const FIXED_GAMES = [
  {
    games: [
      {
        gameId: 'fixed-game-001',
        sport: 'NHL',
        homeTeam: 'Toronto Maple Leafs',
        awayTeam: 'Montreal Canadiens',
        gameTimeUtc: '2026-03-01T00:00:00Z',
        capturedAtUtc: '2026-02-27T12:00:00Z',
        market: {},
        odds: { h2hHome: -150, h2hAway: 130, total: 6.0, spreadHome: -1.5, spreadAway: 1.5, monelineHome: -150, monelineAway: 130 }
      },
      {
        gameId: 'fixed-game-002',
        sport: 'NHL',
        homeTeam: 'Boston Bruins',
        awayTeam: 'Tampa Bay Lightning',
        gameTimeUtc: '2026-03-01T02:00:00Z',
        capturedAtUtc: '2026-02-27T12:00:00Z',
        market: {},
        odds: { h2hHome: -120, h2hAway: 100, total: 5.5, spreadHome: -1.5, spreadAway: 1.5, monelineHome: -120, monelineAway: 100 }
      }
    ],
    errors: [],
    rawCount: 2
  }
];

function mockFetchOddsForSport(sport) {
  if (sport === 'NHL') return FIXED_GAMES[0];
  return { games: [], errors: [], rawCount: 0 };
}

describe('Stable Game IDs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetchOdds.mockImplementation(({ sport }) => Promise.resolve(mockFetchOddsForSport(sport)));
  });

  test('game IDs are identical across two sequential ingest runs', async () => {
    // Run 1
    await pullOddsHourly({ jobKey: 'test-run-1' });
    const firstRunCalls = upsertGame.mock.calls.map(call => call[0].id);

    jest.clearAllMocks();
    fetchOdds.mockImplementation(({ sport }) => Promise.resolve(mockFetchOddsForSport(sport)));
    // Re-enable shouldRunJobKey for second run
    require('@cheddar-logic/data').shouldRunJobKey.mockReturnValue(true);

    // Run 2
    await pullOddsHourly({ jobKey: 'test-run-2' });
    const secondRunCalls = upsertGame.mock.calls.map(call => call[0].id);

    // Filter to only NHL games
    const firstNHL = firstRunCalls.filter(id => id.startsWith('game-nhl-'));
    const secondNHL = secondRunCalls.filter(id => id.startsWith('game-nhl-'));

    expect(firstNHL.length).toBe(2);
    expect(secondNHL.length).toBe(2);
    expect(firstNHL.sort()).toEqual(secondNHL.sort());
    expect(firstNHL).toContain('game-nhl-fixed-game-001');
    expect(firstNHL).toContain('game-nhl-fixed-game-002');
  });

  test('game ID format is game-{sport-lower}-{gameId}', async () => {
    await pullOddsHourly({ jobKey: 'test-format-check' });
    const ids = upsertGame.mock.calls.map(call => call[0].id);
    const nhlIds = ids.filter(id => id.startsWith('game-nhl-'));
    nhlIds.forEach(id => {
      expect(id).toMatch(/^game-nhl-[a-z0-9-]+$/);
    });
  });
});
