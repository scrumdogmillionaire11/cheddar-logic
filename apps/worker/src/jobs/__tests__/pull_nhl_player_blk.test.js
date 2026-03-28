'use strict';

let mockUpsertPlayerBlkLogCalls = [];
let mockUpsertPlayerAvailabilityCalls = [];

jest.mock('@cheddar-logic/data', () => ({
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  shouldRunJobKey: jest.fn(() => true),
  withDb: jest.fn((fn) => fn()),
  listTrackedPlayers: jest.fn(() => []),
  upsertPlayerBlkLog: jest.fn((...args) => {
    mockUpsertPlayerBlkLogCalls.push(args);
  }),
  upsertPlayerAvailability: jest.fn((...args) => {
    mockUpsertPlayerAvailabilityCalls.push(args);
  }),
}));

global.fetch = jest.fn();

function buildPayload(overrides = {}) {
  return {
    fullName: 'Block Player',
    featuredStats: {
      regularSeason: {
        subSeason: {
          avgToi: '20:00',
        },
      },
    },
    last5Games: [
      { gameId: '1', gameDate: '2026-03-10', homeRoadFlag: 'H', toi: '20:00', blockedShots: 3, opponentAbbrev: 'TOR' },
    ],
    ...overrides,
  };
}

function loadModule() {
  jest.resetModules();
  jest.mock('@cheddar-logic/data', () => ({
    insertJobRun: jest.fn(),
    markJobRunSuccess: jest.fn(),
    markJobRunFailure: jest.fn(),
    shouldRunJobKey: jest.fn(() => true),
    withDb: jest.fn((fn) => fn()),
    listTrackedPlayers: jest.fn(() => []),
    upsertPlayerBlkLog: jest.fn((...args) => {
      mockUpsertPlayerBlkLogCalls.push(args);
    }),
    upsertPlayerAvailability: jest.fn((...args) => {
      mockUpsertPlayerAvailabilityCalls.push(args);
    }),
  }));
  return require('../pull_nhl_player_blk');
}

describe('pull_nhl_player_blk', () => {
  beforeEach(() => {
    mockUpsertPlayerBlkLogCalls = [];
    mockUpsertPlayerAvailabilityCalls = [];
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete process.env.NHL_BLK_PLAYER_IDS;
  });

  test('uses tracked blocked_shots players and upserts blocked-shot logs', async () => {
    const payload = buildPayload({ status: 'active' });
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(payload),
    });

    const { pullNhlPlayerBlk } = loadModule();
    const { listTrackedPlayers, upsertPlayerBlkLog } = require('@cheddar-logic/data');
    listTrackedPlayers.mockReturnValueOnce([
      { player_id: 8470001, team_abbrev: 'CAR', market: 'blocked_shots', is_active: 1 },
    ]);

    await pullNhlPlayerBlk({ dryRun: false });

    expect(listTrackedPlayers).toHaveBeenCalled();
    expect(global.fetch.mock.calls[0][0]).toContain('/8470001/landing');
    expect(upsertPlayerBlkLog).toHaveBeenCalled();
    const stored = upsertPlayerBlkLog.mock.calls[0][0];
    expect(stored.blockedShots).toBe(3);
    expect(stored.rawData.projToi).toBe(20);
  });

  test('injured players write INJURED availability and skip log upsert', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(buildPayload({ status: 'injured' })),
    });
    process.env.NHL_BLK_PLAYER_IDS = '8470002';

    const { pullNhlPlayerBlk } = loadModule();
    const { upsertPlayerBlkLog, upsertPlayerAvailability } = require('@cheddar-logic/data');
    await pullNhlPlayerBlk({ dryRun: false });

    expect(upsertPlayerBlkLog).not.toHaveBeenCalled();
    expect(upsertPlayerAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'INJURED', playerId: 8470002 }),
    );
  });
});
