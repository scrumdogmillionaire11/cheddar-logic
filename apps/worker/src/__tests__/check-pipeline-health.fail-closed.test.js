'use strict';

const { DateTime } = require('luxon');

jest.mock('@cheddar-logic/data', () => ({
  getDatabase: jest.fn(),
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  createJob: jest.fn(),
  wasJobRecentlySuccessful: jest.fn(() => true),
  writePipelineHealthState: jest.fn(),
  buildPipelineHealthCheckId: jest.fn((phase, checkName) => `${phase}:${checkName}`),
}));

jest.mock('../jobs/post_discord_cards', () => ({
  sendDiscordMessages: jest.fn().mockResolvedValue(1),
}));

jest.mock('../jobs/run_mlb_model', () => ({
  buildMlbMarketAvailability: jest.fn(() => ({
    f5_line_ok: true,
    full_game_total_ok: true,
    expect_f5_ml: false,
    f5_ml_ok: true,
  })),
}));

jest.mock('../schedulers/quota', () => ({
  getCurrentQuotaTier: jest.fn(() => 'FULL'),
}));

jest.mock('../jobs/refresh_stale_odds', () => ({
  refreshStaleOdds: jest.fn().mockResolvedValue({
    success: true,
    staleDiagnostics: { detected: 0, refreshed: 0, blocked: 0 },
  }),
}));

jest.mock('@cheddar-logic/data/src/feature-flags', () => ({
  isFeatureEnabled: jest.fn(() => false),
}));

jest.mock('../jobs/execution-gate-freshness-contract', () => ({
  getContractForSport: jest.fn(() => ({ hardMaxMinutes: 120 })),
}));

const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  writePipelineHealthState,
} = require('@cheddar-logic/data');
const { createJob } = require('../../../../packages/data/src/job-runtime');
const { checkPipelineHealth } = require('../jobs/check_pipeline_health');

function makeDb({ lastSuccessfulStartedAt = null } = {}) {
  return {
    prepare: jest.fn((sql) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (
        normalized.includes("FROM job_runs") &&
        normalized.includes("job_name = 'check_pipeline_health'") &&
        normalized.includes("status = 'success'")
      ) {
        return {
          get: jest.fn(() =>
            lastSuccessfulStartedAt
              ? { started_at: lastSuccessfulStartedAt }
              : null,
          ),
        };
      }

      return {
        get: jest.fn(() => null),
        all: jest.fn(() => []),
        run: jest.fn(),
      };
    }),
  };
}

describe('check_pipeline_health fail-closed job health', () => {
  let exitSpy;
  let logSpy;
  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG;
    delete process.env.DISCORD_ALERT_WEBHOOK_URL;
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('critical watchdog breach marks the run failed and exits non-zero', async () => {
    getDatabase.mockReturnValue(
      makeDb({
        lastSuccessfulStartedAt: DateTime.utc().minus({ hours: 3 }).toISO(),
      }),
    );

    const result = await checkPipelineHealth({
      jobKey: 'wi-1243-critical-watchdog',
      dryRun: false,
      checksOverride: {},
    });

    expect(insertJobRun).toHaveBeenCalled();
    expect(markJobRunFailure).toHaveBeenCalled();
    expect(markJobRunSuccess).not.toHaveBeenCalled();
    expect(writePipelineHealthState).toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      exitCode: 1,
      jobStatus: 'failed',
    });
    expect(result.criticalHealthIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkName: 'watchdog_heartbeat',
          healthClass: 'WATCHDOG_CRITICAL_BREACH',
          fatal: true,
        }),
      ]),
    );

    await createJob('check_pipeline_health', async () => result);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('non-critical watchdog info warning remains non-fatal', async () => {
    getDatabase.mockReturnValue(makeDb());

    const result = await checkPipelineHealth({
      jobKey: 'wi-1243-watchdog-info',
      dryRun: false,
      skipHeartbeat: true,
      checksOverride: {
        info_warning: async () => ({
          ok: false,
          reason: 'informational watchdog warning',
          healthClass: 'WATCHDOG_INFO',
        }),
      },
    });

    expect(markJobRunSuccess).toHaveBeenCalled();
    expect(markJobRunFailure).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      allOk: false,
      exitCode: 0,
      jobStatus: 'success',
    });
    expect(result.healthIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkName: 'info_warning',
          healthClass: 'WATCHDOG_INFO',
          fatal: false,
        }),
      ]),
    );

    await createJob('check_pipeline_health', async () => result);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
