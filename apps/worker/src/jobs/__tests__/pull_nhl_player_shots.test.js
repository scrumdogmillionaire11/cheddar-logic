/**
 * Unit tests for pull_nhl_player_shots.js
 *
 * Tests:
 * 1. Injury status check — injured player is skipped
 * 2. Fail-open — player with no status field proceeds normally
 * 3. NHL_SOG_EXCLUDE_PLAYER_IDS — manual override fires before status check
 * 4. upsertPlayerAvailability called with INJURED for injured players
 * 5. upsertPlayerAvailability called with ACTIVE for healthy players
 */

'use strict';

// ---- Shared state for injectable mocks ----
let mockFetchPlayerLandingImpl = null;
let mockUpsertPlayerShotLogCalls = [];
let mockUpsertPlayerAvailabilityCalls = [];
// WI-0530: configurable pp_rate row returned by the mock DB
let mockPpRateRow = null;

// ---- Mock @cheddar-logic/data ----
jest.mock('@cheddar-logic/data', () => ({
  getDatabase: jest.fn(() => ({
    prepare: jest.fn(() => ({ get: jest.fn(() => mockPpRateRow) })),
  })),
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  shouldRunJobKey: jest.fn(() => true),
  withDb: jest.fn((fn) => fn()),
  listTrackedPlayers: jest.fn(() => []),
  upsertPlayerShotLog: jest.fn((...args) => {
    mockUpsertPlayerShotLogCalls.push(args);
  }),
  upsertPlayerAvailability: jest.fn((...args) => {
    mockUpsertPlayerAvailabilityCalls.push(args);
  }),
}));

// ---- Mock global fetch ----
global.fetch = jest.fn();

// ---- Helper to build a minimal NHL landing payload ----
function buildPayload(overrides = {}) {
  return {
    fullName: 'Test Player',
    last5Games: [
      { gameId: '1', gameDate: '2026-03-10', homeRoadFlag: 'H', toi: '20:00', shots: 3, opponentAbbrev: 'TOR' },
    ],
    ...overrides,
  };
}

// Pull the module AFTER mocks are set up.
// We import it inside each test so env vars are applied.
// Set mockPpRateRow before calling loadModule to control what getDatabase returns.
function loadModule() {
  jest.resetModules();
  // Re-apply the mock after resetModules
  jest.mock('@cheddar-logic/data', () => ({
    getDatabase: jest.fn(() => ({
      prepare: jest.fn(() => ({ get: jest.fn(() => mockPpRateRow) })),
    })),
    insertJobRun: jest.fn(),
    markJobRunSuccess: jest.fn(),
    markJobRunFailure: jest.fn(),
    shouldRunJobKey: jest.fn(() => true),
    withDb: jest.fn((fn) => fn()),
    listTrackedPlayers: jest.fn(() => []),
    upsertPlayerShotLog: jest.fn((...args) => {
      mockUpsertPlayerShotLogCalls.push(args);
    }),
    upsertPlayerAvailability: jest.fn((...args) => {
      mockUpsertPlayerAvailabilityCalls.push(args);
    }),
  }));
  return require('../pull_nhl_player_shots');
}

