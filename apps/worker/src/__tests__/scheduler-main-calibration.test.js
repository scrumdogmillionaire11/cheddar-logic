'use strict';

/**
 * WI-0860: Verify run_calibration_report is scheduled at 04:00 ET nightly.
 */

const { DateTime } = require('luxon');

const TZ = 'America/New_York';

function loadSchedulerModule() {
  jest.resetModules();

  jest.doMock('@cheddar-logic/data', () => ({
    getUpcomingGames: jest.fn(() => []),
    shouldRunJobKey: jest.fn(() => true),
    hasRunningJobRun: jest.fn(() => false),
    hasRunningJobName: jest.fn(() => false),
    wasJobRecentlySuccessful: jest.fn(() => true),
    claimTminusPullSlot: jest.fn(() => true),
    purgeStaleTminusPullLog: jest.fn(),
    purgeStalePropOddsUsageLog: jest.fn(),
    purgeExpiredPropEventMappings: jest.fn(),
    recoverStaleJobRuns: jest.fn(() => 0),
  }));

  jest.doMock('../jobs/pull_odds_hourly', () => ({ pullOddsHourly: jest.fn() }));
  jest.doMock('../jobs/refresh_stale_odds', () => ({ refreshStaleOdds: jest.fn() }));
  jest.doMock('../jobs/pull_espn_games_direct', () => ({ pullEspnGamesDirect: jest.fn() }));
  jest.doMock('../jobs/run_nhl_model', () => ({ runNHLModel: jest.fn() }));
  jest.doMock('../jobs/run_nba_model', () => ({ runNBAModel: jest.fn() }));
  jest.doMock('../jobs/run_fpl_model', () => ({ runFPLModel: jest.fn() }));
  jest.doMock('../jobs/run_nfl_model', () => ({ runNFLModel: jest.fn() }));
  jest.doMock('../jobs/run_mlb_model', () => ({ runMLBModel: jest.fn() }));
  jest.doMock('../jobs/settle_game_results', () => ({ settleGameResults: jest.fn() }));
  jest.doMock('../jobs/settle_pending_cards', () => ({ settlePendingCards: jest.fn() }));
  jest.doMock('../jobs/backfill_card_results', () => ({ backfillCardResults: jest.fn() }));
  jest.doMock('../jobs/check_pipeline_health', () => ({ checkPipelineHealth: jest.fn() }));
  jest.doMock('../jobs/check_odds_health', () => ({ checkOddsHealth: jest.fn() }));
  jest.doMock('../jobs/refresh_team_metrics_daily', () => ({ run: jest.fn() }));
  jest.doMock('../jobs/sync_nhl_sog_player_ids', () => ({ syncNhlSogPlayerIds: jest.fn() }));
  jest.doMock('../jobs/sync_nhl_player_availability', () => ({ syncNhlPlayerAvailability: jest.fn() }));
  jest.doMock('../jobs/pull_schedule_nba', () => ({ pullScheduleNba: jest.fn() }));
  jest.doMock('../jobs/pull_schedule_nhl', () => ({ pullScheduleNhl: jest.fn() }));
  jest.doMock('../jobs/post_discord_cards', () => ({ postDiscordCards: jest.fn() }));
  jest.doMock('../jobs/potd/run_potd_engine', () => ({ runPotdEngine: jest.fn() }));
  jest.doMock('../jobs/potd/settlement-mirror', () => ({ mirrorPotdSettlement: jest.fn() }));
  jest.doMock('../jobs/run_clv_snapshot', () => ({ runClvSnapshot: jest.fn() }));
  jest.doMock('../jobs/run_daily_performance_report', () => ({ runDailyPerformanceReport: jest.fn() }));
  jest.doMock('../jobs/run_calibration_report', () => ({ runCalibrationReport: jest.fn() }));

  return require('../schedulers/main');
}

describe('scheduler: run_calibration_report nightly at 04:00 ET (WI-0860)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.ENABLE_ODDS_PULL = 'false';
    process.env.ENABLE_SETTLEMENT = 'true';
    process.env.ENABLE_NBA_MODEL = 'false';
    process.env.ENABLE_NHL_MODEL = 'false';
    process.env.ENABLE_FPL_MODEL = 'false';
    process.env.ENABLE_NFL_MODEL = 'false';
    process.env.ENABLE_MLB_MODEL = 'false';
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'false';
    process.env.ENABLE_ODDS_HEALTH_WATCHDOG = 'false';
    process.env.ENABLE_POTD = 'false';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('queues run_calibration_report at exactly 04:00 ET', () => {
    const scheduler = loadSchedulerModule();

    const nowEt = DateTime.fromISO('2026-04-10T04:00:00', { zone: TZ });
    const nowUtc = nowEt.toUTC();

    const jobs = scheduler.computeDueJobs({ nowEt, nowUtc, games: [], dryRun: false });
    const calibJob = jobs.find((j) => j.jobName === 'run_calibration_report');

    expect(calibJob).toBeDefined();
    expect(calibJob.jobKey).toBe('calibration_report|2026-04-10');
    expect(calibJob.reason).toMatch(/nightly calibration report/i);
  });

  test('job key is date-unique: calibration_report|YYYY-MM-DD', () => {
    const scheduler = loadSchedulerModule();

    const nowEt = DateTime.fromISO('2026-04-11T04:00:00', { zone: TZ });
    const nowUtc = nowEt.toUTC();

    const jobs = scheduler.computeDueJobs({ nowEt, nowUtc, games: [], dryRun: false });
    const calibJob = jobs.find((j) => j.jobName === 'run_calibration_report');

    expect(calibJob).toBeDefined();
    expect(calibJob.jobKey).toBe('calibration_report|2026-04-11');
  });

  test('does NOT queue run_calibration_report at 03:00 ET', () => {
    const scheduler = loadSchedulerModule();

    const nowEt = DateTime.fromISO('2026-04-10T03:00:00', { zone: TZ });
    const nowUtc = nowEt.toUTC();

    const jobs = scheduler.computeDueJobs({ nowEt, nowUtc, games: [], dryRun: false });
    const calibJob = jobs.find((j) => j.jobName === 'run_calibration_report');

    expect(calibJob).toBeUndefined();
  });

  test('does NOT queue run_calibration_report when ENABLE_SETTLEMENT=false', () => {
    process.env.ENABLE_SETTLEMENT = 'false';
    const scheduler = loadSchedulerModule();

    const nowEt = DateTime.fromISO('2026-04-10T04:00:00', { zone: TZ });
    const nowUtc = nowEt.toUTC();

    const jobs = scheduler.computeDueJobs({ nowEt, nowUtc, games: [], dryRun: false });
    const calibJob = jobs.find((j) => j.jobName === 'run_calibration_report');

    expect(calibJob).toBeUndefined();
  });
});
