'use strict';

jest.mock('../src/espn-client', () => ({
  fetchTeamSchedule: jest.fn(),
  fetchTeamInfo: jest.fn(),
  fetchTeamStatistics: jest.fn(),
  fetchScoreboardEvents: jest.fn(),
  extractFreeThrowPctFromStatisticsPayload: jest.fn((payload) => {
    if (typeof payload?.__ftPct === 'number') {
      return { freeThrowPct: payload.__ftPct, field: 'mock_ft' };
    }
    return null;
  }),
}));

jest.mock('../src/teamrankings-ft', () => ({
  lookupTeamRankingsFreeThrowPct: jest.fn(() => null),
}));

function loadModules() {
  const espnClient = require('../src/espn-client');
  const teamrankingsFt = require('../src/teamrankings-ft');
  const { getTeamMetricsWithGames } = require('../src/team-metrics');
  return { espnClient, teamrankingsFt, getTeamMetricsWithGames };
}

describe('team-metrics resolution', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('uses static table for known NCAAM team without scoreboard fallback', async () => {
    const { espnClient, getTeamMetricsWithGames } = loadModules();
    espnClient.fetchTeamSchedule.mockResolvedValue([
      { date: '2026-03-01T00:00:00Z', pointsFor: 80, pointsAgainst: 72, result: 'W' }
    ]);
    espnClient.fetchTeamInfo.mockResolvedValue({ rank: 8, record: '23-5' });
    espnClient.fetchTeamStatistics.mockResolvedValue(null);
    espnClient.fetchScoreboardEvents.mockResolvedValue([]);

    const out = await getTeamMetricsWithGames('Duke', 'NCAAM', {
      limit: 3,
      skipCache: true,
      strictVariantMatch: false,
    });

    expect(espnClient.fetchTeamSchedule).toHaveBeenCalledWith(
      'basketball/mens-college-basketball',
      150,
      3
    );
    expect(out.metrics.avgPoints).toBe(80);
    expect(out.metrics.rank).toBe(8);
  });

  test('uses static table for Tulane example game without scoreboard fallback', async () => {
    const { espnClient, getTeamMetricsWithGames } = loadModules();
    espnClient.fetchTeamSchedule.mockResolvedValue([
      { date: '2026-03-04T00:00:00Z', pointsFor: 77, pointsAgainst: 69, result: 'W' }
    ]);
    espnClient.fetchTeamInfo.mockResolvedValue({ rank: null, record: '18-13' });
    espnClient.fetchTeamStatistics.mockResolvedValue({ __ftPct: 75.8 });
    espnClient.fetchScoreboardEvents.mockResolvedValue([]);

    const out = await getTeamMetricsWithGames('Tulane Green Wave', 'NCAAM', {
      limit: 4,
      skipCache: true,
      strictVariantMatch: false,
    });

    expect(espnClient.fetchTeamSchedule).toHaveBeenCalledWith(
      'basketball/mens-college-basketball',
      2655,
      4
    );
    expect(out.metrics.avgPoints).toBe(77);
    expect(out.metrics.freeThrowPct).toBe(75.8);
    expect(out.metrics.freeThrowPctSource).toBe('espn_team_statistics');
  });

  test('resolves unknown NCAAM team via scoreboard fallback', async () => {
    const { espnClient, getTeamMetricsWithGames } = loadModules();
    espnClient.fetchScoreboardEvents.mockResolvedValue([
      {
        competitions: [
          {
            competitors: [
              {
                team: {
                  id: '228',
                  abbreviation: 'CLEM',
                  displayName: 'Clemson Tigers',
                  shortDisplayName: 'Clemson Tigers',
                  location: 'Clemson',
                  name: 'Tigers'
                }
              }
            ]
          }
        ]
      }
    ]);
    espnClient.fetchTeamSchedule.mockResolvedValue([
      { date: '2026-03-01T00:00:00Z', pointsFor: 74, pointsAgainst: 68, result: 'W' }
    ]);
    espnClient.fetchTeamInfo.mockResolvedValue({ rank: 24, record: '19-10' });
    espnClient.fetchTeamStatistics.mockResolvedValue(null);

    const out = await getTeamMetricsWithGames('Clemson Tigers', 'NCAAM', {
      limit: 5,
      skipCache: true,
      strictVariantMatch: false,
    });

    expect(espnClient.fetchTeamSchedule).toHaveBeenCalledWith(
      'basketball/mens-college-basketball',
      '228',
      5
    );
    expect(out.metrics.avgPoints).toBe(74);
    expect(out.metrics.rank).toBe(24);
  });

  test('normalizes "St" -> "State" for scoreboard fallback lookups', async () => {
    const { espnClient, getTeamMetricsWithGames } = loadModules();
    espnClient.fetchScoreboardEvents.mockResolvedValue([
      {
        competitions: [
          {
            competitors: [
              {
                team: {
                  id: '21',
                  abbreviation: 'SDSU',
                  displayName: 'San Diego State Aztecs',
                  shortDisplayName: 'San Diego State',
                  location: 'San Diego State',
                  name: 'Aztecs'
                }
              }
            ]
          }
        ]
      }
    ]);
    espnClient.fetchTeamSchedule.mockResolvedValue([
      { date: '2026-03-02T00:00:00Z', pointsFor: 70, pointsAgainst: 66, result: 'W' }
    ]);
    espnClient.fetchTeamInfo.mockResolvedValue({ rank: null, record: '17-12' });
    espnClient.fetchTeamStatistics.mockResolvedValue(null);

    const out = await getTeamMetricsWithGames('San Diego St Aztecs', 'NCAAM', {
      limit: 4,
      skipCache: true,
      strictVariantMatch: false,
    });

    expect(espnClient.fetchTeamSchedule).toHaveBeenCalledWith(
      'basketball/mens-college-basketball',
      21,
      4
    );
    expect(out.metrics.avgPoints).toBe(70);
  });

  test('uses ESPN team statistics FT% when available', async () => {
    const { espnClient, getTeamMetricsWithGames } = loadModules();
    espnClient.fetchTeamSchedule.mockResolvedValue([
      { date: '2026-03-01T00:00:00Z', pointsFor: 82, pointsAgainst: 71, result: 'W' }
    ]);
    espnClient.fetchTeamInfo.mockResolvedValue({ rank: 5, record: '25-6' });
    espnClient.fetchTeamStatistics.mockResolvedValue({ __ftPct: 78.4 });
    espnClient.fetchScoreboardEvents.mockResolvedValue([]);

    const out = await getTeamMetricsWithGames('Duke', 'NCAAM', {
      limit: 3,
      skipCache: true,
      strictVariantMatch: false,
    });

    expect(out.metrics.freeThrowPct).toBe(78.4);
    expect(out.metrics.freeThrowPctSource).toBe('espn_team_statistics');
  });

  test('falls back to TeamRankings CSV FT% when ESPN stats FT% missing', async () => {
    const { espnClient, teamrankingsFt, getTeamMetricsWithGames } = loadModules();
    espnClient.fetchTeamSchedule.mockResolvedValue([
      { date: '2026-03-01T00:00:00Z', pointsFor: 79, pointsAgainst: 74, result: 'W' }
    ]);
    espnClient.fetchTeamInfo.mockResolvedValue({ rank: 17, record: '21-10' });
    espnClient.fetchTeamStatistics.mockResolvedValue({});
    espnClient.fetchScoreboardEvents.mockResolvedValue([]);
    teamrankingsFt.lookupTeamRankingsFreeThrowPct.mockReturnValue({
      freeThrowPct: 76.8,
      source: 'teamrankings_csv',
      season: '2025-26',
      sourceUpdatedAt: '2026-03-10T00:00:00Z',
    });

    const out = await getTeamMetricsWithGames('Duke', 'NCAAM', {
      limit: 3,
      skipCache: true,
      strictVariantMatch: false,
    });

    expect(out.metrics.freeThrowPct).toBe(76.8);
    expect(out.metrics.freeThrowPctSource).toBe('teamrankings_csv');
  });
});
