'use strict';

jest.mock('@cheddar-logic/data', () => ({
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  shouldRunJobKey: jest.fn(() => true),
  upsertGame: jest.fn(),
  upsertGameIdMap: jest.fn(),
  getDatabase: jest.fn(),
  withDb: jest.fn(async (fn) => fn()),
}));

jest.mock('../../../../../packages/data/src/espn-client', () => ({
  fetchScoreboardEvents: jest.fn(),
}));

const {
  upsertGame,
  upsertGameIdMap,
  getDatabase,
} = require('@cheddar-logic/data');
const { fetchScoreboardEvents } = require('../../../../../packages/data/src/espn-client');
const { pullScheduleNba } = require('../pull_schedule_nba');
const { pullScheduleNhl } = require('../pull_schedule_nhl');

function makeEvent({ id, date, homeTeam, awayTeam }) {
  return {
    id,
    date,
    competitions: [
      {
        date,
        status: { type: { state: 'pre' } },
        competitors: [
          { homeAway: 'home', team: { displayName: homeTeam } },
          { homeAway: 'away', team: { displayName: awayTeam } },
        ],
      },
    ],
  };
}

function mockSingleDay(events) {
  fetchScoreboardEvents.mockReset();
  fetchScoreboardEvents.mockResolvedValueOnce(events).mockResolvedValue([]);
}

describe('ESPN schedule canonicalization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([
    {
      label: 'NBA',
      job: pullScheduleNba,
      event: makeEvent({
        id: '401811039',
        date: '2026-04-11T02:00:00Z',
        homeTeam: 'Sacramento Kings',
        awayTeam: 'Golden State Warriors',
      }),
      candidate: {
        game_id: 'canonical-warriors-kings',
        game_time_utc: '2026-04-11T02:10:00Z',
        home_team: 'Sacramento Kings',
        away_team: 'Golden State Warriors',
      },
    },
    {
      label: 'NHL',
      job: pullScheduleNhl,
      event: makeEvent({
        id: '401700001',
        date: '2026-04-11T00:00:00Z',
        homeTeam: 'Boston Bruins',
        awayTeam: 'Toronto Maple Leafs',
      }),
      candidate: {
        game_id: 'canonical-leafs-bruins',
        game_time_utc: '2026-04-11T00:05:00Z',
        home_team: 'Boston Bruins',
        away_team: 'Toronto Maple Leafs',
      },
    },
  ])('$label skips duplicate ESPN game upsert when a canonical odds-backed candidate exists', async ({ job, event, candidate }) => {
    mockSingleDay([event]);
    getDatabase.mockReturnValue({
      prepare: jest.fn(() => ({
        all: jest.fn(() => [candidate]),
      })),
    });

    const result = await job({ jobKey: `test-${event.id}` });

    expect(result.success).toBe(true);
    expect(result.gamesUpserted).toBe(0);
    expect(result.gamesSkippedCanonical).toBe(1);
    expect(upsertGame).not.toHaveBeenCalled();
    expect(upsertGameIdMap).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'espn',
        externalGameId: event.id,
        gameId: candidate.game_id,
      }),
    );
  });

  test('falls back to upserting the ESPN numeric game row when no canonical candidate exists', async () => {
    const event = makeEvent({
      id: '401811040',
      date: '2026-04-11T02:30:00Z',
      homeTeam: 'Los Angeles Lakers',
      awayTeam: 'Phoenix Suns',
    });
    mockSingleDay([event]);
    getDatabase.mockReturnValue({
      prepare: jest.fn(() => ({
        all: jest.fn(() => []),
      })),
    });

    const result = await pullScheduleNba({ jobKey: 'test-no-candidate' });

    expect(result.success).toBe(true);
    expect(result.gamesUpserted).toBe(1);
    expect(result.gamesSkippedCanonical).toBe(0);
    expect(upsertGame).toHaveBeenCalledWith(
      expect.objectContaining({
        gameId: '401811040',
        homeTeam: 'Los Angeles Lakers',
        awayTeam: 'Phoenix Suns',
      }),
    );
    expect(upsertGameIdMap).not.toHaveBeenCalled();
  });
});
