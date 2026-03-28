const { DateTime } = require('luxon');

function loadSchedulerModule() {
  jest.resetModules();

  jest.doMock('@cheddar-logic/data', () => ({
    getUpcomingGames: jest.fn(() => []),
    shouldRunJobKey: jest.fn(() => true),
    hasRunningJobRun: jest.fn(() => false),
    wasJobRecentlySuccessful: jest.fn(() => false),
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
  jest.doMock('../jobs/check_odds_health', () => ({ checkOddsHealth: jest.fn() }));
  jest.doMock('../jobs/refresh_team_metrics_daily', () => ({ run: jest.fn() }));
  jest.doMock('../jobs/sync_nhl_sog_player_ids', () => ({ syncNhlSogPlayerIds: jest.fn() }));
  jest.doMock('../jobs/sync_nhl_player_availability', () => ({ syncNhlPlayerAvailability: jest.fn() }));

  return require('../schedulers/main');
}

describe('getOddsHealthJobs — 30-min cadence gate', () => {
  let scheduler;

  beforeAll(() => {
    scheduler = loadSchedulerModule();
  });

  test('returns [] at minute 15 (not a 30-min boundary)', () => {
    const nowUtc = DateTime.fromISO('2026-01-15T10:15:00', { zone: 'UTC' });
    const result = scheduler.getOddsHealthJobs(nowUtc);
    expect(result).toEqual([]);
  });

  test('returns [] at minute 31', () => {
    const nowUtc = DateTime.fromISO('2026-01-15T10:31:00', { zone: 'UTC' });
    const result = scheduler.getOddsHealthJobs(nowUtc);
    expect(result).toEqual([]);
  });

  test('returns 1 job at minute 0 (start of hour)', () => {
    const nowUtc = DateTime.fromISO('2026-01-15T10:00:00', { zone: 'UTC' });
    const result = scheduler.getOddsHealthJobs(nowUtc);
    expect(result).toHaveLength(1);
  });

  test('returns 1 job at minute 30 (half-hour mark)', () => {
    const nowUtc = DateTime.fromISO('2026-01-15T10:30:00', { zone: 'UTC' });
    const result = scheduler.getOddsHealthJobs(nowUtc);
    expect(result).toHaveLength(1);
  });

  test('jobKey at hour 10 minute 0 is health|odds|2026-01-15|s020', () => {
    const nowUtc = DateTime.fromISO('2026-01-15T10:00:00', { zone: 'UTC' });
    const result = scheduler.getOddsHealthJobs(nowUtc);
    expect(result[0].jobKey).toBe('health|odds|2026-01-15|s020');
  });

  test('jobKey at hour 10 minute 30 is health|odds|2026-01-15|s021', () => {
    const nowUtc = DateTime.fromISO('2026-01-15T10:30:00', { zone: 'UTC' });
    const result = scheduler.getOddsHealthJobs(nowUtc);
    expect(result[0].jobKey).toBe('health|odds|2026-01-15|s021');
  });

  test('returned job has jobName === check_odds_health', () => {
    const nowUtc = DateTime.fromISO('2026-01-15T10:00:00', { zone: 'UTC' });
    const result = scheduler.getOddsHealthJobs(nowUtc);
    expect(result[0].jobName).toBe('check_odds_health');
  });
});
