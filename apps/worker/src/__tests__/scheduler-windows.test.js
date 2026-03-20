/**
 * Scheduler Window Logic Integration Test
 *
 * Validates:
 * 1. T-minus windows trigger correctly based on game start times
 *    (e.g., a game 150 minutes away does NOT trigger T-120; T-120 triggers only within 120 ± tolerance)
 * 2. Fixed-time windows trigger at correct hour boundaries
 * 3. Job idempotency prevents re-running successful windows
 * 4. Failed jobs can retry
 */

const fs = require('fs');
const {
  initDb,
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  runMigrations,
  shouldRunJobKey,
} = require('@cheddar-logic/data');

const TEST_DB_PATH = '/tmp/cheddar-test-scheduler.db';

/**
 * Compute due T-minus windows for a game
 * @param {string} gameStartUtc - ISO 8601 game start time
 * @param {string} nowUtc - Current time ISO 8601
 * @returns {number[]} - List of due T-minus values (e.g., [120, 90])
 */
function computeDueTminusWindows(gameStartUtc, nowUtc) {
  const gameTime = new Date(gameStartUtc).getTime();
  const now = new Date(nowUtc).getTime();
  const deltaMins = Math.floor((gameTime - now) / 60000);

  const windows = [];
  const targets = [120, 90, 60, 30];
  const tolerance = 5; // +/- 5 minutes

  for (const target of targets) {
    if (deltaMins >= target - tolerance && deltaMins <= target + tolerance) {
      windows.push(target);
    }
  }

  return windows;
}

/**
 * Generate deterministic job key for a window
 */
function makeJobKey(sport, windowType, context, value) {
  return `${sport}|${windowType}|${context}|${value}`;
}

