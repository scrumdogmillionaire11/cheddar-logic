'use strict';

const { DateTime } = require('luxon');

jest.mock('../../jobs/run_nhl_model', () => ({
  runNHLModel: jest.fn(),
}));
jest.mock('../../jobs/sync_nhl_player_availability', () => ({
  syncNhlPlayerAvailability: jest.fn(),
}));
jest.mock('../../jobs/pull_nhl_goalie_starters', () => ({
  pullNhlGoalieStarters: jest.fn(),
}));
jest.mock('../../jobs/sync_nhl_sog_player_ids', () => ({
  syncNhlSogPlayerIds: jest.fn(),
}));
jest.mock('../../jobs/pull_nhl_team_stats', () => ({
  pullNhlTeamStats: jest.fn(),
}));
jest.mock('../../jobs/pull_nhl_1p_odds', () => ({
  pullNhl1pOdds: jest.fn(),
}));

const mockIsFeatureEnabled = jest.fn();
jest.mock('@cheddar-logic/data/src/feature-flags', () => ({
  isFeatureEnabled: (...args) => mockIsFeatureEnabled(...args),
}));

const ET_ZONE = 'America/New_York';

function makeNowEt(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return DateTime.fromObject(
    { year: 2026, month: 3, day: 28, hour: h, minute: m, second: 0 },
    { zone: ET_ZONE },
  );
}

function makeBaseCtx(nowEt) {
  return {
    nowUtc: nowEt.toUTC(),
    games: [],
    dryRun: false,
    quotaTier: 'FULL',
    maybeQueueTeamMetricsRefresh: jest.fn(),
    claimTminusPullSlot: jest.fn(() => true),
    pullOddsHourly: jest.fn(),
    ENABLE_WITHOUT_ODDS_MODE: false,
  };
}

function makeGame(nowEt, gameId, minutesFromNow) {
  return {
    game_id: gameId,
    sport: 'nhl',
    game_time_utc: nowEt.toUTC().plus({ minutes: minutesFromNow }).toISO(),
  };
}

describe('computeNhlDueJobs — NHL 1P odds scheduling', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    delete process.env.NHL_1P_ODDS_ENABLED;
    delete process.env.ENABLE_ODDS_PULL;

    mockIsFeatureEnabled.mockImplementation((sport, flag) => {
      if (sport !== 'nhl') return false;
      if (flag === 'model') return true;
      return false;
    });
  });

  test('queues pull_nhl_1p_odds before fixed-time run_nhl_model when explicitly enabled', () => {
    process.env.NHL_1P_ODDS_ENABLED = 'true';

    const { computeNhlDueJobs } = require('../nhl');
    const nowEt = makeNowEt('09:00');
    const jobs = computeNhlDueJobs(nowEt, makeBaseCtx(nowEt));

    const names = jobs.map((job) => job.jobName);
    expect(names).toContain('pull_nhl_1p_odds');
    expect(names).toContain('run_nhl_model');
    expect(names.indexOf('pull_nhl_1p_odds')).toBeLessThan(
      names.indexOf('run_nhl_model'),
    );
  });

  test('does not queue pull_nhl_1p_odds when NHL_1P_ODDS_ENABLED is not true', () => {
    const { computeNhlDueJobs } = require('../nhl');
    const nowEt = makeNowEt('09:00');
    const jobs = computeNhlDueJobs(nowEt, makeBaseCtx(nowEt));

    expect(jobs.map((job) => job.jobName)).not.toContain('pull_nhl_1p_odds');
  });

  test('dedupes T-minus pull_nhl_1p_odds to one job per window across multiple NHL games', () => {
    process.env.NHL_1P_ODDS_ENABLED = 'true';

    const { computeNhlDueJobs } = require('../nhl');
    const nowEt = makeNowEt('09:00');
    const ctx = makeBaseCtx(nowEt);
    ctx.games = [
      makeGame(nowEt, 'nhl_game_a', 90),
      makeGame(nowEt, 'nhl_game_b', 88),
    ];

    const seen = new Set();
    ctx.claimTminusPullSlot = jest.fn((sport, windowKey) => {
      const key = `${sport}|${windowKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const jobs = computeNhlDueJobs(nowEt, ctx);
    const onePJobs = jobs.filter((job) => job.jobName === 'pull_nhl_1p_odds');
    const tMinusOnePJobs = onePJobs.filter((job) =>
      String(job.reason || '').includes('(T-90, nhl)'),
    );
    const modelJobs = jobs.filter((job) => job.jobName === 'run_nhl_model');
    const tMinusModelJobs = modelJobs.filter((job) =>
      String(job.reason || '').includes('T-90 for nhl_game_'),
    );

    expect(onePJobs).toHaveLength(2);
    expect(tMinusOnePJobs).toHaveLength(1);
    expect(modelJobs).toHaveLength(3);
    expect(tMinusModelJobs).toHaveLength(2);
  });

  test('suppresses pull_nhl_1p_odds when ENABLE_ODDS_PULL=false', () => {
    process.env.NHL_1P_ODDS_ENABLED = 'true';
    process.env.ENABLE_ODDS_PULL = 'false';

    const { computeNhlDueJobs } = require('../nhl');
    const nowEt = makeNowEt('09:00');
    const jobs = computeNhlDueJobs(nowEt, makeBaseCtx(nowEt));

    expect(jobs.map((job) => job.jobName)).not.toContain('pull_nhl_1p_odds');
    expect(jobs.map((job) => job.jobName)).toContain('run_nhl_model');
  });

  test('suppresses pull_nhl_1p_odds when ENABLE_WITHOUT_ODDS_MODE=true', () => {
    process.env.NHL_1P_ODDS_ENABLED = 'true';

    const { computeNhlDueJobs } = require('../nhl');
    const nowEt = makeNowEt('09:00');
    const ctx = makeBaseCtx(nowEt);
    ctx.ENABLE_WITHOUT_ODDS_MODE = true;
    const jobs = computeNhlDueJobs(nowEt, ctx);

    expect(jobs.map((job) => job.jobName)).not.toContain('pull_nhl_1p_odds');
    expect(jobs.map((job) => job.jobName)).toContain('run_nhl_model');
  });
});
