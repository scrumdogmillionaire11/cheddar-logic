'use strict';

/**
 * WI-0860: Verify run_calibration_report is scheduled at 04:00 ET nightly.
 */

const { DateTime } = require('luxon');

const TZ = 'America/New_York';
let mockWasJobRecentlySuccessful;
let mockRunNBAModel;
let mockRunMLBModel;
let mockPullEspnGamesDirect;

function loadSchedulerModule() {
  jest.resetModules();

  mockWasJobRecentlySuccessful = jest.fn(() => true);
  mockRunNBAModel = jest.fn();
  mockRunMLBModel = jest.fn();
  mockPullEspnGamesDirect = jest.fn();

  jest.doMock('@cheddar-logic/data', () => ({
    getUpcomingGames: jest.fn(() => []),
    shouldRunJobKey: jest.fn(() => true),
    hasRunningJobRun: jest.fn(() => false),
    hasRunningJobName: jest.fn(() => false),
    wasJobKeyRecentlySuccessful: mockWasJobRecentlySuccessful,
    wasJobRecentlySuccessful: mockWasJobRecentlySuccessful,
    claimTminusPullSlot: jest.fn(() => true),
    purgeStaleTminusPullLog: jest.fn(),
    purgeStalePropOddsUsageLog: jest.fn(),
    purgeExpiredPropEventMappings: jest.fn(),
    recoverStaleJobRuns: jest.fn(() => 0),
  }));

  jest.doMock('../jobs/pull_odds_hourly', () => ({ pullOddsHourly: jest.fn() }));
  jest.doMock('../jobs/refresh_stale_odds', () => ({ refreshStaleOdds: jest.fn() }));
  jest.doMock('../jobs/pull_espn_games_direct', () => ({ pullEspnGamesDirect: mockPullEspnGamesDirect }));
  jest.doMock('../jobs/run_nhl_model', () => ({ runNHLModel: jest.fn() }));
  jest.doMock('../jobs/run_nba_model', () => ({ runNBAModel: mockRunNBAModel }));
  jest.doMock('../jobs/run_fpl_model', () => ({ runFPLModel: jest.fn() }));
  jest.doMock('../jobs/run_nfl_model', () => ({ runNFLModel: jest.fn() }));
  jest.doMock('../jobs/run_mlb_model', () => ({ runMLBModel: mockRunMLBModel }));
  jest.doMock('../jobs/settle_game_results', () => ({ settleGameResults: jest.fn() }));
  jest.doMock('../jobs/settle_pending_cards', () => ({ settlePendingCards: jest.fn() }));
  jest.doMock('../jobs/settle_mlb_f5', () => ({ settleMlbF5: jest.fn() }));
  jest.doMock('../jobs/backfill_card_results', () => ({ backfillCardResults: jest.fn() }));
  jest.doMock('../jobs/report_settlement_health', () => ({ generateSettlementHealthReport: jest.fn() }));
  jest.doMock('../jobs/pull_public_splits', () => ({ runPullPublicSplits: jest.fn() }));
  jest.doMock('../jobs/pull_vsin_splits', () => ({ runPullVsinSplits: jest.fn() }));
  jest.doMock('../jobs/sync_game_statuses', () => ({ syncGameStatuses: jest.fn() }));
  jest.doMock('../jobs/settle_projections', () => ({ settleProjections: jest.fn() }));
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
  jest.doMock('../jobs/run_residual_validation', () => ({ run: jest.fn() }));
  jest.doMock('../jobs/fit_calibration_models', () => ({ run: jest.fn() }));
  jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
    isFeatureEnabled: jest.fn((sport, feature) => {
      const s = String(sport || '').toLowerCase();
      const f = String(feature || '').toLowerCase();

      if (f !== 'model') return false;
      if (s === 'nba') return process.env.ENABLE_NBA_MODEL === 'true';
      if (s === 'mlb') return process.env.ENABLE_MLB_MODEL === 'true';
      if (s === 'nhl') return process.env.ENABLE_NHL_MODEL === 'true';
      if (s === 'nfl') return process.env.ENABLE_NFL_MODEL === 'true';
      return false;
    }),
  }));
  jest.doMock('@cheddar-logic/odds/src/config', () => ({
    SPORTS_CONFIG: {
      NHL: { active: true },
      NBA: { active: true },
      MLB: { active: true },
      NFL: { active: false },
    },
  }));

  return require('../schedulers/main');
}

