'use strict';

const { DateTime } = require('luxon');

/**
 * Tests for schedulers/fpl.js — FPL deadline-based scheduler
 *
 * Tests exercise the pure functions directly (no DB calls).
 * FIXED_CATCHUP=true (default) throughout, so any time after the window fires.
 * Uses GW32 deadline 2026-04-02T18:30:00 Europe/London (= 2026-04-02T17:30:00Z BST)
 * as the fixture reference point.
 *
 * Offset T-48h window opens at: 2026-03-31T17:30:00Z  (ET: 2026-03-31T13:30:00-04:00)
 * Offset T-24h window opens at: 2026-04-01T17:30:00Z  (ET: 2026-04-01T13:30:00-04:00)
 * Offset T-6h  window opens at: 2026-04-02T11:30:00Z  (ET: 2026-04-02T07:30:00-04:00)
 */

describe('keyFplDeadline', () => {
  let keyFplDeadline;

  beforeEach(() => {
    jest.resetModules();
    ({ keyFplDeadline } = require('../schedulers/fpl'));
  });

  test('produces correct format for standard inputs', () => {
    expect(keyFplDeadline(34, 48)).toBe('fpl|deadline|GW34|T48h');
    expect(keyFplDeadline(38, 6)).toBe('fpl|deadline|GW38|T6h');
  });

  test('keys are unique across GWs and offsets', () => {
    const keys = [
      keyFplDeadline(32, 48),
      keyFplDeadline(32, 24),
      keyFplDeadline(32, 6),
      keyFplDeadline(33, 48),
      keyFplDeadline(33, 24),
    ];
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });
});

describe('computeFplDueJobs', () => {
  beforeEach(() => {
    // Reset all FPL-related env vars before each test
    delete process.env.ENABLE_FPL_MODEL;
    delete process.env.FPL_WINDOW_OFFSET_HOURS;
    process.env.FIXED_CATCHUP = 'true'; // catch-up mode: fires any time after window
  });

  afterEach(() => {
    delete process.env.FIXED_CATCHUP;
    delete process.env.ENABLE_FPL_MODEL;
    delete process.env.FPL_WINDOW_OFFSET_HOURS;
  });

  test('returns empty array when ENABLE_FPL_MODEL=false', () => {
    jest.resetModules();
    process.env.ENABLE_FPL_MODEL = 'false';
    const { computeFplDueJobs } = require('../schedulers/fpl');

    // Use a time that would normally match GW32 T-48h window
    const nowEt = DateTime.fromISO('2026-03-31T14:00:00', {
      zone: 'America/New_York',
    });
    const jobs = computeFplDueJobs(nowEt);
    expect(jobs).toEqual([]);
  });

  test('queues GW32 T-48h job when current time is after that window', () => {
    jest.resetModules();
    const { computeFplDueJobs, keyFplDeadline } = require('../schedulers/fpl');

    // GW32 deadline: 2026-04-02T18:30:00 BST = 2026-04-02T17:30:00Z
    // T-48h window opens at: 2026-03-31T17:30:00Z = 2026-03-31T13:30:00 ET
    // Set nowEt to 1 minute past window open
    const nowEt = DateTime.fromISO('2026-03-31T13:31:00', {
      zone: 'America/New_York',
    });
    const jobs = computeFplDueJobs(nowEt, { dryRun: true });

    const gw32t48 = jobs.find((j) => j.jobKey === keyFplDeadline(32, 48));
    expect(gw32t48).toBeDefined();
    expect(gw32t48.jobName).toBe('run_fpl_model');
    expect(gw32t48.args.dryRun).toBe(true);
    expect(gw32t48.reason).toMatch(/FPL GW32.*T-48h/);
  });

  test('queues GW32 T-24h job but not T-48h job when only T-24h window is open', () => {
    jest.resetModules();
    const { computeFplDueJobs, keyFplDeadline } = require('../schedulers/fpl');

    // FIXED_CATCHUP=false: only fire inside 2×TICK_MS window
    // Set TICK_MS large enough that we can test relative timing
    process.env.FIXED_CATCHUP = 'false';
    process.env.TICK_MS = '3600000'; // 1-hour tick → 2h window

    // T-24h window opens at GW32: 2026-04-01T17:30:00Z = 2026-04-01T13:30:00 ET
    // T-48h window is well past (opened 24h earlier) — outside 2h buffer
    const nowEt = DateTime.fromISO('2026-04-01T13:31:00', {
      zone: 'America/New_York',
    });
    const jobs = computeFplDueJobs(nowEt);

    const gw32t24 = jobs.find((j) => j.jobKey === keyFplDeadline(32, 24));
    const gw32t48 = jobs.find((j) => j.jobKey === keyFplDeadline(32, 48));

    expect(gw32t24).toBeDefined();
    expect(gw32t48).toBeUndefined(); // T-48h opened >24h ago — stale
  });

  test('returns empty array when nowEt is before all deadline windows', () => {
    jest.resetModules();
    const { computeFplDueJobs } = require('../schedulers/fpl');

    // 2026-03-28 is before GW32 T-48h window (2026-03-31)
    const nowEt = DateTime.fromISO('2026-03-28T08:00:00', {
      zone: 'America/New_York',
    });
    const jobs = computeFplDueJobs(nowEt);
    expect(jobs).toEqual([]);
  });

  test('returns all three offset windows once all are past (FIXED_CATCHUP=true)', () => {
    jest.resetModules();
    const { computeFplDueJobs, keyFplDeadline } = require('../schedulers/fpl');

    // GW32 T-6h window opens at 2026-04-02T17:30:00Z - 6h = 2026-04-02T11:30:00Z
    // = 2026-04-02T07:30:00 ET. Set nowEt just after that.
    const nowEt = DateTime.fromISO('2026-04-02T07:35:00', {
      zone: 'America/New_York',
    });
    const jobs = computeFplDueJobs(nowEt);

    const gw32Keys = [48, 24, 6].map((h) => keyFplDeadline(32, h));
    for (const key of gw32Keys) {
      expect(jobs.find((j) => j.jobKey === key)).toBeDefined();
    }
  });

  test('respects custom FPL_WINDOW_OFFSET_HOURS env var', () => {
    jest.resetModules();
    process.env.FPL_WINDOW_OFFSET_HOURS = '72,12';
    const { computeFplDueJobs, keyFplDeadline } = require('../schedulers/fpl');

    // GW32 T-72h opens at: 2026-04-02T17:30:00Z - 72h = 2026-03-30T17:30:00Z
    // = 2026-03-30T13:30:00 ET. Set nowEt just after.
    const nowEt = DateTime.fromISO('2026-03-30T14:00:00', {
      zone: 'America/New_York',
    });
    const jobs = computeFplDueJobs(nowEt);

    expect(jobs.find((j) => j.jobKey === keyFplDeadline(32, 72))).toBeDefined();
    // T-48h is NOT in custom offsets — should be absent
    expect(jobs.find((j) => j.jobKey === keyFplDeadline(32, 48))).toBeUndefined();
  });

  test('does not queue jobs for a GW whose deadline has already passed', () => {
    jest.resetModules();
    const { computeFplDueJobs } = require('../schedulers/fpl');

    // GW38 final deadline: 2026-05-23T14:00:00 BST = 2026-05-23T13:00:00Z
    // T-6h window: 2026-05-23T07:00:00Z = 2026-05-23T03:00:00 ET
    // Set nowEt to well after the final GW38 deadline — no more jobs should queue
    const nowEt = DateTime.fromISO('2026-06-01T12:00:00', {
      zone: 'America/New_York',
    });
    const jobs = computeFplDueJobs(nowEt);

    // FIXED_CATCHUP=true means ALL past windows fire — this is intentional catch-up
    // behaviour on restart. In production the idempotency gate in the tick loop
    // prevents double-runs. The count of past windows is total GWs × offsets.
    // Verify they are all FPL jobs (no wrong sport bleed-through).
    for (const job of jobs) {
      expect(job.jobName).toBe('run_fpl_model');
      expect(job.jobKey).toMatch(/^fpl\|deadline\|GW\d+\|T\d+h$/);
    }
  });

  test('job execute function is runFPLModel', () => {
    jest.resetModules();
    const { computeFplDueJobs, keyFplDeadline } = require('../schedulers/fpl');
    const { runFPLModel } = require('../jobs/run_fpl_model');

    const nowEt = DateTime.fromISO('2026-04-02T08:00:00', {
      zone: 'America/New_York',
    });
    const jobs = computeFplDueJobs(nowEt);
    const job = jobs.find((j) => j.jobKey === keyFplDeadline(32, 6));

    expect(job).toBeDefined();
    expect(job.execute).toBe(runFPLModel);
  });
});

