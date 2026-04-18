'use strict';

const mockDb = { id: 'projection-accuracy-db' };

const mocks = {
  backfillProjectionAccuracyEvals: jest.fn(() => ({ processed: 2, updated: 2 })),
  insertJobRun: jest.fn(),
  markJobRunFailure: jest.fn(),
  markJobRunSuccess: jest.fn(),
  materializeProjectionAccuracyMarketHealth: jest.fn(() => [
    { market_family: 'MLB_PITCHER_K', market_trust_status: 'TRUSTED' },
  ]),
  withDb: jest.fn(async (fn) => fn(mockDb)),
};

jest.mock('@cheddar-logic/data', () => mocks);

const {
  parseArgs,
  runProjectionAccuracyHealthJob,
} = require('../projection_accuracy_health');

describe('projection_accuracy_health job', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('parseArgs supports mode and limit flags', () => {
    expect(parseArgs(['--backfill-only', '--limit=25', '--job-key', 'nightly'])).toMatchObject({
      backfill: true,
      health: false,
      limit: 25,
      jobKey: 'nightly',
    });
    expect(parseArgs(['--health-only', '--json', '--limit', '50'])).toMatchObject({
      backfill: false,
      health: true,
      json: true,
      limit: 50,
    });
  });

  test('runs backfill and materializes market health through writer DB', async () => {
    const result = await runProjectionAccuracyHealthJob({
      limit: 12,
      jobKey: 'projection-health-test',
      json: true,
    });

    expect(result.success).toBe(true);
    expect(mocks.insertJobRun).toHaveBeenCalledWith(
      'projection_accuracy_health',
      expect.stringMatching(/^projection_accuracy_health-/),
      'projection-health-test',
    );
    expect(mocks.backfillProjectionAccuracyEvals).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ limit: 12 }),
    );
    expect(mocks.materializeProjectionAccuracyMarketHealth).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ generatedAt: expect.any(String) }),
    );
    expect(mocks.markJobRunSuccess).toHaveBeenCalledWith(result.jobRunId);
  });

  test('supports health-only mode', async () => {
    const result = await runProjectionAccuracyHealthJob({
      backfill: false,
      health: true,
      json: true,
    });

    expect(result.success).toBe(true);
    expect(mocks.backfillProjectionAccuracyEvals).not.toHaveBeenCalled();
    expect(mocks.materializeProjectionAccuracyMarketHealth).toHaveBeenCalledTimes(1);
  });

  test('records job failure without throwing', async () => {
    mocks.materializeProjectionAccuracyMarketHealth.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const result = await runProjectionAccuracyHealthJob({ json: true });

    expect(result).toMatchObject({ success: false, error: 'boom' });
    expect(mocks.markJobRunFailure).toHaveBeenCalledWith(result.jobRunId, 'boom');
  });
});
