'use strict';

const { DateTime } = require('luxon');

jest.mock('../../jobs/run_nfl_model', () => ({
  runNFLModel: jest.fn(),
}));

const ET_ZONE = 'America/New_York';

function makeNowEt(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return DateTime.fromObject(
    { year: 2026, month: 9, day: 7, hour: h, minute: m, second: 0 },
    { zone: ET_ZONE },
  );
}

const BASE_CTX = {
  nowUtc: DateTime.utc(2026, 9, 7, 13, 0, 0),
  games: [],
  dryRun: false,
  quotaTier: 'FULL',
  maybeQueueTeamMetricsRefresh: jest.fn(),
  claimTminusPullSlot: jest.fn(),
  pullOddsHourly: jest.fn(),
  ENABLE_WITHOUT_ODDS_MODE: false,
};

describe('computeNflDueJobs — frozen guard', () => {
  beforeEach(() => {
    delete process.env.ENABLE_NFL_MODEL;
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.ENABLE_NFL_MODEL;
  });

  test('returns empty array when ENABLE_NFL_MODEL=false', () => {
    process.env.ENABLE_NFL_MODEL = 'false';
    const { computeNflDueJobs } = require('../nfl');
    const nowEt = makeNowEt('09:00');
    const jobs = computeNflDueJobs(nowEt, BASE_CTX);
    expect(jobs).toEqual([]);
  });

  test('logs frozen message when ENABLE_NFL_MODEL=false', () => {
    process.env.ENABLE_NFL_MODEL = 'false';
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { computeNflDueJobs } = require('../nfl');
    computeNflDueJobs(makeNowEt('09:00'), BASE_CTX);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('NFL'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('frozen'));
    spy.mockRestore();
  });

  test('frozen log message does not mention betting domain for FPL', () => {
    process.env.ENABLE_NFL_MODEL = 'false';
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { computeNflDueJobs } = require('../nfl');
    computeNflDueJobs(makeNowEt('09:00'), BASE_CTX);
    const calls = spy.mock.calls.map((c) => c.join(' '));
    expect(calls.some((s) => s.includes('FPL'))).toBe(false);
    spy.mockRestore();
  });

  test('returns jobs when ENABLE_NFL_MODEL is not set to false', () => {
    // Default (env not set) — guard must not block
    const { computeNflDueJobs } = require('../nfl');
    const nowEt = makeNowEt('09:00');
    // At 09:00 the fixed window fires, so at least one job should be returned
    const jobs = computeNflDueJobs(nowEt, { ...BASE_CTX });
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs.length).toBeGreaterThan(0);
  });
});
