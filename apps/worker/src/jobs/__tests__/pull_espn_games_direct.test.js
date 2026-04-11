'use strict';

jest.mock('@cheddar-logic/data', () => ({
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  setCurrentRunId: jest.fn(),
  getDatabase: jest.fn(),
  upsertGame: jest.fn(),
  insertOddsSnapshot: jest.fn(),
  enrichOddsSnapshotWithEspnMetrics: jest.fn(async (snapshot) => ({
    ...snapshot,
    raw_data: {
      espn_metrics: {
        home: { metrics: { pace: 100 } },
        away: { metrics: { pace: 100 } },
      },
    },
  })),
  withDb: jest.fn(async (fn) => fn()),
}));

jest.mock('../../../../../packages/data/src/espn-client', () => ({
  fetchScoreboardEvents: jest.fn(),
}));

const {
  getDatabase,
  upsertGame,
  insertOddsSnapshot,
  enrichOddsSnapshotWithEspnMetrics,
} = require('@cheddar-logic/data');
const { fetchScoreboardEvents } = require('../../../../../packages/data/src/espn-client');
const { pullEspnGamesDirect } = require('../pull_espn_games_direct');

function makeEvent({ id = '401811039', date = '2026-04-11T02:00:00Z' } = {}) {
  return {
    id,
    date,
    competitions: [
      {
        date,
        status: { type: { completed: false } },
        competitors: [
          {
            homeAway: 'home',
            team: { displayName: 'Sacramento Kings' },
          },
          {
            homeAway: 'away',
            team: { displayName: 'Golden State Warriors' },
          },
        ],
      },
    ],
  };
}

describe('pullEspnGamesDirect duplicate suppression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetchScoreboardEvents
      .mockResolvedValueOnce([makeEvent()])
      .mockResolvedValue([]);
  });

  test('skips duplicate espndirect seeding for active-odds sports when a matching game already exists', async () => {
    getDatabase.mockReturnValue({
      prepare: jest.fn(() => ({
        all: jest.fn(() => [
          {
            game_id: 'canonical-warriors-kings',
            game_time_utc: '2026-04-11T02:10:00Z',
            home_team: 'Sacramento Kings',
            away_team: 'Golden State Warriors',
          },
        ]),
      })),
    });

    const result = await pullEspnGamesDirect({
      jobKey: 'test-espn-direct-duplicate-skip',
      sports: ['NBA'],
    });

    expect(result.success).toBe(true);
    expect(result.summary.duplicateSeedsSkipped).toBe(1);
    expect(upsertGame).not.toHaveBeenCalled();
    expect(enrichOddsSnapshotWithEspnMetrics).not.toHaveBeenCalled();
    expect(insertOddsSnapshot).not.toHaveBeenCalled();
  });

  test('still seeds a synthetic snapshot when no matching existing game is found', async () => {
    getDatabase.mockReturnValue({
      prepare: jest.fn(() => ({
        all: jest.fn(() => []),
      })),
    });

    const result = await pullEspnGamesDirect({
      jobKey: 'test-espn-direct-new-seed',
      sports: ['NBA'],
    });

    expect(result.success).toBe(true);
    expect(result.summary.gamesUpserted).toBe(1);
    expect(result.summary.snapshotsInserted).toBe(1);
    expect(result.summary.duplicateSeedsSkipped).toBe(0);
    expect(upsertGame).toHaveBeenCalledTimes(1);
    expect(insertOddsSnapshot).toHaveBeenCalledTimes(1);
  });
});