describe('scheduler: run_calibration_report nightly at 04:00 ET (WI-0860)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    jest.useRealTimers();
    process.env.ENABLE_ODDS_PULL = 'false';
    process.env.REQUIRE_FRESH_ODDS_FOR_MODELS = 'true';
    process.env.ENABLE_SETTLEMENT = 'true';
    process.env.ENABLE_NBA_MODEL = 'false';
    process.env.ENABLE_NHL_MODEL = 'false';
    process.env.ENABLE_FPL_MODEL = 'false';
    process.env.ENABLE_NFL_MODEL = 'false';
    process.env.ENABLE_MLB_MODEL = 'false';
    process.env.ENABLE_PULL_SCHEDULE_NBA = 'false';
    process.env.ENABLE_PULL_SCHEDULE_NHL = 'false';
    process.env.ENABLE_TEAM_METRICS_CACHE = 'false';
    process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'false';
    process.env.ENABLE_ODDS_HEALTH_WATCHDOG = 'false';
    process.env.ENABLE_POTD = 'false';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  afterEach(() => {
    jest.useRealTimers();
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

  test('nightly reporting jobs receive deterministic jobKey args for idempotent execution', () => {
    const scheduler = loadSchedulerModule();

    const nowEt = DateTime.fromISO('2026-04-10T06:00:00', { zone: TZ });
    const nowUtc = nowEt.toUTC();

    const jobs = scheduler.computeDueJobs({ nowEt, nowUtc, games: [], dryRun: false });

    expect(jobs.find((j) => j.jobName === 'run_clv_snapshot')?.args).toEqual({
      jobKey: 'clv_snapshot|2026-04-10',
      dryRun: false,
    });
    expect(jobs.find((j) => j.jobName === 'run_daily_performance_report')?.args).toEqual({
      jobKey: 'perf_report|2026-04-10',
      dryRun: false,
    });
    expect(jobs.find((j) => j.jobName === 'run_calibration_report')?.args).toEqual({
      jobKey: 'calibration_report|2026-04-10',
      dryRun: false,
    });
    expect(jobs.find((j) => j.jobName === 'run_residual_validation')?.args).toEqual({
      jobKey: 'run_residual_validation|2026-04-10',
      dryRun: false,
    });
    expect(jobs.find((j) => j.jobName === 'fit_calibration_models')?.args).toEqual({
      jobKey: 'fit_calibration_models|2026-04-10',
      dryRun: false,
    });
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

  test('MLB default scheduler descriptor uses odds-backed freshness gating', () => {
    process.env.ENABLE_MLB_MODEL = 'true';
    const scheduler = loadSchedulerModule();

    const nowEt = DateTime.fromISO('2026-04-10T12:00:00', { zone: TZ });
    const nowUtc = nowEt.toUTC();

    const jobs = scheduler.computeDueJobs({ nowEt, nowUtc, games: [], dryRun: false });
    const mlbJob = jobs.find((j) => j.jobName === 'run_mlb_model');

    expect(mlbJob).toBeDefined();
    expect(mlbJob.requireFreshInputs).toBe(true);
    expect(mlbJob.freshnessSourceJobs).toEqual(['pull_odds_hourly']);
    expect(mlbJob.runMode).toBe('ODDS_BACKED');
    expect(mlbJob.withoutOddsMode).toBe(false);
  });

  test('tick blocks MLB when fresh odds are required and stale', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-10T16:00:00Z'));
    process.env.ENABLE_ODDS_PULL = 'true';
    process.env.ENABLE_SETTLEMENT = 'false';
    process.env.ENABLE_MLB_MODEL = 'true';
    const scheduler = loadSchedulerModule();
    mockWasJobRecentlySuccessful.mockReturnValue(false);

    await scheduler.tick();

    expect(mockRunMLBModel).not.toHaveBeenCalled();
  });

  test('tick still blocks NBA when fresh inputs are required and stale', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-10T16:00:00Z'));
    process.env.ENABLE_ODDS_PULL = 'true';
    process.env.ENABLE_SETTLEMENT = 'false';
    process.env.ENABLE_NBA_MODEL = 'true';
    const scheduler = loadSchedulerModule();
    mockWasJobRecentlySuccessful.mockReturnValue(false);

    await scheduler.tick();

    expect(mockRunNBAModel).not.toHaveBeenCalled();
  });

  test('hourly settlement queues settle_pending_cards before settle_mlb_f5', () => {
    process.env.ENABLE_MLB_MODEL = 'true';
    const scheduler = loadSchedulerModule();

    const nowEt = DateTime.fromISO('2026-04-10T01:02:00', { zone: TZ });
    const nowUtc = nowEt.toUTC();

    const jobs = scheduler.computeDueJobs({ nowEt, nowUtc, games: [], dryRun: true });
    const pendingIndex = jobs.findIndex((j) => j.jobName === 'settle_pending_cards');
    const f5Index = jobs.findIndex((j) => j.jobName === 'settle_mlb_f5');

    expect(pendingIndex).toBeGreaterThanOrEqual(0);
    expect(f5Index).toBeGreaterThanOrEqual(0);
    expect(pendingIndex).toBeLessThan(f5Index);
  });

  test('nightly settlement queues settle_pending_cards before settle_mlb_f5 at 02:00 ET (WI-0860)', () => {
    process.env.ENABLE_MLB_MODEL = 'true';
    const scheduler = loadSchedulerModule();

    const nowEt = DateTime.fromISO('2026-04-10T02:02:00', { zone: TZ });
    const nowUtc = nowEt.toUTC();

    const jobs = scheduler.computeDueJobs({ nowEt, nowUtc, games: [], dryRun: true });
    const pendingIndex = jobs.findIndex((j) => j.jobName === 'settle_pending_cards');
    const f5Index = jobs.findIndex((j) => j.jobName === 'settle_mlb_f5');

    expect(
      jobs.some(
        (j) =>
          j.jobName === 'settle_pending_cards' &&
          j.jobKey === 'settle|nightly|2026-04-10|pending-cards',
      ),
    ).toBe(true);
    expect(pendingIndex).toBeGreaterThanOrEqual(0);
    expect(f5Index).toBeGreaterThanOrEqual(0);
    expect(pendingIndex).toBeLessThan(f5Index);
  });
});

// ============================================================
// WI-0951: MLB T-minus freshness override — pre-model pull and logging
// ============================================================

describe('MLB T-minus freshness override — pre-model pull and logging (WI-0951)', () => {
  const { DateTime } = require('luxon');
  let claimTminusPullSlotMock;

  function buildMlbContext(claimFn) {
    return {
      nowUtc: null, // set per-test
      games: [],
      dryRun: true,
      quotaTier: 'FULL',
      maybeQueueTeamMetricsRefresh: jest.fn(),
      claimTminusPullSlot: claimFn || jest.fn(() => true),
      pullOddsHourly: jest.fn(),
      ENABLE_WITHOUT_ODDS_MODE: false,
      ODDS_SPORTS_CONFIG: {},
    };
  }

  function computeMlbJobsForGame(gameMinutesFromNow, claimFn) {
    jest.resetModules();
    // Re-setup feature flag mock after module reset (outer beforeEach sets ENABLE_MLB_MODEL=false)
    jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
      isFeatureEnabled: jest.fn((sport, feature) => sport === 'mlb' && feature === 'model'),
    }));
    const { computeMlbDueJobs } = require('../schedulers/mlb');
    // Set nowUtc so that the game starts in exactly gameMinutesFromNow minutes
    const nowUtc = DateTime.fromISO('2026-04-15T19:00:00Z', { zone: 'utc' });
    // Place game start at nowUtc + gameMinutesFromNow. We need to land within a TMINUS_BAND.
    // TMINUS_BANDS: [120±5, 90±5, 60±5, 30±5]. Use T-30 band (28–30 min range) for band 45 tests.
    const startUtc = nowUtc.plus({ minutes: gameMinutesFromNow });
    const nowEt = nowUtc.setZone('America/New_York');
    const ctx = buildMlbContext(claimFn);
    ctx.nowUtc = nowUtc;
    ctx.games = [{ game_id: 'mlb_test_game_1', sport: 'mlb', game_time_utc: startUtc.toISO() }];
    return computeMlbDueJobs(nowEt, ctx);
  }

  beforeEach(() => {
    jest.resetModules();
    claimTminusPullSlotMock = jest.fn(() => true);
    // Enable MLB model
    jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
      isFeatureEnabled: jest.fn((sport, feature) => {
        if (sport === 'mlb' && feature === 'model') return true;
        return false;
      }),
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Ensure windows module mock from FALLBACK_BASELINE test doesn't leak into subsequent tests
    jest.unmock('../schedulers/windows');
  });

  test('minutesToGame in 16-45 range (band 45): pull_odds_hourly premodel appears before T-minus run_mlb_model', () => {
    // T-30 band: game starts in 28-30 min, minutesToGame ~30, which falls in band 45 (16-45)
    jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
      isFeatureEnabled: jest.fn((sport, feature) => sport === 'mlb' && feature === 'model'),
    }));
    const jobs = computeMlbJobsForGame(28, jest.fn(() => true));
    const oddsPremodelIdx = jobs.findIndex(
      (j) => j.jobName === 'pull_odds_hourly' && j.jobKey && j.jobKey.includes('premodel'),
    );
    const tminusModelIdx = jobs.findIndex(
      (j) => j.jobName === 'run_mlb_model' && j.jobKey && j.jobKey.includes('tminus'),
    );
    expect(oddsPremodelIdx).toBeGreaterThanOrEqual(0);
    expect(tminusModelIdx).toBeGreaterThanOrEqual(0);
    expect(oddsPremodelIdx).toBeLessThan(tminusModelIdx);
  });

  test('pull_odds_hourly job key uses pull-odds:mlb:premodel:... schema', () => {
    jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
      isFeatureEnabled: jest.fn((sport, feature) => sport === 'mlb' && feature === 'model'),
    }));
    const jobs = computeMlbJobsForGame(28, jest.fn(() => true));
    const oddsJob = jobs.find((j) => j.jobName === 'pull_odds_hourly');
    expect(oddsJob).toBeDefined();
    expect(oddsJob.jobKey).toMatch(/^pull-odds:mlb:premodel:/);
    expect(oddsJob.jobKey).toContain('mlb_test_game_1');
    expect(oddsJob.jobKey).toContain(':45:');
  });

  test('minutesToGame in 91-180 range (band 180, triggerPreModelRefresh=false): no pre-model odds pull', () => {
    // T-120 band: game starts in 117 min (within [115,120] tolerance), minutesToGame ~117 => band 180
    jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
      isFeatureEnabled: jest.fn((sport, feature) => sport === 'mlb' && feature === 'model'),
    }));
    const jobs = computeMlbJobsForGame(118, jest.fn(() => true));
    const oddsPremodelJob = jobs.find(
      (j) => j.jobName === 'pull_odds_hourly' && j.jobKey && j.jobKey.includes('premodel'),
    );
    expect(oddsPremodelJob).toBeUndefined();
  });

  test('EXECUTION_FRESHNESS_TMINUS log emitted with ALLOW for band 180 (triggerPreModelRefresh=false)', () => {
    jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
      isFeatureEnabled: jest.fn((sport, feature) => sport === 'mlb' && feature === 'model'),
    }));
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    computeMlbJobsForGame(118, jest.fn(() => true));
    const calls = consoleSpy.mock.calls.map((c) => {
      try { return JSON.parse(c[0]); } catch { return null; }
    }).filter(Boolean);
    const freshnessLog = calls.find((c) => c.type === 'EXECUTION_FRESHNESS_TMINUS');
    expect(freshnessLog).toBeDefined();
    expect(freshnessLog.matched_band).toBe(180);
    expect(freshnessLog.decision).toBe('ALLOW');
    consoleSpy.mockRestore();
  });

  test('EXECUTION_FRESHNESS_TMINUS log emitted with ALLOW_AFTER_REFRESH for triggered band (band 45)', () => {
    jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
      isFeatureEnabled: jest.fn((sport, feature) => sport === 'mlb' && feature === 'model'),
    }));
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    computeMlbJobsForGame(28, jest.fn(() => true));
    const calls = consoleSpy.mock.calls.map((c) => {
      try { return JSON.parse(c[0]); } catch { return null; }
    }).filter(Boolean);
    const freshnessLog = calls.find((c) => c.type === 'EXECUTION_FRESHNESS_TMINUS');
    expect(freshnessLog).toBeDefined();
    expect(freshnessLog.matched_band).toBe(45);
    expect(freshnessLog.decision).toBe('ALLOW_AFTER_REFRESH');
    expect(freshnessLog.triggered_refresh).toBe(true);
    consoleSpy.mockRestore();
  });

  test('EXECUTION_FRESHNESS_TMINUS log emitted with FALLBACK_BASELINE when minutesToGame > 180', () => {
    // minutesToGame > 180 means no override row matches; we need a game far enough out
    // but still in a TMINUS_BAND (which max at T-120). Since max TMINUS_BAND is 120 mins,
    // minutesToGame will never exceed 125. So let's use a custom override ladder with no match.
    // Instead, test via computeMlbDueJobs directly with a game at 118 min (band 180) but
    // use a custom overrides ladder that excludes 118. We can do this by injecting a
    // mocked windows module.
    // Actually: minutesToGame > 180 never happens in TMINUS_BANDS (max is ~125).
    // We test FALLBACK_BASELINE by mocking resolveTMinusFreshnessOverride to return null.
    jest.resetModules();
    jest.doMock('@cheddar-logic/data/src/feature-flags', () => ({
      isFeatureEnabled: jest.fn((sport, feature) => sport === 'mlb' && feature === 'model'),
    }));
    jest.doMock('../schedulers/windows', () => ({
      ...jest.requireActual('../schedulers/windows'),
      resolveTMinusFreshnessOverride: jest.fn(() => null),
    }));
    const { computeMlbDueJobs } = require('../schedulers/mlb');
    const nowUtc = DateTime.fromISO('2026-04-15T19:00:00Z', { zone: 'utc' });
    const startUtc = nowUtc.plus({ minutes: 118 });
    const nowEt = nowUtc.setZone('America/New_York');
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = buildMlbContext(jest.fn(() => true));
    ctx.nowUtc = nowUtc;
    ctx.games = [{ game_id: 'mlb_test_game_fallback', sport: 'mlb', game_time_utc: startUtc.toISO() }];
    computeMlbDueJobs(nowEt, ctx);
    const calls = consoleSpy.mock.calls.map((c) => {
      try { return JSON.parse(c[0]); } catch { return null; }
    }).filter(Boolean);
    const freshnessLog = calls.find((c) => c.type === 'EXECUTION_FRESHNESS_TMINUS');
    expect(freshnessLog).toBeDefined();
    expect(freshnessLog.decision).toBe('FALLBACK_BASELINE');
    expect(freshnessLog.matched_band).toBeNull();
    consoleSpy.mockRestore();
  });

  test('dedupe: same game+band+slot under repeated calls returns only one pull_odds_hourly pre-model job total', () => {
    // First call claims slot (returns true), second call returns false (slot already taken)
    let callCount = 0;
    const claimFn = jest.fn(() => {
      callCount += 1;
      return callCount === 1; // first claim: true; subsequent: false
    });
    const jobs1 = computeMlbJobsForGame(28, claimFn);
    // After computeMlbJobsForGame, modules are reset. We need to call again with same claimFn.
    // computeMlbJobsForGame re-requires the mlb module each time but uses the passed claimFn.
    const jobs2 = computeMlbJobsForGame(28, claimFn);

    const allJobs = [...jobs1, ...jobs2];
    const oddsPremodelJobs = allJobs
      .filter((j) => j.jobName === 'pull_odds_hourly' && j.jobKey && j.jobKey.includes('premodel'));

    // Should have exactly one pre-model pull (first call claimed; second call claimFn returns false, no enqueue)
    expect(oddsPremodelJobs).toHaveLength(1);
    expect(oddsPremodelJobs[0].jobKey).toMatch(/^pull-odds:mlb:premodel:mlb_test_game_1:45:/);
  });
});