describe('pull_nhl_player_shots — injury status filtering', () => {
  beforeEach(() => {
    mockUpsertPlayerShotLogCalls = [];
    mockUpsertPlayerAvailabilityCalls = [];
    jest.clearAllMocks();
    // Default: fake successful fetch response
    global.fetch = jest.fn();
  });

  test('injured player is skipped and not upserted', async () => {
    const injuredPayload = buildPayload({ status: 'injured' });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(injuredPayload),
    });

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    process.env.NHL_SOG_PLAYER_IDS = '8478402';
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;

    const { pullNhlPlayerShots } = loadModule();

    const { upsertPlayerShotLog } = require('@cheddar-logic/data');

    await pullNhlPlayerShots({ dryRun: false });

    // Player should be skipped — no upsert
    expect(upsertPlayerShotLog).not.toHaveBeenCalled();

    // Log should mention "Skipping"
    const allLogs = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogs).toMatch(/Skipping/);

    logSpy.mockRestore();
  });

  test('player with no status field proceeds normally (fail-open)', async () => {
    // No status field at all
    const noStatusPayload = buildPayload();
    // Explicitly remove status
    delete noStatusPayload.status;
    delete noStatusPayload.currentTeamRoster;

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(noStatusPayload),
    });

    process.env.NHL_SOG_PLAYER_IDS = '8478402';
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;

    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerShotLog } = require('@cheddar-logic/data');

    await pullNhlPlayerShots({ dryRun: false });

    // Player should be processed — upsert called for their L5 log
    expect(upsertPlayerShotLog).toHaveBeenCalled();
  });

  test('NHL_SOG_EXCLUDE_PLAYER_IDS excludes player even when status=healthy', async () => {
    const healthyPayload = buildPayload({ status: 'active' });

    // fetch should NOT be called because exclude check fires first
    global.fetch = jest.fn();

    process.env.NHL_SOG_PLAYER_IDS = '8478402';
    process.env.NHL_SOG_EXCLUDE_PLAYER_IDS = '8478402';

    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerShotLog } = require('@cheddar-logic/data');

    await pullNhlPlayerShots({ dryRun: false });

    // fetch should never be called (excluded before any API call)
    expect(fetch).not.toHaveBeenCalled();
    expect(upsertPlayerShotLog).not.toHaveBeenCalled();
  });

  test('uses tracked_players IDs before NHL_SOG_PLAYER_IDS fallback', async () => {
    const payload = buildPayload({ status: 'active' });
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(payload),
    });

    process.env.NHL_SOG_PLAYER_IDS = '1111111'; // should not be used
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;

    const { pullNhlPlayerShots } = loadModule();
    const { listTrackedPlayers } = require('@cheddar-logic/data');
    listTrackedPlayers.mockReturnValueOnce([
      { player_id: 8478402, sport: 'nhl', market: 'shots_on_goal', is_active: 1 },
    ]);

    await pullNhlPlayerShots({ dryRun: false });

    expect(listTrackedPlayers).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('/8478402/landing');
  });

  test('falls back to NHL_SOG_PLAYER_IDS when tracked_players is empty', async () => {
    const payload = buildPayload({ status: 'active' });
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(payload),
    });

    process.env.NHL_SOG_PLAYER_IDS = '8477492';
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;

    const { pullNhlPlayerShots } = loadModule();
    const { listTrackedPlayers } = require('@cheddar-logic/data');
    listTrackedPlayers.mockReturnValueOnce([]);

    await pullNhlPlayerShots({ dryRun: false });

    expect(listTrackedPlayers).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('/8477492/landing');
  });
});