async function runSchedulerWindowTests() {
  console.log('🧪 Starting Scheduler Window Integration Tests...\n');

  try {
    await initDb();
    const db = getDatabase();

    // Clean up test data
    console.log('📝 Cleaning up test data...');
    db.prepare(`DELETE FROM job_runs WHERE job_key LIKE '%test-game-%'`).run();
    console.log('✓ Cleaned\n');

    // Test 1: T-120 window detection
    console.log('🧪 Test 1: T-120 window triggers correctly');
    const gameStart = '2026-02-27T20:00:00Z'; // 8pm UTC
    const nowT120 = '2026-02-27T18:00:00Z'; // 6pm UTC (exactly T-120)

    const windows1 = computeDueTminusWindows(gameStart, nowT120);
    if (windows1.includes(120) && windows1.length === 1) {
      console.log('✅ PASS: T-120 detected at correct time');
      console.log(`   Delta: 120 minutes, windows: [${windows1}]\n`);
    } else {
      console.log(`❌ FAIL: Expected [120], got [${windows1}]`);
      throw new Error(`Expected [120], got [${windows1}]`);
    }

    // Test 2: Mark window as successful and verify skip
    console.log('🧪 Test 2: Successful window prevents re-run');
    const gameId = 'test-game-nhl-2026-02-27-van-sea';
    const jobKey120 = makeJobKey('nhl', 'tminus', gameId, '120');

    console.log(`   Job key: ${jobKey120}`);

    // First check: should run
    if (!shouldRunJobKey(jobKey120)) {
      console.log('❌ FAIL: shouldRunJobKey returned false before first run');
      throw new Error('shouldRunJobKey returned false before first run');
    }
    console.log('   ✓ shouldRunJobKey: true (first run)');

    // Simulate successful run
    const runId = `job-test-${Date.now()}`;
    insertJobRun('run_nhl_model', runId, jobKey120);
    markJobRunSuccess(runId);
    console.log('   ✓ Marked as successful');

    // Second check: should skip
    if (shouldRunJobKey(jobKey120)) {
      console.log('❌ FAIL: shouldRunJobKey returned true after success');
      throw new Error('shouldRunJobKey returned true after success');
    }
    console.log('   ✅ PASS: shouldRunJobKey: false (skip after success)\n');

    // Test 3: T-30 window triggers independently
    console.log('🧪 Test 3: T-30 window triggers independently');
    const nowT30 = '2026-02-27T19:30:00Z'; // 7:30pm UTC (T-30)
    const windows3 = computeDueTminusWindows(gameStart, nowT30);

    if (windows3.includes(30) && windows3.length === 1) {
      console.log('✅ PASS: T-30 detected at correct time');
      console.log(`   Delta: 30 minutes, windows: [${windows3}]`);
    } else {
      console.log(`❌ FAIL: Expected [30], got [${windows3}]`);
      throw new Error(`Expected [30], got [${windows3}]`);
    }

    const jobKey30 = makeJobKey('nhl', 'tminus', gameId, '30');
    if (!shouldRunJobKey(jobKey30)) {
      console.log('❌ FAIL: T-30 should run (different window from T-120)');
      throw new Error('T-30 should run (different window from T-120)');
    }
    console.log('   ✅ PASS: T-30 can run (independent from T-120)\n');

    // Test 4: Failed jobs can retry
    console.log('🧪 Test 4: Failed jobs allow retry');
    const jobKeyFailed = makeJobKey('nhl', 'tminus', gameId, '60');

    // Simulate failed run
    const failedRunId = `job-test-failed-${Date.now()}`;
    insertJobRun('run_nhl_model', failedRunId, jobKeyFailed);
    markJobRunFailure(failedRunId, 'Test error');
    console.log('   ✓ Marked as failed');

    // Check if retry allowed
    if (!shouldRunJobKey(jobKeyFailed)) {
      console.log(
        '❌ FAIL: shouldRunJobKey returned false after failure (should allow retry)',
      );
      throw new Error(
        'shouldRunJobKey returned false after failure (should allow retry)',
      );
    }
    console.log('   ✅ PASS: Failed jobs can retry\n');

    // Test 5: Running jobs prevent overlap
    console.log('🧪 Test 5: Running jobs prevent overlap');
    const jobKeyRunning = makeJobKey('nhl', 'tminus', gameId, '90');

    // Simulate running job (not marked complete)
    const runningRunId = `job-test-running-${Date.now()}`;
    insertJobRun('run_nhl_model', runningRunId, jobKeyRunning);
    console.log('   ✓ Job marked as running (not complete)');

    // Check if skipped
    if (shouldRunJobKey(jobKeyRunning)) {
      console.log(
        '❌ FAIL: shouldRunJobKey returned true for running job (should prevent overlap)',
      );
      throw new Error(
        'shouldRunJobKey returned true for running job (should prevent overlap)',
      );
    }
    console.log('   ✅ PASS: Running jobs prevent overlap\n');

    // Test 6: Window tolerance (edge cases)
    console.log('🧪 Test 6: Window tolerance edge cases');

    // Just outside T-120 range (126 mins before, outside [115, 125])
    const nowTooEarly = '2026-02-27T17:54:00Z';
    const windowsTooEarly = computeDueTminusWindows(gameStart, nowTooEarly);
    if (windowsTooEarly.length === 0) {
      console.log(
        '   ✅ PASS: T-126 (outside tolerance) does not trigger T-120',
      );
    } else {
      console.log(
        `   ❌ FAIL: Expected [], got [${windowsTooEarly}] for delta=126`,
      );
      throw new Error(`Expected [], got [${windowsTooEarly}] for delta=126`);
    }

    // Just inside T-120 range (118 mins before, inside [115, 125])
    const nowJustInside = '2026-02-27T18:02:00Z';
    const windowsJustInside = computeDueTminusWindows(gameStart, nowJustInside);
    if (windowsJustInside.includes(120)) {
      console.log('   ✅ PASS: T-118 (within tolerance) triggers T-120\n');
    } else {
      console.log(
        `   ❌ FAIL: Expected [120], got [${windowsJustInside}] for delta=118`,
      );
      throw new Error(
        `Expected [120], got [${windowsJustInside}] for delta=118`,
      );
    }

    // Cleanup
    console.log('🧹 Cleaning up test data...');
    db.prepare(`DELETE FROM job_runs WHERE job_key LIKE '%test-game-%'`).run();
    console.log('✓ Cleaned\n');

    console.log('✅ All scheduler window tests passed!\n');
  } catch (error) {
    console.error('❌ Test error:', error);
    throw error;
  }
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB_PATH;
  process.env.RECORD_DATABASE_PATH = '';
  process.env.CHEDDAR_DB_PATH = '';
  process.env.DATABASE_URL = '';
  process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
  await runMigrations();
});

afterAll(() => {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
});

test('scheduler windows integration', async () => {
  await runSchedulerWindowTests();
});

