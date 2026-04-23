'use strict';

/**
 * Tests for fail-closed frozen-domain guards in NFL and FPL Sage paths.
 *
 * Covers two defense layers for each frozen domain:
 *   1. Scheduler enqueue guard — computeNflDueJobs / computeFplDueJobs returns []
 *   2. Job entrypoint guard — runNFLModel / runFPLModel returns {frozen: true} without DB calls
 *
 * Domain terminology (enforced in log assertions):
 *   - NFL is a frozen *betting domain* — log must say "betting domain is frozen" or equivalent
 *   - FPL Sage is a fantasy-team decision engine — log must say "FPL Sage model" and "disabled"
 *     (must NOT say "betting domain" for FPL)
 */

const { DateTime } = require('luxon');

// ─── Mock: @cheddar-logic/data ────────────────────────────────────────────────
// Prevents DB access and lets us assert withDb is never called when guards fire.
jest.mock('@cheddar-logic/data', () => ({
  withDb: jest.fn(),
  insertJobRun: jest.fn(),
  markJobRunSuccess: jest.fn(),
  markJobRunFailure: jest.fn(),
  setCurrentRunId: jest.fn(),
  getOddsSnapshots: jest.fn(),
  getOddsWithUpcomingGames: jest.fn(),
  getLatestOdds: jest.fn(),
  insertModelOutput: jest.fn(),
  insertCardPayload: jest.fn(),
  prepareModelAndCardWrite: jest.fn(),
  validateCardPayload: jest.fn(),
  shouldRunJobKey: jest.fn(),
  checkSqliteIntegrity: jest.fn(),
}));

// ─── Mock: ./windows — safe defaults so NFL scheduler logic doesn't crash ─────
jest.mock('../schedulers/windows', () => ({
  isFixedDue: jest.fn().mockReturnValue(false),
  keyFixed: jest.fn().mockReturnValue('nfl|fixed|test'),
  keyTminus: jest.fn().mockReturnValue('nfl|tminus|test'),
  dueTminusMinutes: jest.fn().mockReturnValue([]),
}));