describe('pull_nhl_player_shots — checkInjuryStatus edge cases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;
  });

  test.each([
    ['injured'],
    ['IR'],
    ['LTIR'],
    ['Injured Reserve'],
    ['scratched'],
    ['suspended'],
    ['inactive'],
  ])('status "%s" causes player to be skipped', async (status) => {
    const payload = buildPayload({ status });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(payload),
    });

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    process.env.NHL_SOG_PLAYER_IDS = '9999999';

    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerShotLog } = require('@cheddar-logic/data');

    await pullNhlPlayerShots({ dryRun: false });

    expect(upsertPlayerShotLog).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  test('currentTeamRoster.statusCode with injury value causes skip', async () => {
    const payload = buildPayload({
      currentTeamRoster: { statusCode: 'IR' },
    });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(payload),
    });

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    process.env.NHL_SOG_PLAYER_IDS = '9999998';

    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerShotLog } = require('@cheddar-logic/data');

    await pullNhlPlayerShots({ dryRun: false });

    expect(upsertPlayerShotLog).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe('pull_nhl_player_shots — player_availability writes', () => {
  beforeEach(() => {
    mockUpsertPlayerShotLogCalls = [];
    mockUpsertPlayerAvailabilityCalls = [];
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;
  });

  test('injured player writes INJURED to player_availability', async () => {
    const payload = buildPayload({ status: 'injured' });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(payload),
    });

    process.env.NHL_SOG_PLAYER_IDS = '8478402';

    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerAvailability } = require('@cheddar-logic/data');

    jest.spyOn(console, 'log').mockImplementation(() => {});
    await pullNhlPlayerShots({ dryRun: false });
    jest.restoreAllMocks();

    expect(upsertPlayerAvailability).toHaveBeenCalledTimes(1);
    const call = upsertPlayerAvailability.mock.calls[0][0];
    expect(call.status).toBe('INJURED');
    expect(call.statusReason).toBe('injured');
    expect(call.sport).toBe('NHL');
    expect(call.playerId).toBe(8478402);
  });

  test('healthy player writes ACTIVE to player_availability', async () => {
    const payload = buildPayload({ status: 'active' });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(payload),
    });

    process.env.NHL_SOG_PLAYER_IDS = '8478402';

    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerAvailability } = require('@cheddar-logic/data');

    await pullNhlPlayerShots({ dryRun: false });

    expect(upsertPlayerAvailability).toHaveBeenCalledTimes(1);
    const call = upsertPlayerAvailability.mock.calls[0][0];
    expect(call.status).toBe('ACTIVE');
    expect(call.statusReason).toBeNull();
  });

  test('fail-open player (no status field) writes ACTIVE to player_availability', async () => {
    const payload = buildPayload();
    delete payload.status;
    delete payload.currentTeamRoster;

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(payload),
    });

    process.env.NHL_SOG_PLAYER_IDS = '8478402';

    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerAvailability } = require('@cheddar-logic/data');

    await pullNhlPlayerShots({ dryRun: false });

    expect(upsertPlayerAvailability).toHaveBeenCalledTimes(1);
    const call = upsertPlayerAvailability.mock.calls[0][0];
    expect(call.status).toBe('ACTIVE');
  });

  test('DTD player writes DTD to player_availability but still processes shot logs', async () => {
    const payload = buildPayload({ status: 'day-to-day' });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(payload),
    });

    process.env.NHL_SOG_PLAYER_IDS = '8478402';

    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerAvailability } = require('@cheddar-logic/data');

    jest.spyOn(console, 'log').mockImplementation(() => {});
    await pullNhlPlayerShots({ dryRun: false });
    jest.restoreAllMocks();

    expect(upsertPlayerAvailability).toHaveBeenCalledTimes(1);
    const call = upsertPlayerAvailability.mock.calls[0][0];
    expect(call.status).toBe('DTD');
    expect(call.statusReason).toBe('day-to-day');
  });

  test('questionable player writes DTD to player_availability', async () => {
    const payload = buildPayload({ status: 'questionable' });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(payload),
    });

    process.env.NHL_SOG_PLAYER_IDS = '8478402';

    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerAvailability } = require('@cheddar-logic/data');

    jest.spyOn(console, 'log').mockImplementation(() => {});
    await pullNhlPlayerShots({ dryRun: false });
    jest.restoreAllMocks();

    expect(upsertPlayerAvailability).toHaveBeenCalledTimes(1);
    const call = upsertPlayerAvailability.mock.calls[0][0];
    expect(call.status).toBe('DTD');
  });
});

