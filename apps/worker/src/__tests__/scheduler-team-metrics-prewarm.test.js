const { DateTime } = require('luxon');

function loadSchedulerModule({ freshTeamMetrics = false } = {}) {
  jest.resetModules();

  jest.doMock('@cheddar-logic/data', () => ({
    initDb: jest.fn(),
    getUpcomingGames: jest.fn(() => []),
    shouldRunJobKey: jest.fn(() => true),
    hasRunningJobRun: jest.fn(() => false),
    wasJobRecentlySuccessful: jest.fn((jobName) => {
      if (jobName === 'refresh_team_metrics_daily') return freshTeamMetrics;
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
  jest.doMock('../jobs/run_ncaam_model', () => ({ runNCAAMModel: jest.fn() }));
  jest.doMock('../jobs/refresh_ncaam_ft_csv', () => ({ runRefreshNcaamFtCsv: jest.fn() }));
  jest.doMock('../jobs/settle_game_results', () => ({ settleGameResults: jest.fn() }));
  jest.doMock('../jobs/settle_pending_cards', () => ({ settlePendingCards: jest.fn() }));
  jest.doMock('../jobs/backfill_card_results', () => ({ backfillCardResults: jest.fn() }));
  jest.doMock('../jobs/check_pipeline_health', () => ({ checkPipelineHealth: jest.fn() }));
  jest.doMock('../jobs/refresh_team_metrics_daily', () => ({ run: jest.fn() }));
  jest.doMock('../jobs/sync_nhl_sog_player_ids', () => ({ syncNhlSogPlayerIds: jest.fn() }));
  jest.doMock('../jobs/sync_nhl_player_availability', () => ({ syncNhlPlayerAvailability: jest.fn() }));

  return require('../schedulers/main');
}

describe('scheduler team-metrics prewarm for projection models', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.ENABLE_ODDS_PULL = 'false';
    process.env.ENABLE_SETTLEMENT = 'false';
    process.env.ENABLE_NBA_MODEL = 'true';
    process.env.ENABLE_NHL_MODEL = 'false';
    process.env.ENABLE_NCAAM_MODEL = 'false';
    process.env.ENABLE_SOCCER_MODEL = 'false';
    process.env.ENABLE_FPL_MODEL = 'false';
    process.env.ENABLE_NFL_MODEL = 'false';
    process.env.ENABLE_MLB_MODEL = 'false';
    process.env.FIXED_CATCHUP = 'false';
    process.env.REQUIRE_FRESH_TEAM_METRICS_FOR_PROJECTION_MODELS = 'true';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('queues refresh_team_metrics_daily before fixed NBA model run when cache is stale', () => {
    const scheduler = loadSchedulerModule({ freshTeamMetrics: false });

    const nowEt = DateTime.fromISO('2026-03-17T08:05:00', {
      zone: 'America/New_York',
    });
    const nowUtc = nowEt.toUTC();
    const gameStartUtc = nowUtc.plus({ minutes: 118 }).toISO();

    const dueJobs = scheduler.computeDueJobs({
      nowEt,
      nowUtc,
      games: [
        {
          game_id: 'nba-game-001',
          sport: 'NBA',
          game_time_utc: gameStartUtc,
        },
      ],
      dryRun: true,
    });

    const refreshJob = dueJobs.find(
      (job) => job.jobName === 'refresh_team_metrics_daily',
    );
    const nbaJob = dueJobs.find((job) => job.jobName === 'run_nba_model');

    expect(refreshJob).toBeDefined();
    expect(nbaJob).toBeDefined();
    expect(dueJobs.indexOf(refreshJob)).toBeLessThan(dueJobs.indexOf(nbaJob));
  });

  test('does not queue refresh_team_metrics_daily when cache is fresh', () => {
    const scheduler = loadSchedulerModule({ freshTeamMetrics: true });

    const nowEt = DateTime.fromISO('2026-03-17T08:05:00', {
      zone: 'America/New_York',
    });
    const nowUtc = nowEt.toUTC();
    const gameStartUtc = nowUtc.plus({ minutes: 118 }).toISO();

    const dueJobs = scheduler.computeDueJobs({
      nowEt,
      nowUtc,
      games: [
        {
          game_id: 'nba-game-002',
          sport: 'NBA',
          game_time_utc: gameStartUtc,
        },
      ],
      dryRun: true,
    });

    const refreshJob = dueJobs.find(
      (job) => job.jobName === 'refresh_team_metrics_daily',
    );
    const nbaJob = dueJobs.find((job) => job.jobName === 'run_nba_model');

    expect(nbaJob).toBeDefined();
    expect(refreshJob).toBeUndefined();
  });
});