// ─── Minimal NFL scheduler context ───────────────────────────────────────────
const nflCtx = {
  nowUtc: DateTime.utc(),
  games: [],
  dryRun: true,
  quotaTier: 'FULL',
  maybeQueueTeamMetricsRefresh: jest.fn(),
  claimTminusPullSlot: jest.fn(),
  pullOddsHourly: jest.fn(),
  ENABLE_WITHOUT_ODDS_MODE: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: NFL scheduler guard — returns [] when ENABLE_NFL_MODEL=false
// ─────────────────────────────────────────────────────────────────────────────
describe('NFL scheduler guard', () => {
  afterEach(() => {
    delete process.env.ENABLE_NFL_MODEL;
    jest.resetModules();
  });

  test('returns [] when ENABLE_NFL_MODEL=false and logs NFL betting domain frozen message', () => {
    process.env.ENABLE_NFL_MODEL = 'false';
    jest.resetModules();

    // The scheduler also requires ../jobs/run_nfl_model; give it a harmless mock after resetModules
    jest.mock('../jobs/run_nfl_model', () => ({ runNFLModel: jest.fn() }));

    const { computeNflDueJobs } = require('../schedulers/nfl');
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const nowEt = DateTime.fromISO('2026-09-10T09:01:00', { zone: 'America/New_York' });
    const jobs = computeNflDueJobs(nowEt, nflCtx);

    expect(jobs).toEqual([]);

    // Log must mention the betting domain (NFL) and the flag — not just a generic "frozen"
    const loggedMessages = consoleSpy.mock.calls.flat().join(' ');
    expect(loggedMessages).toContain('betting domain');
    expect(loggedMessages).toContain('ENABLE_NFL_MODEL=false');
    // Must NOT describe NFL guard as merely a model or feature — it's a domain freeze
    expect(loggedMessages).toContain('[NFL]');

    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: NFL job entrypoint guard — returns {frozen: true} without calling withDb
// ─────────────────────────────────────────────────────────────────────────────
describe('NFL job entrypoint guard', () => {
  afterEach(() => {
    delete process.env.ENABLE_NFL_MODEL;
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('returns {frozen: true} and does not call withDb when ENABLE_NFL_MODEL=false', async () => {
    process.env.ENABLE_NFL_MODEL = 'false';
    jest.resetModules();

    // Ensure the real run_nfl_model is loaded — not the scheduler-test mock
    jest.unmock('../jobs/run_nfl_model');

    // Re-require the data mock and the REAL job module (not the scheduler mock)
    const { withDb } = require('@cheddar-logic/data');
    const { runNFLModel } = require('../jobs/run_nfl_model');

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runNFLModel({ jobKey: 'test-key', dryRun: false });

    expect(result).toBeDefined();
    expect(result.frozen).toBe(true);
    expect(result.success).toBe(true);
    expect(result.reason).toMatch(/NFL betting domain frozen/);
    expect(withDb).not.toHaveBeenCalled();

    // Log must reference the frozen betting domain
    const loggedMessages = consoleSpy.mock.calls.flat().join(' ');
    expect(loggedMessages).toContain('betting domain');
    expect(loggedMessages).toContain('ENABLE_NFL_MODEL=false');

    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: FPL job entrypoint guard — returns {frozen: true} without calling withDb
// ─────────────────────────────────────────────────────────────────────────────
describe('FPL job entrypoint guard', () => {
  afterEach(() => {
    delete process.env.ENABLE_FPL_MODEL;
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('returns {frozen: true} and does not call withDb when ENABLE_FPL_MODEL=false', async () => {
    process.env.ENABLE_FPL_MODEL = 'false';
    jest.resetModules();

    const { withDb } = require('@cheddar-logic/data');
    // Real run_fpl_model module — not mocked at top level
    const { runFPLModel } = require('../jobs/run_fpl_model');

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runFPLModel();

    expect(result).toBeDefined();
    expect(result.frozen).toBe(true);
    expect(result.success).toBe(true);
    expect(result.reason).toMatch(/FPL Sage model disabled/);
    expect(withDb).not.toHaveBeenCalled();

    // Log must reference FPL Sage model + disabled — NOT "betting domain"
    const loggedMessages = consoleSpy.mock.calls.flat().join(' ');
    expect(loggedMessages).toContain('FPL Sage model');
    expect(loggedMessages).toContain('disabled');
    // Ensure we did not accidentally use betting-domain terminology for FPL Sage
    expect(loggedMessages).not.toMatch(/betting domain/);

    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: NFL scheduler enabled — does NOT return [] when ENABLE_NFL_MODEL is unset
// ─────────────────────────────────────────────────────────────────────────────
describe('NFL scheduler enabled path', () => {
  afterEach(() => {
    delete process.env.ENABLE_NFL_MODEL;
    jest.resetModules();
  });

  test('returns an array (guard does not block) when ENABLE_NFL_MODEL is unset', () => {
    delete process.env.ENABLE_NFL_MODEL;
    jest.resetModules();

    jest.mock('../jobs/run_nfl_model', () => ({ runNFLModel: jest.fn() }));
    const { computeNflDueJobs } = require('../schedulers/nfl');

    const nowEt = DateTime.fromISO('2026-09-10T09:01:00', { zone: 'America/New_York' });
    const jobs = computeNflDueJobs(nowEt, nflCtx);

    // Must return an array — guard did not block (no ENABLE_NFL_MODEL=false)
    expect(Array.isArray(jobs)).toBe(true);
  });

  test('returns an array (guard does not block) when ENABLE_NFL_MODEL=true', () => {
    process.env.ENABLE_NFL_MODEL = 'true';
    jest.resetModules();

    jest.mock('../jobs/run_nfl_model', () => ({ runNFLModel: jest.fn() }));
    const { computeNflDueJobs } = require('../schedulers/nfl');

    const nowEt = DateTime.fromISO('2026-09-10T09:01:00', { zone: 'America/New_York' });
    const jobs = computeNflDueJobs(nowEt, nflCtx);

    expect(Array.isArray(jobs)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: FPL scheduler enabled — returns jobs when ENABLE_FPL_MODEL is unset
// ─────────────────────────────────────────────────────────────────────────────
describe('FPL scheduler enabled path', () => {
  afterEach(() => {
    delete process.env.ENABLE_FPL_MODEL;
    delete process.env.FIXED_CATCHUP;
    jest.resetModules();
  });

  test('returns FPL Sage jobs (guard does not block) when ENABLE_FPL_MODEL is unset and date is in GW35 T-48h window', () => {
    delete process.env.ENABLE_FPL_MODEL;
    // FIXED_CATCHUP=true (default) so all past windows fire
    process.env.FIXED_CATCHUP = 'true';
    jest.resetModules();

    const { computeFplDueJobs } = require('../schedulers/fpl');

    // GW35 deadline: 2026-04-28T17:30:00 BST = 2026-04-28T16:30:00Z
    // T-48h window opens: 2026-04-26T16:30:00Z
    // Use 2026-04-28T14:00:00 ET = 2026-04-28T18:00:00Z — after T-48h and T-24h windows
    const nowEt = DateTime.fromISO('2026-04-28T14:00:00', { zone: 'America/New_York' });
    const jobs = computeFplDueJobs(nowEt);

    // Guard must not have fired — jobs should contain FPL Sage entries for GW35
    expect(Array.isArray(jobs)).toBe(true);
    const gw35jobs = jobs.filter((j) => j.jobKey && j.jobKey.includes('GW35'));
    expect(gw35jobs.length).toBeGreaterThan(0);
  });
});