if (require.main === module) {
  runSchedulerWindowTests()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

function loadSchedulerModuleForDiscord() {
  jest.resetModules();

  jest.doMock('@cheddar-logic/data', () => ({
    initDb: jest.fn(),
    getUpcomingGames: jest.fn(() => []),
    shouldRunJobKey: jest.fn(() => true),
    hasRunningJobRun: jest.fn(() => false),
    wasJobRecentlySuccessful: jest.fn((jobName) => {
      if (jobName === 'pull_odds_hourly') return true;
      return false;
    }),
  }));

  jest.doMock('../jobs/pull_odds_hourly', () => ({ pullOddsHourly: jest.fn() }));
  jest.doMock('../jobs/refresh_stale_odds', () => ({ refreshStaleOdds: jest.fn() }));
  jest.doMock('../jobs/run_nhl_model', () => ({ runNHLModel: jest.fn() }));
  jest.doMock('../jobs/run_nba_model', () => ({ runNBAModel: jest.fn() }));
  jest.doMock('../jobs/run_fpl_model', () => ({ runFPLModel: jest.fn() }));
  jest.doMock('../jobs/run_nfl_model', () => ({ runNFLModel: jest.fn() }));
  jest.doMock('../jobs/run_mlb_model', () => ({ runMLBModel: jest.fn() }));
  jest.doMock('../jobs/run_soccer_model', () => ({ runSoccerModel: jest.fn() }));
  jest.doMock('../jobs/pull_soccer_player_props', () => ({ pullSoccerPlayerProps: jest.fn() }));
  jest.doMock('../jobs/pull_soccer_xg_stats', () => ({ pullSoccerXgStats: jest.fn() }));
  jest.doMock('../jobs/run_ncaam_model', () => ({ runNCAAMModel: jest.fn() }));
  jest.doMock('../jobs/refresh_ncaam_ft_csv', () => ({ runRefreshNcaamFtCsv: jest.fn() }));
  jest.doMock('../jobs/sync_game_statuses', () => ({ syncGameStatuses: jest.fn() }));
  jest.doMock('../jobs/settle_game_results', () => ({ settleGameResults: jest.fn() }));
  jest.doMock('../jobs/settle_pending_cards', () => ({ settlePendingCards: jest.fn() }));
  jest.doMock('../jobs/backfill_card_results', () => ({ backfillCardResults: jest.fn() }));
  jest.doMock('../jobs/check_pipeline_health', () => ({ checkPipelineHealth: jest.fn() }));
  jest.doMock('../jobs/refresh_team_metrics_daily', () => ({ run: jest.fn() }));
  jest.doMock('../jobs/sync_nhl_sog_player_ids', () => ({ syncNhlSogPlayerIds: jest.fn() }));
  jest.doMock('../jobs/sync_nhl_player_availability', () => ({ syncNhlPlayerAvailability: jest.fn() }));
  jest.doMock('../jobs/post_discord_cards', () => ({ postDiscordCards: jest.fn() }));

  return require('../schedulers/main');
}

describe('scheduler Discord webhook windows', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.ENABLE_ODDS_PULL = 'false';
    process.env.ENABLE_SETTLEMENT = 'false';
    process.env.ENABLE_NHL_MODEL = 'false';
    process.env.ENABLE_NBA_MODEL = 'false';
    process.env.ENABLE_NCAAM_MODEL = 'false';
    process.env.ENABLE_SOCCER_MODEL = 'false';
    process.env.ENABLE_FPL_MODEL = 'false';
    process.env.ENABLE_NFL_MODEL = 'false';
    process.env.ENABLE_MLB_MODEL = 'false';
    process.env.ENABLE_NHL_PLAYER_AVAILABILITY_SYNC = 'false';
    process.env.ENABLE_DISCORD_CARD_WEBHOOKS = 'true';
    process.env.DISCORD_CARD_WEBHOOK_URL = 'https://discord.example/webhook';
    process.env.FIXED_CATCHUP = 'false';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('queues discord snapshot at 18:00 ET fixed window with deterministic key', () => {
    const scheduler = loadSchedulerModuleForDiscord();
    const { DateTime } = require('luxon');

    const nowEt = DateTime.fromISO('2026-03-20T18:02:00', {
      zone: 'America/New_York',
    });
    const nowUtc = nowEt.toUTC();

    const dueJobs = scheduler.computeDueJobs({
      nowEt,
      nowUtc,
      games: [],
      dryRun: true,
    });

    const discordJob = dueJobs.find((job) => job.jobName === 'post_discord_cards');
    expect(discordJob).toBeDefined();
    expect(discordJob.jobKey).toBe('discord_cards|fixed|2026-03-20|1800');
    expect(discordJob.reason).toContain('18:00 ET');
  });

  test('does not queue discord snapshot outside fixed windows', () => {
    const scheduler = loadSchedulerModuleForDiscord();
    const { DateTime } = require('luxon');

    const nowEt = DateTime.fromISO('2026-03-20T10:15:00', {
      zone: 'America/New_York',
    });
    const nowUtc = nowEt.toUTC();

    const dueJobs = scheduler.computeDueJobs({
      nowEt,
      nowUtc,
      games: [],
      dryRun: true,
    });

    const discordJob = dueJobs.find((job) => job.jobName === 'post_discord_cards');
    expect(discordJob).toBeUndefined();
  });
});
