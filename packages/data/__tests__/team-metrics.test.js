'use strict';

const {
  computeMetricsFromGames,
  __testables,
} = require('../src/team-metrics');

const { finalizeNbaImpactContext } = __testables;
const TEAM_METRICS_SRC = '../src/team-metrics';
const ESPN_CLIENT_SRC = '../src/espn-client';

function makeTeamSchedule() {
  return [
    { date: '2026-03-01T00:00:00Z', pointsFor: 118, pointsAgainst: 110, result: 'W' },
    { date: '2026-03-03T00:00:00Z', pointsFor: 112, pointsAgainst: 106, result: 'W' },
    { date: '2026-03-05T00:00:00Z', pointsFor: 108, pointsAgainst: 101, result: 'W' },
    { date: '2026-03-07T00:00:00Z', pointsFor: 116, pointsAgainst: 109, result: 'W' },
    { date: '2026-03-09T00:00:00Z', pointsFor: 120, pointsAgainst: 114, result: 'W' },
  ];
}

function makePlayerGameLog(points, starts) {
  const events = {};
  points.forEach((pts, index) => {
    const day = String(index + 1).padStart(2, '0');
    events[String(index + 1)] = {
      date: `2026-03-${day}T00:00:00Z`,
      stats: [pts, starts[index] ? 1 : 0],
    };
  });

  return {
    labels: ['PTS', 'GS'],
    events,
  };
}