describe('pull_nhl_player_shots — checkInjuryStatus tier', () => {
  let checkInjuryStatus;

  beforeEach(() => {
    jest.resetModules();
    ({ checkInjuryStatus } = require('../pull_nhl_player_shots'));
  });

  test('returns tier=ACTIVE when no status field', () => {
    const result = checkInjuryStatus({});
    expect(result.skip).toBe(false);
    expect(result.tier).toBe('ACTIVE');
  });

  test('returns tier=INJURED for confirmed-out status', () => {
    const result = checkInjuryStatus({ status: 'injured' });
    expect(result.skip).toBe(true);
    expect(result.tier).toBe('INJURED');
  });

  test('returns tier=DTD for day-to-day status', () => {
    const result = checkInjuryStatus({ status: 'day-to-day' });
    expect(result.skip).toBe(false);
    expect(result.tier).toBe('DTD');
    expect(result.reason).toBe('day-to-day');
  });

  test('returns tier=DTD for questionable status', () => {
    const result = checkInjuryStatus({ status: 'questionable' });
    expect(result.skip).toBe(false);
    expect(result.tier).toBe('DTD');
  });

  test('returns tier=DTD for doubtful status', () => {
    const result = checkInjuryStatus({ status: 'doubtful' });
    expect(result.skip).toBe(false);
    expect(result.tier).toBe('DTD');
  });

  test('returns tier=ACTIVE for healthy active status', () => {
    const result = checkInjuryStatus({ status: 'active' });
    expect(result.skip).toBe(false);
    expect(result.tier).toBe('ACTIVE');
  });
});

