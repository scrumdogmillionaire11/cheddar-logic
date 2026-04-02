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

  test('always skips because NHL 1P odds fetch is hard-disabled', async () => {
    const { pullNhl1pOdds } = loadModule();
    const { insertJobRun, withDb } = require('@cheddar-logic/data');

    const result = await pullNhl1pOdds({ dryRun: false });

    expect(result).toEqual({
      success: true,
      skipped: true,
      reason: 'projection_only_lane',
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(withDb).not.toHaveBeenCalled();
    expect(insertJobRun).not.toHaveBeenCalled();
  });
});
