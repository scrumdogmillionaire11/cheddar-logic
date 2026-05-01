'use strict';

jest.mock('@cheddar-logic/data', () => ({
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  setCurrentRunId: jest.fn(),
  getDatabase: jest.fn(() => ({
    prepare: jest.fn(() => ({ all: jest.fn(() => []) })),
  })),
  upsertGame: jest.fn(),
  insertOddsSnapshot: jest.fn(),
  // Spread incoming raw_data so seriesStatus seeded before enrichment survives.
  enrichOddsSnapshotWithEspnMetrics: jest.fn(async (snapshot) => {
    const incoming =
      snapshot.raw_data && typeof snapshot.raw_data === 'object'
        ? snapshot.raw_data
        : {};
    return {
      ...snapshot,
      raw_data: {
        ...incoming,
        espn_metrics: {
          home: { metrics: { avgGoalsFor: 3.1 } },
          away: { metrics: { avgGoalsFor: 2.8 } },
        },
      },
    };
  }),
  withDb: jest.fn(async (fn) => fn()),
}));

jest.mock('../../../../../packages/data/src/espn-client', () => ({
  fetchScoreboardEvents: jest.fn(),
}));

const { insertOddsSnapshot } = require('@cheddar-logic/data');
const { fetchScoreboardEvents } = require('../../../../../packages/data/src/espn-client');
const { pullEspnGamesDirect } = require('../pull_espn_games_direct');

function makeNhlEvent({ id = '401999001', seriesStatus = undefined } = {}) {
  const comp = {
    date: '2026-04-30T23:00:00Z',
    status: { type: { completed: false } },
    competitors: [
      { homeAway: 'home', team: { displayName: 'New York Rangers' } },
      { homeAway: 'away', team: { displayName: 'Carolina Hurricanes' } },
    ],
  };
  if (seriesStatus !== undefined) {
    comp.seriesStatus = seriesStatus;
  }
  return { id, date: '2026-04-30T23:00:00Z', competitions: [comp] };
}

function capturedRawData() {
  const call = insertOddsSnapshot.mock.calls[0][0];
  const raw = call.rawData;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

describe('pull_espn_games_direct — seriesStatus ingestion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Second date fetch returns empty so only one game processed.
    fetchScoreboardEvents.mockResolvedValueOnce([]).mockResolvedValue([]);
  });

  test('happy path: competition.seriesStatus is written to raw_data.seriesStatus', async () => {
    const series = {
      type: 'playoff',
      summary: 'NYR leads series 3-2',
      completed: false,
    };
    fetchScoreboardEvents.mockResolvedValueOnce([makeNhlEvent({ seriesStatus: series })]);

    await pullEspnGamesDirect({ sports: ['NHL'] });

    expect(insertOddsSnapshot).toHaveBeenCalledTimes(1);
    const raw = capturedRawData();
    expect(raw.seriesStatus).toBeDefined();
    expect(raw.seriesStatus.summary).toBe('NYR leads series 3-2');
  });

  test('missing seriesStatus: regular-season event ingests without error and seriesStatus is absent', async () => {
    fetchScoreboardEvents.mockResolvedValueOnce([makeNhlEvent()]);

    const result = await pullEspnGamesDirect({ sports: ['NHL'] });

    expect(result.success).toBe(true);
    expect(insertOddsSnapshot).toHaveBeenCalledTimes(1);
    const raw = capturedRawData();
    // seriesStatus should not be fabricated for regular-season events.
    expect(raw?.seriesStatus ?? null).toBeNull();
  });

  test('regression: existing espn_metrics keys are preserved alongside seriesStatus', async () => {
    const series = { type: 'playoff', summary: 'CAR leads series 2-1', completed: false };
    fetchScoreboardEvents.mockResolvedValueOnce([makeNhlEvent({ seriesStatus: series })]);

    await pullEspnGamesDirect({ sports: ['NHL'] });

    const raw = capturedRawData();
    expect(raw.seriesStatus).toBeDefined();
    expect(raw.espn_metrics).toBeDefined();
    expect(raw.espn_metrics.home.metrics.avgGoalsFor).toBe(3.1);
  });
});
