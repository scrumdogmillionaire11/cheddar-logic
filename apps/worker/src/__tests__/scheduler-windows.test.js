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

    // Test 7: Settlement windows remain recurring across hours/days
    console.log('🧪 Test 7: Settlement windows are isolated by sweep key');
    const settleHourOne = 'settle|hourly|2026-03-23|01|game-results';
    const settleHourTwo = 'settle|hourly|2026-03-23|02|game-results';
    const settleNextDay = 'settle|nightly|2026-03-24|game-results';
    const settlementRunId = `job-test-settlement-${Date.now()}`;

    insertJobRun('settle_game_results', settlementRunId, settleHourOne);
    markJobRunSuccess(settlementRunId);
    expect(shouldRunJobKey(settleHourOne)).toBe(false);
    expect(shouldRunJobKey(settleHourTwo)).toBe(true);
    expect(shouldRunJobKey(settleNextDay)).toBe(true);
    console.log('   ✅ PASS: One successful sweep key does not block later sweeps\n');

    // Cleanup
    console.log('🧹 Cleaning up test data...');
    db.prepare(`DELETE FROM job_runs WHERE job_key LIKE '%test-game-%'`).run();
    db.prepare(`DELETE FROM job_runs WHERE job_key LIKE 'settle|%'`).run();
    console.log('✓ Cleaned\n');

    console.log('✅ All scheduler window tests passed!\n');
  } catch (error) {
    console.error('❌ Test error:', error);
    throw error;
  }
}

