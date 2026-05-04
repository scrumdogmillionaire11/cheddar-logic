'use strict';

describe('fit_calibration_models scheduler idempotency', () => {
  let run;
  let insertJobRun;
  let markJobRunSuccess;
  let markJobRunFailure;
  let shouldRunJobKey;
  let db;

  beforeEach(() => {
    jest.resetModules();

    insertJobRun = jest.fn();
    markJobRunSuccess = jest.fn();
    markJobRunFailure = jest.fn();
    shouldRunJobKey = jest.fn(() => true);

    db = {
      prepare: jest.fn((sql) => {
        if (sql.includes("name='calibration_predictions'")) {
          return { get: jest.fn(() => ({ 1: 1 })) };
        }
        if (sql.includes("name='calibration_models'")) {
          return { get: jest.fn(() => ({ 1: 1 })) };
        }
        if (sql.includes('SELECT DISTINCT market')) {
          return { all: jest.fn(() => []) };
        }
        throw new Error(`Unhandled SQL in test: ${sql}`);
      }),
    };

    jest.doMock('@cheddar-logic/data', () => ({
      createJob: jest.fn(),
      getDatabase: jest.fn(() => db),
      insertJobRun,
      markJobRunFailure,
      markJobRunSuccess,
      shouldRunJobKey,
      withDb: jest.fn(),
    }));

    ({ run } = require('../fit_calibration_models'));
  });

  test('records a successful job_run even when there are no resolved markets to fit', async () => {
    const result = await run({ jobKey: 'fit_calibration_models|2026-05-04' });

    expect(insertJobRun).toHaveBeenCalledWith(
      'fit_calibration_models',
      expect.any(String),
      'fit_calibration_models|2026-05-04',
    );
    expect(markJobRunSuccess).toHaveBeenCalledWith(expect.any(String));
    expect(markJobRunFailure).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      jobKey: 'fit_calibration_models|2026-05-04',
      skipped: true,
      reason: 'no_resolved_markets',
    });
  });

  test('skips without claiming a job_run when the scheduler key is already satisfied', async () => {
    shouldRunJobKey.mockReturnValue(false);

    const result = await run({ jobKey: 'fit_calibration_models|2026-05-04' });

    expect(result).toEqual({
      success: true,
      skipped: true,
      jobKey: 'fit_calibration_models|2026-05-04',
    });
    expect(insertJobRun).not.toHaveBeenCalled();
    expect(markJobRunSuccess).not.toHaveBeenCalled();
  });
});