describe('pull_nhl_player_shots — enriched raw_data (shotsPer60 + projToi)', () => {
  beforeEach(() => {
    mockUpsertPlayerShotLogCalls = [];
    mockUpsertPlayerAvailabilityCalls = [];
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  test('raw_data stored per game includes shotsPer60 derived from featuredStats', async () => {
    // NHL API has featuredStats.regularSeason.subSeason.shots = 200, gamesPlayed = 50
    // Expected shotsPer60 proxy: shots/gamesPlayed = 200/50 = 4.0 shots/game
    const payload = {
      fullName: 'Season Stats Player',
      last5Games: [
        { gameId: 'g1', gameDate: '2026-03-10', homeRoadFlag: 'H', toi: '18:30', shots: 3, opponentAbbrev: 'TOR' },
        { gameId: 'g2', gameDate: '2026-03-08', homeRoadFlag: 'R', toi: '19:00', shots: 4, opponentAbbrev: 'BOS' },
      ],
      featuredStats: {
        regularSeason: {
          subSeason: {
            shots: 200,
            gamesPlayed: 50,
          },
        },
      },
    };

    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(payload) });
    process.env.NHL_SOG_PLAYER_IDS = '9001';
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;

    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerShotLog } = require('@cheddar-logic/data');

    await pullNhlPlayerShots({ dryRun: false });

    expect(upsertPlayerShotLog).toHaveBeenCalled();
    const storedRow = upsertPlayerShotLog.mock.calls[0][0];
    const stored = JSON.parse(storedRow.rawData ? JSON.stringify(storedRow.rawData) : '{}');

    // shotsPer60 must be populated (200 shots / 50 games = 4.0)
    expect(stored.shotsPer60).toBe(4.0);
    // projToi must be populated (from game toi since avgToi not in subSeason above)
    expect(typeof stored.projToi).toBe('number');
    expect(stored.projToi).toBeGreaterThan(0);
  });

  test('raw_data.shotsPer60 is null when featuredStats is missing', async () => {
    const payload = {
      fullName: 'No Stats Player',
      last5Games: [
        { gameId: 'g3', gameDate: '2026-03-10', homeRoadFlag: 'H', toi: '15:00', shots: 2, opponentAbbrev: 'MTL' },
      ],
      // No featuredStats
    };

    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(payload) });
    process.env.NHL_SOG_PLAYER_IDS = '9002';
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;

    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerShotLog } = require('@cheddar-logic/data');

    await pullNhlPlayerShots({ dryRun: false });

    const storedRow = upsertPlayerShotLog.mock.calls[0][0];
    const stored = JSON.parse(storedRow.rawData ? JSON.stringify(storedRow.rawData) : '{}');

    expect(stored.shotsPer60).toBeNull();
    // projToi falls back to the game's own toi_minutes (15.0)
    expect(stored.projToi).toBeCloseTo(15.0, 1);
  });

  test('raw_data retains original game fields alongside enriched fields', async () => {
    const payload = {
      fullName: 'Field Retention Player',
      last5Games: [
        { gameId: 'g4', gameDate: '2026-03-12', homeRoadFlag: 'R', toi: '20:00', shots: 5, opponentAbbrev: 'EDM', goals: 1 },
      ],
    };

    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(payload) });
    process.env.NHL_SOG_PLAYER_IDS = '9003';
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;

    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerShotLog } = require('@cheddar-logic/data');

    await pullNhlPlayerShots({ dryRun: false });

    const storedRow = upsertPlayerShotLog.mock.calls[0][0];
    const stored = JSON.parse(storedRow.rawData ? JSON.stringify(storedRow.rawData) : '{}');

    // Original game fields must still be present
    expect(stored.shots).toBe(5);
    expect(stored.goals).toBe(1);
    expect(stored.opponentAbbrev).toBe('EDM');
    // Enriched fields added
    expect('shotsPer60' in stored).toBe(true);
    expect('projToi' in stored).toBe(true);
  });

  // --- WI-0528: computeSeasonPpToi + ppToi enrichment ---

  test('computeSeasonPpToi: raw_data.ppToi is 2.5 when avgPpToi is "2:30"', async () => {
    const payload = {
      fullName: 'PP Heavy Player',
      last5Games: [
        { gameId: 'pp1', gameDate: '2026-03-10', homeRoadFlag: 'H', toi: '20:00', shots: 3, opponentAbbrev: 'TOR' },
      ],
      featuredStats: {
        regularSeason: {
          subSeason: {
            shots: 100,
            gamesPlayed: 50,
            avgToi: '18:00',
            avgPpToi: '2:30',
          },
        },
      },
    };

    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(payload) });
    process.env.NHL_SOG_PLAYER_IDS = '9010';
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;

    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerShotLog } = require('@cheddar-logic/data');

    await pullNhlPlayerShots({ dryRun: false });

    const storedRow = upsertPlayerShotLog.mock.calls[0][0];
    const stored = JSON.parse(storedRow.rawData ? JSON.stringify(storedRow.rawData) : '{}');

    expect(stored.ppToi).toBeCloseTo(2.5, 5);
  });

  test('computeSeasonPpToi: raw_data.ppToi is 0.0 when avgPpToi is "0:00"', async () => {
    const payload = {
      fullName: 'No PP Player',
      last5Games: [
        { gameId: 'pp2', gameDate: '2026-03-10', homeRoadFlag: 'H', toi: '18:00', shots: 2, opponentAbbrev: 'MTL' },
      ],
      featuredStats: {
        regularSeason: {
          subSeason: {
            shots: 80,
            gamesPlayed: 40,
            avgToi: '18:00',
            avgPpToi: '0:00',
          },
        },
      },
    };

    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(payload) });
    process.env.NHL_SOG_PLAYER_IDS = '9011';
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;

    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerShotLog } = require('@cheddar-logic/data');

    await pullNhlPlayerShots({ dryRun: false });

    const storedRow = upsertPlayerShotLog.mock.calls[0][0];
    const stored = JSON.parse(storedRow.rawData ? JSON.stringify(storedRow.rawData) : '{}');

    expect(stored.ppToi).toBeCloseTo(0.0, 5);
  });

  test('computeSeasonPpToi: raw_data.ppToi is null when avgPpToi is absent', async () => {
    const payload = {
      fullName: 'No PP Toi Player',
      last5Games: [
        { gameId: 'pp3', gameDate: '2026-03-10', homeRoadFlag: 'H', toi: '18:00', shots: 2, opponentAbbrev: 'BOS' },
      ],
      featuredStats: {
        regularSeason: {
          subSeason: {
            shots: 80,
            gamesPlayed: 40,
            avgToi: '18:00',
            // no avgPpToi
          },
        },
      },
    };

    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(payload) });
    process.env.NHL_SOG_PLAYER_IDS = '9012';
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;

    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerShotLog } = require('@cheddar-logic/data');

    await pullNhlPlayerShots({ dryRun: false });

    const storedRow = upsertPlayerShotLog.mock.calls[0][0];
    const stored = JSON.parse(storedRow.rawData ? JSON.stringify(storedRow.rawData) : '{}');

    expect(stored.ppToi).toBeNull();
  });

  test('computeSeasonPpToi: raw_data.ppToi is null when subSeason is missing', async () => {
    const payload = {
      fullName: 'No SubSeason Player',
      last5Games: [
        { gameId: 'pp4', gameDate: '2026-03-10', homeRoadFlag: 'H', toi: '18:00', shots: 2, opponentAbbrev: 'VAN' },
      ],
      // No featuredStats at all
    };

    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(payload) });
    process.env.NHL_SOG_PLAYER_IDS = '9013';
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;

    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerShotLog } = require('@cheddar-logic/data');

    await pullNhlPlayerShots({ dryRun: false });

    const storedRow = upsertPlayerShotLog.mock.calls[0][0];
    const stored = JSON.parse(storedRow.rawData ? JSON.stringify(storedRow.rawData) : '{}');

    expect(stored.ppToi).toBeNull();
  });

  // --- WI-0530: ppRatePer60 enrichment from player_pp_rates ---

  test('WI-0530: raw_data.ppRatePer60 is populated from player_pp_rates when row exists', async () => {
    const payload = {
      fullName: 'PP Rate Player',
      last5Games: [
        { gameId: 'ppr1', gameDate: '2026-03-10', homeRoadFlag: 'H', toi: '20:00', shots: 3, opponentAbbrev: 'TOR' },
      ],
      featuredStats: {
        regularSeason: {
          subSeason: { shots: 100, gamesPlayed: 50, avgToi: '18:00', avgPpToi: '2:30' },
        },
      },
    };

    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(payload) });
    process.env.NHL_SOG_PLAYER_IDS = '9020';
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;

    // Simulate player found in player_pp_rates with pp_shots_per60 = 4.8
    mockPpRateRow = { pp_shots_per60: 4.8 };
    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerShotLog } = require('@cheddar-logic/data');

    await pullNhlPlayerShots({ dryRun: false });

    expect(upsertPlayerShotLog).toHaveBeenCalled();
    const storedRow = upsertPlayerShotLog.mock.calls[0][0];
    const stored = JSON.parse(storedRow.rawData ? JSON.stringify(storedRow.rawData) : '{}');
    expect(stored.ppRatePer60).toBe(4.8);
  });

  test('WI-0530: raw_data.ppRatePer60 is null when player absent from player_pp_rates', async () => {
    const payload = {
      fullName: 'No PP Rate Player',
      last5Games: [
        { gameId: 'ppr2', gameDate: '2026-03-10', homeRoadFlag: 'H', toi: '18:00', shots: 2, opponentAbbrev: 'MTL' },
      ],
    };

    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(payload) });
    process.env.NHL_SOG_PLAYER_IDS = '9021';
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;

    // ppRateRow = null → player not in table
    mockPpRateRow = null;
    const { pullNhlPlayerShots } = loadModule();
    const { upsertPlayerShotLog } = require('@cheddar-logic/data');

    await pullNhlPlayerShots({ dryRun: false });

    expect(upsertPlayerShotLog).toHaveBeenCalled();
    const storedRow = upsertPlayerShotLog.mock.calls[0][0];
    const stored = JSON.parse(storedRow.rawData ? JSON.stringify(storedRow.rawData) : '{}');
    expect(stored.ppRatePer60).toBeNull();
  });
});