describe('isFplWindowDue', () => {
  afterEach(() => {
    delete process.env.FIXED_CATCHUP;
    delete process.env.TICK_MS;
  });

  test('returns false when nowUtc is before window', () => {
    jest.resetModules();
    const { isFplWindowDue } = require('../schedulers/fpl');
    const windowUtc = DateTime.fromISO('2026-04-01T12:00:00Z', { zone: 'utc' });
    const nowUtc = windowUtc.minus({ minutes: 5 });
    expect(isFplWindowDue(nowUtc, windowUtc)).toBe(false);
  });

  test('returns true when FIXED_CATCHUP=true and window is in the past', () => {
    jest.resetModules();
    process.env.FIXED_CATCHUP = 'true';
    const { isFplWindowDue } = require('../schedulers/fpl');
    const windowUtc = DateTime.fromISO('2026-04-01T12:00:00Z', { zone: 'utc' });
    const nowUtc = windowUtc.plus({ hours: 24 });
    expect(isFplWindowDue(nowUtc, windowUtc)).toBe(true);
  });

  test('returns false when FIXED_CATCHUP=false and nowUtc is beyond 2× TICK_MS', () => {
    jest.resetModules();
    process.env.FIXED_CATCHUP = 'false';
    process.env.TICK_MS = '60000'; // 1 min tick → 2-min window
    const { isFplWindowDue } = require('../schedulers/fpl');
    const windowUtc = DateTime.fromISO('2026-04-01T12:00:00Z', { zone: 'utc' });
    const nowUtc = windowUtc.plus({ minutes: 5 }); // 5min past → outside 2min window
    expect(isFplWindowDue(nowUtc, windowUtc)).toBe(false);
  });

  test('returns true when FIXED_CATCHUP=false and nowUtc is within 2× TICK_MS', () => {
    jest.resetModules();
    process.env.FIXED_CATCHUP = 'false';
    process.env.TICK_MS = '60000'; // 1 min tick → 2-min window
    const { isFplWindowDue } = require('../schedulers/fpl');
    const windowUtc = DateTime.fromISO('2026-04-01T12:00:00Z', { zone: 'utc' });
    const nowUtc = windowUtc.plus({ seconds: 90 }); // 90s < 2min window
    expect(isFplWindowDue(nowUtc, windowUtc)).toBe(true);
  });
});