function makeInjuryAthlete({ playerId, playerName, teamAbbr }) {
  return {
    id: String(playerId),
    status: 'Out',
    shortComment: `${playerName} unavailable`,
    athlete: {
      displayName: playerName,
      links: [
        {
          href: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/athletes/${playerId}/${playerName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        },
      ],
      team: { abbreviation: teamAbbr },
    },
  };
}

async function loadTeamMetricsWithEspnMocks({
  injuriesPayload,
  gameLogsByPlayerId = {},
  teamName = 'Boston Celtics',
  teamInfo = {
    id: 2,
    name: 'Boston Celtics',
    abbreviation: 'BOS',
    rank: 1,
    record: '50-10',
  },
  teamSchedule = makeTeamSchedule(),
} = {}) {
  jest.resetModules();
  const actualEspnClient = jest.requireActual(ESPN_CLIENT_SRC);

  jest.doMock(ESPN_CLIENT_SRC, () => ({
    ...actualEspnClient,
    fetchTeamSchedule: jest.fn(async () => teamSchedule),
    fetchTeamInfo: jest.fn(async () => teamInfo),
    fetchTeamStatistics: jest.fn(async () => null),
    fetchScoreboardEvents: jest.fn(async () => []),
    fetchNbaInjuries: jest.fn(async () => injuriesPayload),
    fetchNbaPlayerGameLog: jest.fn(async (playerId) => gameLogsByPlayerId[playerId] || null),
  }));

  jest.doMock('../src/db', () => ({
    getTeamMetricsCache: jest.fn(() => null),
    upsertTeamMetricsCache: jest.fn(() => null),
  }));

  jest.doMock('../src/teamrankings-ft', () => ({
    lookupTeamRankingsFreeThrowPct: jest.fn(() => null),
  }));

  const { getTeamMetricsWithGames } = require(TEAM_METRICS_SRC);
  return getTeamMetricsWithGames(teamName, 'NBA', {
    includeImpactContext: true,
    skipCache: true,
  });
}

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
      record: null,
      freeThrowPct: null,
      freeThrowPctSource: null,
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

  test('finalizeNbaImpactContext marks OUT starter as impact player', () => {
    const context = finalizeNbaImpactContext([
      {
        playerId: '201939',
        playerName: 'Stephen Curry',
        teamAbbr: 'GS',
        rawStatus: 'OUT',
        avgPointsLast5: 29.4,
        startsLast5: 5,
      },
      {
        playerId: '123',
        playerName: 'Rotation Wing',
        teamAbbr: 'GS',
        rawStatus: 'OUT',
        avgPointsLast5: 7.1,
        startsLast5: 1,
      },
      {
        playerId: '456',
        playerName: 'Bench Guard',
        teamAbbr: 'GS',
        rawStatus: 'OUT',
        avgPointsLast5: 21.0,
        startsLast5: 0,
      },
      {
        playerId: '789',
        playerName: 'Role Center',
        teamAbbr: 'GS',
        rawStatus: 'OUT',
        avgPointsLast5: 18.0,
        startsLast5: 0,
      },
    ]);

    expect(context.available).toBe(true);
    const curry = context.players.find((player) => player.playerId === '201939');
    expect(curry.isStarter).toBe(true);
    expect(curry.isTopScorer).toBe(true);
    expect(curry.isImpactPlayer).toBe(true);
    expect(curry.impactReasons).toEqual(['starter', 'top_3_scorer']);

    const bench = context.players.find((player) => player.playerId === '123');
    expect(bench.isStarter).toBe(false);
    expect(bench.isTopScorer).toBe(false);
    expect(bench.isImpactPlayer).toBe(false);
  });

  test('finalizeNbaImpactContext only flags the top three injured scorers', () => {
    const context = finalizeNbaImpactContext([
      {
        playerId: '1',
        playerName: 'Alpha',
        teamAbbr: 'BOS',
        rawStatus: 'OUT',
        avgPointsLast5: 24.0,
        startsLast5: 0,
      },
      {
        playerId: '2',
        playerName: 'Bravo',
        teamAbbr: 'BOS',
        rawStatus: 'DOUBTFUL',
        avgPointsLast5: 18.0,
        startsLast5: 0,
      },
      {
        playerId: '3',
        playerName: 'Charlie',
        teamAbbr: 'BOS',
        rawStatus: 'OUT',
        avgPointsLast5: 12.0,
        startsLast5: 0,
      },
      {
        playerId: '4',
        playerName: 'Delta',
        teamAbbr: 'BOS',
        rawStatus: 'OUT',
        avgPointsLast5: 10.0,
        startsLast5: 0,
      },
    ]);

    const topPlayers = context.players.filter((player) => player.isTopScorer);
    expect(topPlayers.map((player) => player.playerId)).toEqual(['1', '2', '3']);
    expect(context.players.find((player) => player.playerId === '4').isTopScorer).toBe(false);
  });

  test('finalizeNbaImpactContext fails open when impact context is unavailable', () => {
    const context = finalizeNbaImpactContext([], { available: false });
    expect(context.available).toBe(false);
    expect(context.players).toEqual([]);
  });

  test('getTeamMetricsWithGames derives impactContext from ESPN injury feed for a starter OUT', async () => {
    const impactContextResult = await loadTeamMetricsWithEspnMocks({
      injuriesPayload: {
        injuries: [
          {
            displayName: 'Boston Celtics',
            injuries: [
              makeInjuryAthlete({ playerId: 0, playerName: 'Jayson Tatum', teamAbbr: 'BOS' }),
              makeInjuryAthlete({ playerId: 1, playerName: 'Player One', teamAbbr: 'BOS' }),
              makeInjuryAthlete({ playerId: 2, playerName: 'Player Two', teamAbbr: 'BOS' }),
              makeInjuryAthlete({ playerId: 3, playerName: 'Player Three', teamAbbr: 'BOS' }),
            ],
          },
        ],
      },
      gameLogsByPlayerId: {
        0: makePlayerGameLog([14, 15, 13, 16, 12], [1, 1, 1, 1, 1]),
        1: makePlayerGameLog([24, 23, 25, 22, 24], [0, 0, 0, 0, 0]),
        2: makePlayerGameLog([21, 22, 20, 19, 23], [0, 0, 0, 0, 0]),
        3: makePlayerGameLog([18, 17, 19, 20, 16], [0, 0, 0, 0, 0]),
      },
    });

    expect(impactContextResult.impactContext.available).toBe(true);
    const tatum = impactContextResult.impactContext.players.find((player) => player.playerName === 'Jayson Tatum');
    expect(tatum).toBeDefined();
    expect(tatum.rawStatus).toBe('OUT');
    expect(tatum.isStarter).toBe(true);
    expect(tatum.isTopScorer).toBe(false);
    expect(tatum.isImpactPlayer).toBe(true);
    expect(tatum.impactReasons).toEqual(['starter']);
  });

  test('getTeamMetricsWithGames returns empty impactContext when ESPN injury feed has no injuries', async () => {
    const impactContextResult = await loadTeamMetricsWithEspnMocks({
      injuriesPayload: {
        injuries: [
          {
            displayName: 'Boston Celtics',
            injuries: [],
          },
        ],
      },
    });

    expect(impactContextResult.impactContext.available).toBe(true);
    expect(impactContextResult.impactContext.players).toEqual([]);
  });
});