beforeAll(async () => {
  process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
  process.env.DATABASE_PATH = '';
  process.env.RECORD_DATABASE_PATH = '';
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

test('MLB 09:00 heavy window includes statcast job in correct sequence', () => {
  const { computePlayerPropsDueJobs } = require('../schedulers/player-props');
  const { DateTime } = require('luxon');

  // Simulate 09:01 ET on a weekday — well past 09:00, FIXED_CATCHUP=true (default)
  const nowEt = DateTime.fromObject(
    { year: 2026, month: 4, day: 7, hour: 9, minute: 1, second: 0 },
    { zone: 'America/New_York' },
  );

  const jobs = computePlayerPropsDueJobs(nowEt, { quotaTier: 'FULL' });
  const jobNames = jobs.map((j) => j.jobName);

  expect(jobNames).toContain('pull_mlb_pitcher_stats');
  expect(jobNames).toContain('pull_mlb_statcast');
  expect(jobNames).toContain('pull_mlb_weather');

  const statsIdx    = jobNames.indexOf('pull_mlb_pitcher_stats');
  const statcastIdx = jobNames.indexOf('pull_mlb_statcast');
  const weatherIdx  = jobNames.indexOf('pull_mlb_weather');

  expect(statsIdx).toBeLessThan(statcastIdx);
  expect(statcastIdx).toBeLessThan(weatherIdx);
});

test('NBA and NHL schedule pulls emitted at 04:00 ET', () => {
  const { computeDueJobs } = require('../schedulers/main');
  const { DateTime } = require('luxon');

  const nowEt0400 = DateTime.fromObject(
    { year: 2026, month: 4, day: 6, hour: 4, minute: 5, second: 0 },
    { zone: 'America/New_York' },
  );
  const nowUtc0400 = nowEt0400.toUTC();
  const due0400 = computeDueJobs({ nowEt: nowEt0400, nowUtc: nowUtc0400, games: [], dryRun: true });
  const jobNames0400 = due0400.map((j) => j.jobName);

  expect(jobNames0400).toContain('pull_schedule_nba');
  expect(jobNames0400).toContain('pull_schedule_nhl');
});

test('pipeline watchdog also queues Dr. Claire persistence every 5 minutes', () => {
  const { DateTime } = require('luxon');

  process.env.ENABLE_ODDS_PULL = 'false';
  process.env.ENABLE_SETTLEMENT = 'false';
  process.env.ENABLE_NHL_MODEL = 'false';
  process.env.ENABLE_NBA_MODEL = 'false';
  process.env.ENABLE_FPL_MODEL = 'false';
  process.env.ENABLE_NFL_MODEL = 'false';
  process.env.ENABLE_MLB_MODEL = 'false';
  process.env.ENABLE_NHL_PLAYER_AVAILABILITY_SYNC = 'false';
  process.env.ENABLE_DISCORD_CARD_WEBHOOKS = 'false';
  process.env.ENABLE_PIPELINE_HEALTH_WATCHDOG = 'true';
  process.env.ENABLE_ODDS_HEALTH_WATCHDOG = 'false';

  const scheduler = loadSchedulerModule();

  const nowEt = DateTime.fromISO('2026-04-10T09:15:00', {
    zone: 'America/New_York',
  });
  const nowUtc = nowEt.toUTC();
  const dueJobs = scheduler.computeDueJobs({
    nowEt,
    nowUtc,
    games: [],
    dryRun: true,
  });

  const drClaireJob = dueJobs.find((job) => job.jobName === 'dr_claire_health_report');
  expect(drClaireJob).toBeDefined();
  expect(drClaireJob.jobKey).toBe('health|dr-claire|2026-04-10T13:15');
  expect(drClaireJob.args).toEqual({
    jobKey: 'health|dr-claire|2026-04-10T13:15',
    dryRun: false,
    persist: true,
  });
});

if (require.main === module) {
  runSchedulerWindowTests()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

describe('MLB T-minus freshness override resolver', () => {
  const {
    resolveTMinusFreshnessOverride,
    MLB_TMINUS_FRESHNESS_OVERRIDES,
    keyMlbPremodelOdds,
  } = require('../schedulers/windows');

  test('ladder has 4 rows ordered ascending by minutesToGameLte', () => {
    expect(MLB_TMINUS_FRESHNESS_OVERRIDES).toHaveLength(4);
    const bands = MLB_TMINUS_FRESHNESS_OVERRIDES.map((r) => r.minutesToGameLte);
    expect(bands).toEqual([180, 90, 45, 15]);
  });

  test('minutesToGame=180 resolves to band 180', () => {
    const result = resolveTMinusFreshnessOverride(180);
    expect(result).not.toBeNull();
    expect(result.minutesToGameLte).toBe(180);
  });

  test('minutesToGame=38 resolves to band 45 (strictest match precedence)', () => {
    const result = resolveTMinusFreshnessOverride(38);
    expect(result).not.toBeNull();
    expect(result.minutesToGameLte).toBe(45);
    expect(result.minutesToGameLte).not.toBe(90);
    expect(result.minutesToGameLte).not.toBe(180);
  });

  test('minutesToGame=15 resolves to band 15', () => {
    const result = resolveTMinusFreshnessOverride(15);
    expect(result).not.toBeNull();
    expect(result.minutesToGameLte).toBe(15);
  });

  test('minutesToGame=14 returns null (below all thresholds)', () => {
    const result = resolveTMinusFreshnessOverride(14);
    expect(result).toBeNull();
  });

  test('minutesToGame=181 returns null (above all thresholds)', () => {
    const result = resolveTMinusFreshnessOverride(181);
    expect(result).toBeNull();
  });

  test('boundary: exact value 180 selects band 180', () => {
    const result = resolveTMinusFreshnessOverride(180);
    expect(result.minutesToGameLte).toBe(180);
  });

  test('boundary: exact value 90 selects band 90', () => {
    const result = resolveTMinusFreshnessOverride(90);
    expect(result.minutesToGameLte).toBe(90);
  });

  test('boundary: exact value 45 selects band 45', () => {
    const result = resolveTMinusFreshnessOverride(45);
    expect(result.minutesToGameLte).toBe(45);
  });

  test('boundary: exact value 15 selects band 15', () => {
    const result = resolveTMinusFreshnessOverride(15);
    expect(result.minutesToGameLte).toBe(15);
  });

  test('strictest-match precedence: 38 must NOT return 90 or 180', () => {
    const result = resolveTMinusFreshnessOverride(38);
    expect(result.minutesToGameLte).toBeLessThan(90);
  });

  test('band 45 has triggerPreModelRefresh=true', () => {
    const result = resolveTMinusFreshnessOverride(38);
    expect(result.triggerPreModelRefresh).toBe(true);
  });

  test('band 180 has triggerPreModelRefresh=false', () => {
    const result = resolveTMinusFreshnessOverride(150);
    expect(result.minutesToGameLte).toBe(180);
    expect(result.triggerPreModelRefresh).toBe(false);
  });

  test('keyMlbPremodelOdds produces correct format', () => {
    const key = keyMlbPremodelOdds('mlb_game_1', 45, '2026-04-15T19:38');
    expect(key).toBe('pull-odds:mlb:premodel:mlb_game_1:45:2026-04-15T19:38');
  });

  test('keyMlbPremodelOdds truncates slotStartIsoUtc to minute precision', () => {
    const key = keyMlbPremodelOdds('mlb_game_2', 90, '2026-04-15T19:38:00.000Z');
    // Should truncate to first 16 chars
    expect(key).toBe('pull-odds:mlb:premodel:mlb_game_2:90:2026-04-15T19:38');
  });
});

function loadSchedulerModuleForDiscord() {
  return loadSchedulerModule();
}

function loadSchedulerModule(dataOverrides = {}) {
  jest.resetModules();

  jest.doMock('@cheddar-logic/data', () => ({
    getUpcomingGames: jest.fn(() => []),
    shouldRunJobKey: jest.fn(() => true),
    hasRunningJobRun: jest.fn(() => false),
    hasRunningJobName: jest.fn(() => false),
    wasJobRecentlySuccessful: jest.fn((jobName) => {
      if (jobName === 'pull_odds_hourly') return true;
      return false;
    }),
    wasJobKeyRecentlySuccessful: jest.fn(() => false),
    ...dataOverrides,
  }));

  jest.doMock('../jobs/pull_odds_hourly', () => ({ pullOddsHourly: jest.fn() }));
  jest.doMock('../jobs/refresh_stale_odds', () => ({ refreshStaleOdds: jest.fn() }));
  jest.doMock('../jobs/run_nhl_model', () => ({ runNHLModel: jest.fn() }));
  jest.doMock('../jobs/run_nba_model', () => ({ runNBAModel: jest.fn() }));
  jest.doMock('../jobs/run_fpl_model', () => ({ runFPLModel: jest.fn() }));
  jest.doMock('../jobs/run_nfl_model', () => ({ runNFLModel: jest.fn() }));
  jest.doMock('../jobs/run_mlb_model', () => ({ runMLBModel: jest.fn() }));
  jest.doMock('../jobs/sync_game_statuses', () => ({ syncGameStatuses: jest.fn() }));
  jest.doMock('../jobs/settle_game_results', () => ({ settleGameResults: jest.fn() }));
  jest.doMock('../jobs/settle_pending_cards', () => ({ settlePendingCards: jest.fn() }));
  jest.doMock('../jobs/backfill_card_results', () => ({ backfillCardResults: jest.fn() }));
  jest.doMock('../jobs/check_pipeline_health', () => ({ checkPipelineHealth: jest.fn() }));
  jest.doMock('../jobs/dr_claire_health_report', () => ({ runDrClaireHealthReport: jest.fn() }));
  jest.doMock('../jobs/refresh_team_metrics_daily', () => ({ run: jest.fn() }));
  jest.doMock('../jobs/sync_nhl_sog_player_ids', () => ({ syncNhlSogPlayerIds: jest.fn() }));
  jest.doMock('../jobs/sync_nhl_player_availability', () => ({ syncNhlPlayerAvailability: jest.fn() }));
  jest.doMock('../jobs/post_discord_cards', () => ({ postDiscordCards: jest.fn() }));
  jest.doMock('../jobs/potd/run_potd_engine', () => ({ runPotdEngine: jest.fn() }));
  jest.doMock('../jobs/potd/settlement-mirror', () => ({ mirrorPotdSettlement: jest.fn() }));

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

describe('scheduler settlement windows', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.ENABLE_ODDS_PULL = 'false';
    process.env.ENABLE_SETTLEMENT = 'true';
    process.env.ENABLE_HOURLY_SETTLEMENT_SWEEP = 'true';
    process.env.ENABLE_NHL_MODEL = 'false';
    process.env.ENABLE_NBA_MODEL = 'false';
    process.env.ENABLE_FPL_MODEL = 'false';
    process.env.ENABLE_NFL_MODEL = 'false';
    process.env.ENABLE_MLB_MODEL = 'false';
    process.env.ENABLE_NHL_PLAYER_AVAILABILITY_SYNC = 'false';
    process.env.ENABLE_DISCORD_CARD_WEBHOOKS = 'false';
    process.env.ENABLE_WITHOUT_ODDS_MODE = 'false';
    process.env.FIXED_CATCHUP = 'false';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('queues hourly settlement with hour-scoped keys', () => {
    const scheduler = loadSchedulerModule();
    const { DateTime } = require('luxon');

    const nowEt = DateTime.fromISO('2026-03-24T01:02:00', {
      zone: 'America/New_York',
    });
    const nowUtc = nowEt.toUTC();

    const dueJobs = scheduler.computeDueJobs({
      nowEt,
      nowUtc,
      games: [],
      dryRun: true,
    });

    expect(dueJobs.some((job) => job.jobName === 'sync_game_statuses')).toBe(true);
    expect(
      dueJobs.some(
        (job) =>
          job.jobName === 'settle_game_results' &&
          job.jobKey === 'settle|hourly|2026-03-24|01|game-results',
      ),
    ).toBe(true);
    expect(
      dueJobs.some(
        (job) =>
          job.jobName === 'settle_pending_cards' &&
          job.jobKey === 'settle|hourly|2026-03-24|01|pending-cards',
      ),
    ).toBe(true);
  });

  test('02:00 ET nightly sweep owns settlement keys', () => {
    const scheduler = loadSchedulerModule();
    const { DateTime } = require('luxon');

    const nowEt = DateTime.fromISO('2026-03-24T02:02:00', {
      zone: 'America/New_York',
    });
    const nowUtc = nowEt.toUTC();

    const dueJobs = scheduler.computeDueJobs({
      nowEt,
      nowUtc,
      games: [],
      dryRun: true,
    });

    expect(
      dueJobs.some(
        (job) =>
          job.jobName === 'backfill_card_results' &&
          job.jobKey === 'settle|backfill-card-results|2026-03-24',
      ),
    ).toBe(true);
    expect(
      dueJobs.some(
        (job) =>
          job.jobName === 'settle_game_results' &&
          job.jobKey === 'settle|nightly|2026-03-24|game-results',
      ),
    ).toBe(true);
    expect(
      dueJobs.some(
        (job) =>
          job.jobName === 'settle_pending_cards' &&
          job.jobKey === 'settle|nightly|2026-03-24|pending-cards',
      ),
    ).toBe(true);
    expect(
      dueJobs.some(
        (job) =>
          job.jobName === 'settle_game_results' &&
          job.jobKey === 'settle|hourly|2026-03-24|02|game-results',
      ),
    ).toBe(false);
    expect(
      dueJobs.some(
        (job) =>
          job.jobName === 'settle_pending_cards' &&
          job.jobKey === 'settle|hourly|2026-03-24|02|pending-cards',
      ),
    ).toBe(false);
  });

  test('nightly ownership does not suppress hourly settlement after 02:00 ET', () => {
    const scheduler = loadSchedulerModule();
    const { DateTime } = require('luxon');

    const nowEt = DateTime.fromISO('2026-03-24T11:00:23', {
      zone: 'America/New_York',
    });
    const nowUtc = nowEt.toUTC();

    const dueJobs = scheduler.computeDueJobs({
      nowEt,
      nowUtc,
      games: [],
      dryRun: true,
    });

    expect(
      dueJobs.some(
        (job) =>
          job.jobName === 'settle_game_results' &&
          job.jobKey === 'settle|hourly|2026-03-24|11|game-results',
      ),
    ).toBe(true);
    expect(
      dueJobs.some(
        (job) =>
          job.jobName === 'settle_pending_cards' &&
          job.jobKey === 'settle|hourly|2026-03-24|11|pending-cards',
      ),
    ).toBe(true);
  });

  test('running settlement job suppresses new enqueue across window keys', () => {
    const scheduler = loadSchedulerModule({
      hasRunningJobName: jest.fn((jobName) => jobName === 'settle_game_results'),
    });
    const { DateTime } = require('luxon');

    const nowEt = DateTime.fromISO('2026-03-24T03:02:00', {
      zone: 'America/New_York',
    });
    const nowUtc = nowEt.toUTC();

    const dueJobs = scheduler.computeDueJobs({
      nowEt,
      nowUtc,
      games: [],
      dryRun: true,
    });

    expect(dueJobs.some((job) => job.jobName === 'settle_game_results')).toBe(false);
    expect(
      dueJobs.some(
        (job) =>
          job.jobName === 'settle_pending_cards' &&
          job.jobKey === 'settle|hourly|2026-03-24|03|pending-cards',
      ),
    ).toBe(true);
  });

  test('tick executes without overlap reference errors', async () => {
    const scheduler = loadSchedulerModule({
      getUpcomingGames: jest.fn(() => []),
      shouldRunJobKey: jest.fn(() => false),
      hasRunningJobRun: jest.fn(() => false),
    });

    const now = new Date('2026-03-24T15:06:00Z');
    await expect(scheduler.tick({ now, dryRun: false })).resolves.toBeUndefined();
  });
});

describe('scheduler POTD windows', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.ENABLE_ODDS_PULL = 'false';
    process.env.ENABLE_SETTLEMENT = 'true';
    process.env.ENABLE_HOURLY_SETTLEMENT_SWEEP = 'true';
    process.env.ENABLE_NHL_MODEL = 'true';
    process.env.ENABLE_NBA_MODEL = 'true';
    process.env.ENABLE_NFL_MODEL = 'false';
    process.env.ENABLE_MLB_MODEL = 'false';
    process.env.ENABLE_POTD = 'true';
    process.env.FIXED_CATCHUP = 'false';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function sampleGames() {
    return [
      {
        game_id: 'nhl-game-1',
        sport: 'nhl',
        game_time_utc: '2026-03-24T18:00:00.000Z',
      },
    ];
  }

  test('does not queue POTD publish before computed target time', () => {
    const scheduler = loadSchedulerModule();
    const { DateTime } = require('luxon');

    const nowEt = DateTime.fromISO('2026-03-24T12:20:00', {
      zone: 'America/New_York',
    });
    const nowUtc = nowEt.toUTC();

    const dueJobs = scheduler.computeDueJobs({
      nowEt,
      nowUtc,
      games: sampleGames(),
      dryRun: true,
    });

    expect(dueJobs.some((job) => job.jobName === 'run_potd_engine')).toBe(false);
  });

  test('queues POTD publish exactly at computed target time', () => {
    const scheduler = loadSchedulerModule();
    const { DateTime } = require('luxon');

    const nowEt = DateTime.fromISO('2026-03-24T12:30:00', {
      zone: 'America/New_York',
    });
    const nowUtc = nowEt.toUTC();

    const dueJobs = scheduler.computeDueJobs({
      nowEt,
      nowUtc,
      games: sampleGames(),
      dryRun: true,
    });

    const potdJob = dueJobs.find((job) => job.jobName === 'run_potd_engine');
    expect(potdJob).toBeDefined();
    expect(potdJob.jobKey).toBe('potd|2026-03-24');
    expect(potdJob.args.schedule.targetPostTimeEt).toContain('2026-03-24T12:30:00.000');
  });

  test('same-day successful publish suppresses duplicate POTD enqueue', () => {
    const scheduler = loadSchedulerModule({
      shouldRunJobKey: jest.fn((jobKey) => jobKey !== 'potd|2026-03-24'),
    });
    const { DateTime } = require('luxon');

    const nowEt = DateTime.fromISO('2026-03-24T13:15:00', {
      zone: 'America/New_York',
    });
    const nowUtc = nowEt.toUTC();

    const dueJobs = scheduler.computeDueJobs({
      nowEt,
      nowUtc,
      games: sampleGames(),
      dryRun: true,
    });

    expect(dueJobs.some((job) => job.jobName === 'run_potd_engine')).toBe(false);
  });

  // ---- WI-0858 tests ----

  test('computePotdScheduleMetadata returns windowCollapsed=true when earliest game tips after 5:30 PM', () => {
    const scheduler = loadSchedulerModule();
    const { DateTime } = require('luxon');

    const nowEt = DateTime.fromObject(
      { year: 2026, month: 3, day: 24, hour: 12, minute: 0 },
      { zone: 'America/New_York' },
    );
    const games = [{ game_id: 'nhl-late-1', sport: 'nhl', game_time_utc: '2026-03-24T23:00:00.000Z' }]; // 7 PM ET
    const meta = scheduler.computePotdScheduleMetadata(nowEt, games);

    expect(meta).not.toBeNull();
    expect(meta.windowCollapsed).toBe(true);
    expect(meta.postDeadlineEt).toContain('T16:15:00');
  });

  test('queues POTD at 4:14 PM when window is collapsed (all games tip 7 PM+)', () => {
    const scheduler = loadSchedulerModule();
    const { DateTime } = require('luxon');

    const nowEt = DateTime.fromObject(
      { year: 2026, month: 3, day: 24, hour: 16, minute: 14 },
      { zone: 'America/New_York' },
    );
    const nowUtc = nowEt.toUTC();
    const games = [{ game_id: 'nhl-late-1', sport: 'nhl', game_time_utc: '2026-03-24T23:00:00.000Z' }];

    const dueJobs = scheduler.computeDueJobs({ nowEt, nowUtc, games, dryRun: true });
    const potdJob = dueJobs.find((j) => j.jobName === 'run_potd_engine' && j.jobKey === 'potd|2026-03-24');
    expect(potdJob).toBeDefined();
  });

  test('does NOT queue POTD at 4:15 PM when window is collapsed', () => {
    const scheduler = loadSchedulerModule();
    const { DateTime } = require('luxon');

    const nowEt = DateTime.fromObject(
      { year: 2026, month: 3, day: 24, hour: 16, minute: 15 },
      { zone: 'America/New_York' },
    );
    const nowUtc = nowEt.toUTC();
    const games = [{ game_id: 'nhl-late-1', sport: 'nhl', game_time_utc: '2026-03-24T23:00:00.000Z' }];

    const dueJobs = scheduler.computeDueJobs({ nowEt, nowUtc, games, dryRun: true });
    expect(dueJobs.some((j) => j.jobName === 'run_potd_engine' && j.jobKey === 'potd|2026-03-24')).toBe(false);
  });

  test('does not queue POTD and does not throw when no games today', () => {
    const scheduler = loadSchedulerModule();
    const { DateTime } = require('luxon');

    const nowEt = DateTime.fromObject(
      { year: 2026, month: 3, day: 24, hour: 13, minute: 0 },
      { zone: 'America/New_York' },
    );
    const nowUtc = nowEt.toUTC();

    expect(() => {
      const dueJobs = scheduler.computeDueJobs({ nowEt, nowUtc, games: [], dryRun: true });
      expect(dueJobs.some((j) => j.jobName === 'run_potd_engine')).toBe(false);
    }).not.toThrow();
  });

  // ---- WI-0859 tests ----

  test('queues fallback potd job at 4:15 PM when no success recorded', () => {
    const scheduler = loadSchedulerModule({
      wasJobKeyRecentlySuccessful: jest.fn(() => false),
    });
    const { DateTime } = require('luxon');

    const nowEt = DateTime.fromObject(
      { year: 2026, month: 3, day: 24, hour: 16, minute: 15 },
      { zone: 'America/New_York' },
    );
    const nowUtc = nowEt.toUTC();
    const games = [{ game_id: 'nhl-late-1', sport: 'nhl', game_time_utc: '2026-03-24T23:00:00.000Z' }];

    const dueJobs = scheduler.computeDueJobs({ nowEt, nowUtc, games, dryRun: true });
    const fallbackJob = dueJobs.find((j) => j.jobName === 'run_potd_engine' && j.jobKey === 'potd|2026-03-24:fallback');
    expect(fallbackJob).toBeDefined();
  });

  test('does NOT queue fallback when primary already succeeded', () => {
    const scheduler = loadSchedulerModule({
      wasJobKeyRecentlySuccessful: jest.fn(() => true),
    });
    const { DateTime } = require('luxon');

    const nowEt = DateTime.fromObject(
      { year: 2026, month: 3, day: 24, hour: 16, minute: 16 },
      { zone: 'America/New_York' },
    );
    const nowUtc = nowEt.toUTC();
    const games = [{ game_id: 'nhl-late-1', sport: 'nhl', game_time_utc: '2026-03-24T23:00:00.000Z' }];

    const dueJobs = scheduler.computeDueJobs({ nowEt, nowUtc, games, dryRun: true });
    expect(dueJobs.some((j) => j.jobName === 'run_potd_engine')).toBe(false);
  });

  test('does NOT queue fallback at 4:30 PM (past fallback window) and logs hard deadline', () => {
    const scheduler = loadSchedulerModule({
      wasJobKeyRecentlySuccessful: jest.fn(() => false),
    });
    const { DateTime } = require('luxon');
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const nowEt = DateTime.fromObject(
      { year: 2026, month: 3, day: 24, hour: 16, minute: 30 },
      { zone: 'America/New_York' },
    );
    const nowUtc = nowEt.toUTC();
    const games = [{ game_id: 'nhl-late-1', sport: 'nhl', game_time_utc: '2026-03-24T23:00:00.000Z' }];

    const dueJobs = scheduler.computeDueJobs({ nowEt, nowUtc, games, dryRun: true });
    expect(dueJobs.some((j) => j.jobName === 'run_potd_engine')).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[POTD] Hard deadline passed'));
    consoleSpy.mockRestore();
  });

  test('fallback key is distinct from primary key', () => {
    const date = '2026-03-24';
    const primaryKey = `potd|${date}`;
    const fallbackKey = `${primaryKey}:fallback`;
    expect(fallbackKey).not.toBe(primaryKey);
    expect(fallbackKey).toBe('potd|2026-03-24:fallback');
  });

  test('hard-deadline silent when fallback succeeded', () => {
    const scheduler = loadSchedulerModule({
      wasJobKeyRecentlySuccessful: jest.fn((key) => key.endsWith(':fallback')),
    });
    const { DateTime } = require('luxon');
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const nowEt = DateTime.fromObject(
      { year: 2026, month: 3, day: 24, hour: 16, minute: 31 },
      { zone: 'America/New_York' },
    );
    const nowUtc = nowEt.toUTC();
    const games = [{ game_id: 'nhl-late-1', sport: 'nhl', game_time_utc: '2026-03-24T23:00:00.000Z' }];

    scheduler.computeDueJobs({ nowEt, nowUtc, games, dryRun: true });
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('[POTD] Hard deadline'));
    consoleSpy.mockRestore();
  });

  test('queues settlement mirror only after canonical settlement jobs are due', () => {
    const scheduler = loadSchedulerModule();
    const { DateTime } = require('luxon');

    const nowEt = DateTime.fromISO('2026-03-24T01:02:00', {
      zone: 'America/New_York',
    });
    const nowUtc = nowEt.toUTC();

    const dueJobs = scheduler.computeDueJobs({
      nowEt,
      nowUtc,
      games: [],
      dryRun: true,
    });

    const mirrorIndex = dueJobs.findIndex((job) => job.jobName === 'mirror_potd_settlement');
    const lastSettlementIndex = Math.max(
      dueJobs.findIndex((job) => job.jobName === 'settle_game_results'),
      dueJobs.findIndex((job) => job.jobName === 'settle_projections'),
      dueJobs.findIndex((job) => job.jobName === 'settle_pending_cards'),
    );

    expect(mirrorIndex).toBeGreaterThan(-1);
    expect(mirrorIndex).toBeGreaterThan(lastSettlementIndex);
  });
});
