/**
 * Unit tests for sync_nhl_player_availability.js
 *
 * Tests:
 * 1. ACTIVE player — upsertPlayerAvailability called with status=ACTIVE
 * 2. INJURED player — upsertPlayerAvailability called with status=INJURED
 * 3. DTD player — upsertPlayerAvailability called with status=DTD
 * 4. dryRun=true — no DB writes and no fetch calls
 * 5. No player IDs — job returns skipped with reason=no_player_ids
 * 6. jobKey already succeeded — job returns skipped
 * 7. DTD player availability record stores status_reason from checkInjuryStatus
 */

'use strict';

let mockUpsertPlayerAvailabilityCalls = [];

// Mock @cheddar-logic/data
jest.mock('@cheddar-logic/data', () => ({
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  shouldRunJobKey: jest.fn(() => true),
  withDb: jest.fn((fn) => fn()),
  listTrackedPlayers: jest.fn(() => []),
  upsertPlayerAvailability: jest.fn((...args) => {
    mockUpsertPlayerAvailabilityCalls.push(args[0]);
  }),
}));

// Mock global fetch
global.fetch = jest.fn();

// Mock pull_nhl_player_shots to expose checkInjuryStatus
jest.mock('../pull_nhl_player_shots', () => ({
  pullNhlPlayerShots: jest.fn(),
  checkInjuryStatus: jest.fn(),
}));

// Helper: build a minimal landing payload
function buildPayload(overrides = {}) {
  return {
    fullName: 'Test Player',
    last5Games: [],
    ...overrides,
  };
}

function loadModule() {
  jest.resetModules();

  // Re-apply mocks after resetModules
  jest.mock('@cheddar-logic/data', () => ({
    insertJobRun: jest.fn(),
    markJobRunSuccess: jest.fn(),
    markJobRunFailure: jest.fn(),
    shouldRunJobKey: jest.fn(() => true),
    withDb: jest.fn((fn) => fn()),
    listTrackedPlayers: jest.fn(() => []),
    upsertPlayerAvailability: jest.fn((...args) => {
      mockUpsertPlayerAvailabilityCalls.push(args[0]);
    }),
  }));

  jest.mock('../pull_nhl_player_shots', () => ({
    pullNhlPlayerShots: jest.fn(),
    checkInjuryStatus: jest.fn(),
  }));

  const mod = require('../sync_nhl_player_availability');
  const data = require('@cheddar-logic/data');
  const shots = require('../pull_nhl_player_shots');
  return { mod, data, shots };
}

describe('sync_nhl_player_availability', () => {
  beforeEach(() => {
    mockUpsertPlayerAvailabilityCalls = [];
    jest.clearAllMocks();
    global.fetch = jest.fn();
    process.env.NHL_SOG_PLAYER_IDS = '8478402';
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;
    // Silence output
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('ACTIVE player — upsertPlayerAvailability called with status=ACTIVE', async () => {
    const { mod, data, shots } = loadModule();

    shots.checkInjuryStatus.mockReturnValue({ skip: false, tier: 'ACTIVE' });
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(buildPayload()),
    });

    process.env.NHL_SOG_SLEEP_MS = '0';
    await mod.syncNhlPlayerAvailability({ dryRun: false });

    expect(data.upsertPlayerAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: 8478402,
        sport: 'NHL',
        status: 'ACTIVE',
      }),
    );
  });

  test('INJURED player — upsertPlayerAvailability called with status=INJURED', async () => {
    const { mod, data, shots } = loadModule();

    shots.checkInjuryStatus.mockReturnValue({ skip: true, tier: 'INJURED', reason: 'injured' });
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(buildPayload({ status: 'injured' })),
    });

    process.env.NHL_SOG_SLEEP_MS = '0';
    await mod.syncNhlPlayerAvailability({ dryRun: false });

    expect(data.upsertPlayerAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: 8478402,
        sport: 'NHL',
        status: 'INJURED',
        statusReason: 'injured',
      }),
    );
  });

  test('DTD player — upsertPlayerAvailability called with status=DTD', async () => {
    const { mod, data, shots } = loadModule();

    shots.checkInjuryStatus.mockReturnValue({ skip: false, tier: 'DTD', reason: 'day-to-day' });
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(buildPayload()),
    });

    process.env.NHL_SOG_SLEEP_MS = '0';
    await mod.syncNhlPlayerAvailability({ dryRun: false });

    expect(data.upsertPlayerAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: 8478402,
        sport: 'NHL',
        status: 'DTD',
        statusReason: 'day-to-day',
      }),
    );
  });

  test('dryRun=true — no DB writes and no fetch calls', async () => {
    const { mod, data } = loadModule();

    process.env.NHL_SOG_SLEEP_MS = '0';
    const result = await mod.syncNhlPlayerAvailability({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(data.upsertPlayerAvailability).not.toHaveBeenCalled();
  });

  test('no player IDs — returns skipped with reason=no_player_ids', async () => {
    const { mod } = loadModule();

    delete process.env.NHL_SOG_PLAYER_IDS;
    process.env.NHL_SOG_SLEEP_MS = '0';
    const result = await mod.syncNhlPlayerAvailability({ dryRun: false });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_player_ids');
  });

  test('jobKey already succeeded — returns skipped', async () => {
    const { mod, data } = loadModule();

    data.shouldRunJobKey.mockReturnValue(false);
    process.env.NHL_SOG_SLEEP_MS = '0';
    const result = await mod.syncNhlPlayerAvailability({
      jobKey: 'some-key',
      dryRun: false,
    });

    expect(result.skipped).toBe(true);
    expect(data.upsertPlayerAvailability).not.toHaveBeenCalled();
  });
});
