'use strict';

jest.mock('../src/espn-client', () => ({
  fetchTeamSchedule: jest.fn(),
  fetchTeamInfo: jest.fn(),
  fetchScoreboardEvents: jest.fn()
}));

function loadModules() {
  const espnClient = require('../src/espn-client');
  const { getTeamMetricsWithGames } = require('../src/team-metrics');
  return { espnClient, getTeamMetricsWithGames };
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
    espnClient.fetchScoreboardEvents.mockResolvedValue([]);

    const out = await getTeamMetricsWithGames('Duke', 'NCAAM', { limit: 3 });

    expect(espnClient.fetchTeamSchedule).toHaveBeenCalledWith(
      'basketball/mens-college-basketball',
      150,
      3
    );
    expect(espnClient.fetchScoreboardEvents).not.toHaveBeenCalled();
    expect(out.metrics.avgPoints).toBe(80);
    expect(out.metrics.rank).toBe(8);
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

    const out = await getTeamMetricsWithGames('Clemson Tigers', 'NCAAM', { limit: 5 });

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

    const out = await getTeamMetricsWithGames('San Diego St Aztecs', 'NCAAM', { limit: 4 });

    expect(espnClient.fetchTeamSchedule).toHaveBeenCalledWith(
      'basketball/mens-college-basketball',
      21,
      4
    );
    expect(out.metrics.avgPoints).toBe(70);
  });
});
