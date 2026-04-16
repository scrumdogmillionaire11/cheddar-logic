/**
 * Smoke Test — Pull Odds Hourly Job
 *
 * Verifies:
 * 1. Job runs without error (exit code 0)
 * 2. job_runs table records job execution (status='success')
 * 3. odds_snapshots table has valid schema + non-null fields
 * 4. At least one snapshot per sport
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  getDatabase,
  closeDatabase,
  runMigrations,
  resolveSnapshotAge,
} = require('@cheddar-logic/data');

const TEST_DB_PATH = '/tmp/cheddar-test.db';

async function queryDb(fn) {
  const db = getDatabase();
  try {
    return await fn(db);
  } finally {
    closeDatabase();
  }
}

describe('pull_odds_hourly job', () => {
  const hasOddsKey = Boolean(process.env.ODDS_API_KEY);
  const maybeTest = hasOddsKey ? test : test.skip;

  beforeAll(async () => {
    process.env.DATABASE_PATH = TEST_DB_PATH;
    process.env.RECORD_DATABASE_PATH = '';
    process.env.CHEDDAR_DB_PATH = '';
    process.env.DATABASE_URL = '';
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    // Remove test DB if exists
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    await runMigrations();
  });

  afterAll(() => {
    // Clean up test DB
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  maybeTest('job executes successfully with exit code 0', () => {
    try {
      const result = execSync(
        `DATABASE_PATH=${TEST_DB_PATH} npm run job:pull-odds`,
        {
          cwd: path.resolve(__dirname, '../../..'),

          stdio: 'pipe',
          encoding: 'utf-8',
        },
      );
      expect(result).toBeDefined();
    } catch (error) {
      throw new Error(
        `Job failed with exit code ${error.status}: ${error.stdout || error.message}`,
      );
    }
  });

  maybeTest('job_runs table records job execution as success', async () => {
    const result = await queryDb((db) => {
      const stmt = db.prepare(`
        SELECT id, job_name, status, started_at, ended_at
        FROM job_runs
        WHERE job_name = 'pull_odds_hourly' AND status = 'success'
        ORDER BY started_at DESC
        LIMIT 1
      `);
      return stmt.get();
    });

    expect(result).toBeDefined();
    expect(result.job_name).toBe('pull_odds_hourly');
    expect(result.status).toBe('success');
    expect(result.started_at).toBeTruthy();
    expect(result.ended_at).toBeTruthy();
    expect(new Date(result.started_at).getTime()).toBeLessThan(
      new Date(result.ended_at).getTime(),
    );
  });

  maybeTest(
    'odds_snapshots table has valid schema and non-null required fields',
    async () => {
      const results = await queryDb((db) => {
        const stmt = db.prepare(`
        SELECT 
          id, game_id, sport, captured_at,
          h2h_home, h2h_away, total,
          raw_data, job_run_id
        FROM odds_snapshots
        LIMIT 100
      `);
        return stmt.all();
      });

      expect(results.length).toBeGreaterThan(0);

      // Verify each row has required fields
      results.forEach((row) => {
        expect(row.id).toBeTruthy();
        expect(row.game_id).toBeTruthy();
        expect(row.sport).toBeTruthy();
        expect(row.captured_at).toBeTruthy();

        // captured_at should be ISO 8601 UTC
        const capturedTime = new Date(row.captured_at);
        expect(capturedTime.getTime()).toBeGreaterThan(0);
        expect(row.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

        // Odds should be numbers (or null for optional fields)
        expect(typeof row.h2h_home === 'number' || row.h2h_home === null).toBe(
          true,
        );
        expect(typeof row.h2h_away === 'number' || row.h2h_away === null).toBe(
          true,
        );
        expect(typeof row.total === 'number' || row.total === null).toBe(true);

        // Should link to job_run
        expect(row.job_run_id).toBeTruthy();
      });
    },
  );

  maybeTest(
    'odds_snapshots has at least one snapshot per fetched sport',
    async () => {
      const results = await queryDb((db) => {
        const stmt = db.prepare(`
        SELECT DISTINCT sport, COUNT(*) as count
        FROM odds_snapshots
        GROUP BY sport
        ORDER BY sport
      `);
        return stmt.all();
      });

      expect(results.length).toBeGreaterThan(0);
      console.log(
        'Sports fetched:',
        results.map((r) => `${r.sport}(${r.count})`).join(', '),
      );

      results.forEach((row) => {
        expect(row.count).toBeGreaterThan(0);
      });
    },
  );

  maybeTest('all odds_snapshots reference valid job_run', async () => {
    const orphaned = await queryDb((db) => {
      const stmt = db.prepare(`
        SELECT os.id as snapshot_id, os.job_run_id
        FROM odds_snapshots os
        LEFT JOIN job_runs jr ON os.job_run_id = jr.id
        WHERE jr.id IS NULL
        LIMIT 1
      `);
      return stmt.get();
    });

    expect(orphaned).toBeUndefined();
  });

  maybeTest('job_runs record has no error_message on success', async () => {
    const result = await queryDb((db) => {
      const stmt = db.prepare(`
        SELECT error_message
        FROM job_runs
        WHERE job_name = 'pull_odds_hourly' AND status = 'success'
        LIMIT 1
      `);
      return stmt.get();
    });

    expect(result).toBeDefined();
    expect(result.error_message).toBeNull();
  });

  describe('resolveSnapshotAge timestamp provenance', () => {
    const fixedNowMs = Date.parse('2026-04-15T19:30:15.123Z');

    test('1. Valid captured_at uses primary field with VALID status', () => {
      const result = resolveSnapshotAge(
        {
          captured_at: '2026-04-15T19:10:12Z',
          pulled_at: '2026-04-15T19:15:00Z',
          updated_at: '2026-04-15T19:20:00Z',
        },
        { nowMs: fixedNowMs, sport: 'mlb', gameId: 'g1', snapshotId: 's1' },
      );
      expect(result.source_field).toBe('captured_at');
      expect(result.status).toBe('VALID');
      expect(result.fallback_chain_executed).toBe(false);
      expect(result.resolved_age_ms).toBeGreaterThan(0);
    });

    test('2. Missing captured_at falls back to pulled_at with DEGRADED status', () => {
      const result = resolveSnapshotAge(
        {
          captured_at: null,
          pulled_at: '2026-04-15T19:15:00Z',
          updated_at: '2026-04-15T19:20:00Z',
        },
        { nowMs: fixedNowMs },
      );
      expect(result.source_field).toBe('pulled_at');
      expect(result.status).toBe('DEGRADED');
      expect(result.fallback_chain_executed).toBe(true);
    });

    test('3. Missing captured_at and pulled_at falls back to updated_at with DEGRADED status', () => {
      const result = resolveSnapshotAge(
        {
          captured_at: null,
          pulled_at: null,
          updated_at: '2026-04-15T19:10:00Z',
        },
        { nowMs: fixedNowMs },
      );
      expect(result.source_field).toBe('updated_at');
      expect(result.status).toBe('DEGRADED');
      expect(result.fallback_chain_executed).toBe(true);
    });

    test('4. All null falls back to now with DEGRADED status and near-zero age', () => {
      const result = resolveSnapshotAge(
        { captured_at: null, pulled_at: null, updated_at: null },
        { nowMs: fixedNowMs },
      );
      expect(result.source_field).toBe('now');
      expect(result.status).toBe('DEGRADED');
      expect(result.resolved_age_ms).toBe(0);
    });

    test('5. Malformed ISO date-only triggers MALFORMED status with fallback', () => {
      const result = resolveSnapshotAge(
        {
          captured_at: '2026-04-15',
          pulled_at: '2026-04-15T19:15:00Z',
          updated_at: null,
        },
        { nowMs: fixedNowMs },
      );
      expect(result.source_field).toBe('pulled_at');
      expect(result.status).toBe('MALFORMED');
      expect(result.fallback_chain_executed).toBe(true);
    });

    test('6. Malformed Unix epoch string triggers MALFORMED status', () => {
      const result = resolveSnapshotAge(
        {
          captured_at: '1713200400',
          pulled_at: '2026-04-15T19:15:00Z',
          updated_at: null,
        },
        { nowMs: fixedNowMs },
      );
      expect(result.status).toBe('MALFORMED');
      expect(result.source_field).toBe('pulled_at');
    });

    test('7. Future captured_at triggers MONOTONIC_VIOLATION status', () => {
      const result = resolveSnapshotAge(
        {
          captured_at: '2026-04-15T20:30:15.123Z',
          pulled_at: '2026-04-15T19:15:00Z',
          updated_at: '2026-04-15T19:16:00Z',
        },
        { nowMs: fixedNowMs },
      );
      expect(result.status).toBe('MONOTONIC_VIOLATION');
      expect(Array.isArray(result.violations)).toBe(true);
      expect(result.violations.length).toBeGreaterThan(0);
    });

    test('8. Timezone offset normalizes to UTC and calculates age correctly', () => {
      const nowMs = Date.parse('2026-04-15T14:30:10.000Z');
      const result = resolveSnapshotAge(
        {
          captured_at: '2026-04-15T19:30:00+05:30',
          pulled_at: null,
          updated_at: null,
        },
        { nowMs },
      );
      expect(result.status).toBe('VALID');
      expect(result.resolved_timestamp).toBe('2026-04-15T14:00:00.000Z');
      expect(result.resolved_age_ms).toBe(30 * 60 * 1000 + 10 * 1000);
    });

    test('9. Non-monotonic ordering triggers MONOTONIC_VIOLATION', () => {
      const result = resolveSnapshotAge(
        {
          captured_at: '2026-04-15T19:20:00Z',
          pulled_at: '2026-04-15T19:10:00Z',
          updated_at: '2026-04-15T19:09:00Z',
        },
        { nowMs: fixedNowMs },
      );
      expect(result.status).toBe('MONOTONIC_VIOLATION');
      expect(result.violations).toEqual(
        expect.arrayContaining([
          expect.stringContaining('pulled_at < captured_at'),
          expect.stringContaining('updated_at < pulled_at'),
        ]),
      );
    });

    test('10. Near-zero age captures recent timestamp with VALID status', () => {
      const nowMs = Date.parse('2026-04-15T19:30:15.123Z');
      const result = resolveSnapshotAge(
        {
          captured_at: '2026-04-15T19:30:15.073Z',
          pulled_at: null,
          updated_at: null,
        },
        { nowMs },
      );
      expect(result.status).toBe('VALID');
      expect(result.source_field).toBe('captured_at');
      expect(result.resolved_age_ms).toBe(50);
    });
  });

  describe('after-odds settlement sweep job keys', () => {
    const originalEnableSettlement = process.env.ENABLE_SETTLEMENT;
    const originalAppEnv = process.env.APP_ENV;

    beforeEach(() => {
      jest.resetModules();
      process.env.ENABLE_SETTLEMENT = 'true';
      process.env.APP_ENV = 'test';
    });

    afterEach(() => {
      jest.resetModules();
      process.env.ENABLE_SETTLEMENT = originalEnableSettlement;
      process.env.APP_ENV = originalAppEnv;
    });

    async function loadSubject({
      settleGameResultsImpl,
      settleProjectionsImpl,
      settlePendingCardsImpl,
    } = {}) {
      const mocks = {
        settleGameResults: settleGameResultsImpl || jest.fn().mockResolvedValue({ success: true }),
        settleProjections: settleProjectionsImpl || jest.fn().mockResolvedValue({ success: true }),
        settlePendingCards: settlePendingCardsImpl || jest.fn().mockResolvedValue({ success: true }),
        insertJobRun: jest.fn(),
        markJobRunSuccess: jest.fn(),
        markJobRunFailure: jest.fn(),
      };

      jest.doMock('dotenv', () => ({ config: jest.fn() }));
      jest.doMock('@cheddar-logic/data', () => ({
        insertJobRun: mocks.insertJobRun,
        markJobRunSuccess: mocks.markJobRunSuccess,
        markJobRunFailure: mocks.markJobRunFailure,
        shouldRunJobKey: jest.fn().mockReturnValue(true),
        getDatabase: jest.fn(),
        upsertGame: jest.fn(),
        insertOddsSnapshot: jest.fn(),
        recordOddsIngestFailure: jest.fn(),
        withDb: jest.fn(async (fn) => fn()),
        getQuotaLedger: jest.fn(),
        upsertQuotaLedger: jest.fn(),
        isQuotaCircuitOpen: jest.fn(() => ({ open: false })),
        resolveSnapshotAge: jest.fn(),
      }));
      jest.doMock('@cheddar-logic/data/src/normalize', () => ({
        resolveTeamVariant: jest.fn(),
      }));
      jest.doMock('@cheddar-logic/odds/src/normalize', () => ({
        validateMarketContract: jest.fn(),
      }));
      jest.doMock('@cheddar-logic/odds', () => ({
        fetchOdds: jest.fn().mockResolvedValue({
          games: [],
          errors: [],
          rawCount: 0,
          windowRawCount: 0,
          remainingTokens: null,
        }),
        getActiveSports: jest.fn(() => ['NHL']),
        getTokensForFetch: jest.fn(() => 1),
      }));
      jest.doMock('../settle_game_results', () => ({
        settleGameResults: mocks.settleGameResults,
      }));
      jest.doMock('../settle_projections', () => ({
        settleProjections: mocks.settleProjections,
      }));
      jest.doMock('../settle_pending_cards', () => ({
        settlePendingCards: mocks.settlePendingCards,
      }));

      const { pullOddsHourly } = require('../pull_odds_hourly');
      return { pullOddsHourly, mocks };
    }

    test('uses canonical game-results, projections, and pending-cards keys', async () => {
      const { pullOddsHourly, mocks } = await loadSubject();

      const result = await pullOddsHourly({
        jobKey: 'hourly|2026-04-15|01',
        dryRun: false,
      });

      expect(result.success).toBe(true);
      expect(mocks.settleGameResults).toHaveBeenCalledWith({
        jobKey: 'settle|after-odds|hourly|2026-04-15|01|game-results',
        dryRun: false,
        minHoursAfterStart: 0,
      });
      expect(mocks.settleProjections).toHaveBeenCalledWith({
        jobKey: 'settle|after-odds|hourly|2026-04-15|01|projections',
        dryRun: false,
      });
      expect(mocks.settlePendingCards).toHaveBeenCalledWith({
        jobKey: 'settle|after-odds|hourly|2026-04-15|01|pending-cards',
        dryRun: false,
      });
    });

    test('continues through canonical guarded keys when game-results returns skipped', async () => {
      const { pullOddsHourly, mocks } = await loadSubject({
        settleGameResultsImpl: jest.fn().mockResolvedValue({
          success: true,
          skipped: true,
          guardedBy: 'another-process',
        }),
      });

      const result = await pullOddsHourly({
        jobKey: 'nightly|2026-04-15',
        dryRun: false,
      });

      expect(result.success).toBe(true);
      expect(mocks.settleGameResults).toHaveBeenCalledWith({
        jobKey: 'settle|after-odds|nightly|2026-04-15|game-results',
        dryRun: false,
        minHoursAfterStart: 0,
      });
      expect(mocks.settleProjections).toHaveBeenCalledWith({
        jobKey: 'settle|after-odds|nightly|2026-04-15|projections',
        dryRun: false,
      });
      expect(mocks.settlePendingCards).toHaveBeenCalledWith({
        jobKey: 'settle|after-odds|nightly|2026-04-15|pending-cards',
        dryRun: false,
      });
    });
  });

  if (!hasOddsKey) {
    console.warn('[pull_odds_hourly.test] Skipping: ODDS_API_KEY not set.');
  }
});
