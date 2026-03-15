/**
 * Unit tests for pull_nhl_player_shots.js
 *
 * Tests:
 * 1. Injury status check — injured player is skipped
 * 2. Fail-open — player with no status field proceeds normally
 * 3. NHL_SOG_EXCLUDE_PLAYER_IDS — manual override fires before status check
 */

'use strict';

// ---- Shared state for injectable mocks ----
let mockFetchPlayerLandingImpl = null;
let mockUpsertPlayerShotLogCalls = [];

// ---- Mock @cheddar-logic/data ----
jest.mock('@cheddar-logic/data', () => ({
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  shouldRunJobKey: jest.fn(() => true),
  withDb: jest.fn((fn) => fn()),
  upsertPlayerShotLog: jest.fn((...args) => {
    mockUpsertPlayerShotLogCalls.push(args);
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
function loadModule() {
  jest.resetModules();
  // Re-apply the mock after resetModules
  jest.mock('@cheddar-logic/data', () => ({
    insertJobRun: jest.fn(),
    markJobRunSuccess: jest.fn(),
    markJobRunFailure: jest.fn(),
    shouldRunJobKey: jest.fn(() => true),
    withDb: jest.fn((fn) => fn()),
    upsertPlayerShotLog: jest.fn((...args) => {
      mockUpsertPlayerShotLogCalls.push(args);
    }),
  }));
  return require('../pull_nhl_player_shots');
}

describe('pull_nhl_player_shots — injury status filtering', () => {
  beforeEach(() => {
    mockUpsertPlayerShotLogCalls = [];
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
