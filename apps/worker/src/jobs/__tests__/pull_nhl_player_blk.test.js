'use strict';

/**
 * Tests for pull_nhl_player_blk — NHL stats REST API batch approach.
 *
 * The landing API (/v1/player/{id}/landing) does NOT include blockedShots in
 * its last5Games payload (confirmed 2026-04-05 against live API). The correct
 * source is the NHL stats REST API with isGame=true.
 */

jest.mock('@cheddar-logic/data', () => ({
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  shouldRunJobKey: jest.fn(() => true),
  withDb: jest.fn((fn) => fn()),
  listTrackedPlayers: jest.fn(() => []),
  upsertPlayerBlkLog: jest.fn(),
}));

global.fetch = jest.fn();

function buildStatsApiResponse(overrides = {}) {
  return {
    data: [
      {
        playerId: 8470001,
        skaterFullName: 'Block Player',
        teamAbbrev: 'CAR',
        gameId: 2025020100,
        gameDate: '2026-03-10',
        homeRoad: 'H',
        opponentTeamAbbrev: 'TOR',
        timeOnIcePerGame: 1200, // 20:00 in seconds
        blockedShots: 3,
        ...overrides,
      },
    ],
    total: 1,
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
    upsertPlayerBlkLog: jest.fn(),
  }));
  return require('../pull_nhl_player_blk');
}

describe('pull_nhl_player_blk', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete process.env.NHL_BLK_PLAYER_IDS;
    delete process.env.NHL_BLK_SEASON_ID;
  });

  test('calls NHL stats REST API with isGame=true and upserts blocked-shot logs', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(buildStatsApiResponse()),
    });

    const { pullNhlPlayerBlk } = loadModule();
    const { listTrackedPlayers, upsertPlayerBlkLog } = require('@cheddar-logic/data');
    listTrackedPlayers.mockReturnValueOnce([
      { player_id: 8470001, team_abbrev: 'CAR', market: 'blocked_shots', is_active: 1 },
    ]);

    await pullNhlPlayerBlk({ dryRun: false });

    // Calls the stats REST endpoint, not the landing endpoint
    expect(global.fetch.mock.calls[0][0]).toContain('api.nhle.com/stats/rest');
    expect(global.fetch.mock.calls[0][0]).toContain('isGame=true');
    expect(global.fetch.mock.calls[0][0]).toContain('8470001');

    expect(upsertPlayerBlkLog).toHaveBeenCalled();
    const stored = upsertPlayerBlkLog.mock.calls[0][0];
    expect(stored.blockedShots).toBe(3);
    expect(stored.playerId).toBe(8470001);
    // TOI: 1200 seconds / 60 = 20.00 minutes
    expect(stored.toiMinutes).toBe(20);
    expect(stored.rawData.projToi).toBe(20);
  });

  test('uses NHL_BLK_PLAYER_IDS env fallback when no tracked players exist', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(buildStatsApiResponse({ playerId: 8470002 })),
    });

    process.env.NHL_BLK_PLAYER_IDS = '8470002';

    const { pullNhlPlayerBlk } = loadModule();
    const { listTrackedPlayers, upsertPlayerBlkLog } = require('@cheddar-logic/data');
    listTrackedPlayers.mockReturnValueOnce([]);

    await pullNhlPlayerBlk({ dryRun: false });

    expect(global.fetch.mock.calls[0][0]).toContain('8470002');
    expect(upsertPlayerBlkLog).toHaveBeenCalled();
  });

  test('returns skipped when no player IDs available', async () => {
    const { pullNhlPlayerBlk } = loadModule();
    const { listTrackedPlayers } = require('@cheddar-logic/data');
    listTrackedPlayers.mockReturnValueOnce([]);

    const result = await pullNhlPlayerBlk({ dryRun: false });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_player_ids');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns dryRun=true without making API calls', async () => {
    const { pullNhlPlayerBlk } = loadModule();
    const { listTrackedPlayers } = require('@cheddar-logic/data');
    listTrackedPlayers.mockReturnValueOnce([
      { player_id: 8470001, team_abbrev: 'CAR', is_active: 1 },
    ]);

    const result = await pullNhlPlayerBlk({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('warns and skips players with no game logs in API response', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [], total: 0 }),
    });

    const { pullNhlPlayerBlk } = loadModule();
    const { listTrackedPlayers, upsertPlayerBlkLog } = require('@cheddar-logic/data');
    listTrackedPlayers.mockReturnValueOnce([
      { player_id: 8470001, team_abbrev: 'CAR', is_active: 1 },
    ]);

    const result = await pullNhlPlayerBlk({ dryRun: false });

    expect(result.success).toBe(true);
    expect(result.logsInserted).toBe(0);
    expect(upsertPlayerBlkLog).not.toHaveBeenCalled();
  });
});

describe('parseToiSeconds', () => {
  test('converts integer seconds to decimal minutes', () => {
    const { parseToiSeconds } = require('../pull_nhl_player_blk');
    expect(parseToiSeconds(1244)).toBe(20.73); // 20:44
    expect(parseToiSeconds(1200)).toBe(20);    // 20:00
    expect(parseToiSeconds(0)).toBeNull();
    expect(parseToiSeconds(null)).toBeNull();
    expect(parseToiSeconds('abc')).toBeNull();
  });
});

describe('groupByPlayer', () => {
  test('groups rows by playerId and respects gamesPerPlayer limit', () => {
    const { groupByPlayer } = require('../pull_nhl_player_blk');
    const rows = [
      { playerId: 1, gameDate: '2026-04-02', blockedShots: 2 },
      { playerId: 1, gameDate: '2026-04-01', blockedShots: 1 },
      { playerId: 2, gameDate: '2026-04-02', blockedShots: 3 },
    ];
    const result = groupByPlayer(rows, 1);
    expect(result.get(1)).toHaveLength(1);
    expect(result.get(1)[0].blockedShots).toBe(2); // most recent first
    expect(result.get(2)).toHaveLength(1);
    expect(result.get(2)[0].blockedShots).toBe(3);
  });
});
