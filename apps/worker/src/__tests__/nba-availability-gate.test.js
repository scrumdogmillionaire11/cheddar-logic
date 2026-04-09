'use strict';

/**
 * WI-0841: NBA impact-context gate tests.
 *
 * Tests:
 *  1. ESPN injury feed with starter OUT → tier capped at LEAN, key_player_out emitted
 *  2. ESPN injury feed with no injuries → no downgrade
 */

const assert = require('assert');
const {
  buildNbaAvailabilityGate,
  applyNbaImpactGateToCard,
} = require('../jobs/run_nba_model');

const DATA_TEAM_METRICS_PATH = '../../../../packages/data/src/team-metrics';
const DATA_ESPN_CLIENT_PATH = '../../../../packages/data/src/espn-client';

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

async function loadImpactContextFromEspnFixtures({
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
  const actualEspnClient = jest.requireActual(DATA_ESPN_CLIENT_PATH);

  jest.doMock(DATA_ESPN_CLIENT_PATH, () => ({
    ...actualEspnClient,
    fetchTeamSchedule: jest.fn(async () => teamSchedule),
    fetchTeamInfo: jest.fn(async () => teamInfo),
    fetchTeamStatistics: jest.fn(async () => null),
    fetchScoreboardEvents: jest.fn(async () => []),
    fetchNbaInjuries: jest.fn(async () => injuriesPayload),
    fetchNbaPlayerGameLog: jest.fn(async (playerId) => gameLogsByPlayerId[playerId] || null),
  }));

  jest.doMock('../../../../packages/data/src/db', () => ({
    getTeamMetricsCache: jest.fn(() => null),
    upsertTeamMetricsCache: jest.fn(() => null),
  }));

  jest.doMock('../../../../packages/data/src/teamrankings-ft', () => ({
    lookupTeamRankingsFreeThrowPct: jest.fn(() => null),
  }));

  const { getTeamMetricsWithGames } = require(DATA_TEAM_METRICS_PATH);
  const result = await getTeamMetricsWithGames(teamName, 'NBA', {
    includeImpactContext: true,
    skipCache: true,
  });

  return result.impactContext;
}

function makeCard(tier = 'FIRE') {
  return {
    cardType: 'nba-base-projection',
    payloadData: {
      tier,
      prediction: 'over 220.5',
      confidence: 0.62,
      missing_inputs: [],
      raw_data: {},
    },
  };
}

describe('nba-impact-gate', () => {
  test('ESPN injury feed with starter OUT caps tier at LEAN', async () => {
    const impactContext = await loadImpactContextFromEspnFixtures({
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

    assert.ok(impactContext);
    const tatum = impactContext.players.find((player) => player.playerName === 'Jayson Tatum');
    assert.ok(tatum);
    assert.strictEqual(tatum.rawStatus, 'OUT');
    assert.strictEqual(tatum.isStarter, true);
    assert.strictEqual(tatum.isTopScorer, false);
    assert.strictEqual(tatum.isImpactPlayer, true);
    assert.deepStrictEqual(tatum.impactReasons, ['starter']);

    const gate = buildNbaAvailabilityGate(impactContext, null);

    assert.ok(gate.missingFlags.includes('key_player_out'));
    assert.strictEqual(gate.availabilityFlags.length, 4);
    assert.deepStrictEqual(gate.availabilityFlags[0].impact_reasons, ['starter']);
    assert.strictEqual(gate.availabilityFlags[0].is_impact_player, true);

    const card = makeCard('FIRE');
    applyNbaImpactGateToCard(card, gate);
    assert.strictEqual(card.payloadData.tier, 'LEAN');
    assert.ok(card.payloadData.missing_inputs.includes('key_player_out'));
    assert.strictEqual(card.payloadData.raw_data.availability_flags.length, 4);
  });

  test('ESPN injury feed with no injuries does not downgrade PLAY/FIRE', async () => {
    const impactContext = await loadImpactContextFromEspnFixtures({
      injuriesPayload: {
        injuries: [
          {
            displayName: 'Boston Celtics',
            injuries: [],
          },
        ],
      },
    });

    assert.ok(impactContext);
    assert.strictEqual(impactContext.available, true);
    assert.deepStrictEqual(impactContext.players, []);

    const gate = buildNbaAvailabilityGate(impactContext, null);
    assert.strictEqual(gate.missingFlags.length, 0);
    assert.strictEqual(gate.uncertainFlags.length, 0);
    assert.strictEqual(gate.availabilityFlags.length, 0);

    const card = makeCard('FIRE');
    applyNbaImpactGateToCard(card, gate);
    assert.strictEqual(card.payloadData.tier, 'FIRE');
    assert.strictEqual(card.payloadData.missing_inputs.length, 0);
  });
});
