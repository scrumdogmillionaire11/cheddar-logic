'use strict';

describe('refresh_team_metrics_daily scheduler contract', () => {
  let run;
  let insertJobRun;
  let markJobRunSuccess;
  let markJobRunFailure;
  let shouldRunJobKey;
  let deleteStaleTeamMetricsCache;
  let getTeamMetricsWithGames;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();

    insertJobRun = jest.fn();
    markJobRunSuccess = jest.fn();
    markJobRunFailure = jest.fn();
    shouldRunJobKey = jest.fn(() => true);
    deleteStaleTeamMetricsCache = jest.fn(() => 0);
    getTeamMetricsWithGames = jest.fn(async (teamName) => ({
      resolution: { status: 'ok', teamId: `${teamName}-id` },
    }));

    jest.doMock('@cheddar-logic/data', () => ({
      insertJobRun,
      markJobRunSuccess,
      markJobRunFailure,
      shouldRunJobKey,
      withDb: jest.fn(),
      getDatabase: jest.fn(() => ({})),
      deleteStaleTeamMetricsCache,
      createJob: jest.fn(),
    }));

    jest.doMock('../../../../../packages/data/src/team-metrics', () => ({
      getTeamMetricsWithGames,
    }));

    ({ run } = require('../refresh_team_metrics_daily'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('accepts scheduler-style options without treating them as dry-run', async () => {
    const promise = run({
      dryRun: false,
      jobKey: 'refresh_team_metrics|2026-05-04',
      sportFilter: 'NBA',
    });

    await jest.runAllTimersAsync();
    const result = await promise;

    expect(shouldRunJobKey).toHaveBeenCalledWith('refresh_team_metrics|2026-05-04');
    expect(insertJobRun).toHaveBeenCalledWith(
      'refresh_team_metrics_daily',
      expect.any(String),
      'refresh_team_metrics|2026-05-04',
    );
    expect(deleteStaleTeamMetricsCache).toHaveBeenCalled();
    expect(getTeamMetricsWithGames).toHaveBeenCalled();
    expect(markJobRunSuccess).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cacheDate: expect.any(String),
        failedCount: 0,
      }),
    );
    expect(markJobRunFailure).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  test('skips cleanly when the daily job key already succeeded', async () => {
    shouldRunJobKey.mockReturnValue(false);

    const result = await run({
      dryRun: false,
      jobKey: 'refresh_team_metrics|2026-05-04',
      sportFilter: 'NBA',
    });

    expect(result).toEqual({
      success: true,
      skipped: true,
      jobKey: 'refresh_team_metrics|2026-05-04',
    });
    expect(insertJobRun).not.toHaveBeenCalled();
    expect(getTeamMetricsWithGames).not.toHaveBeenCalled();
  });
});
