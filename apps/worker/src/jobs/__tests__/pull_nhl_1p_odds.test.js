'use strict';

jest.mock('@cheddar-logic/data', () => ({
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  withDb: jest.fn((fn) => fn()),
  patchOddsSnapshot1p: jest.fn(),
  upsertQuotaLedger: jest.fn(),
  getDatabase: jest.fn(() => ({
    prepare: jest.fn(() => ({
      get: jest.fn(() => null),
    })),
  })),
}));

function loadModule() {
  jest.resetModules();
  return require('../pull_nhl_1p_odds');
}

describe('pull_nhl_1p_odds fail-closed guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete process.env.NHL_1P_ODDS_ENABLED;
    process.env.APP_ENV = 'production';
    process.env.ODDS_API_KEY = 'test-key';
  });

  test('skips by default when NHL_1P_ODDS_ENABLED is unset', async () => {
    const { pullNhl1pOdds } = loadModule();
    const { insertJobRun, withDb } = require('@cheddar-logic/data');

    const result = await pullNhl1pOdds({ dryRun: false });

    expect(result).toEqual({
      success: true,
      skipped: true,
      reason: 'not_enabled',
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(withDb).not.toHaveBeenCalled();
    expect(insertJobRun).not.toHaveBeenCalled();
  });

  test('runs when NHL_1P_ODDS_ENABLED=true and dryRun is requested', async () => {
    process.env.NHL_1P_ODDS_ENABLED = 'true';
    const { pullNhl1pOdds } = loadModule();
    const { insertJobRun, withDb } = require('@cheddar-logic/data');

    const result = await pullNhl1pOdds({ dryRun: true });

    expect(result).toEqual({
      success: true,
      dryRun: true,
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(withDb).not.toHaveBeenCalled();
    expect(insertJobRun).not.toHaveBeenCalled();
  });
});
