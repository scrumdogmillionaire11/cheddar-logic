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
const { initDb, getDatabase, closeDatabase } = require('@cheddar-logic/data');

const TEST_DB_PATH = '/tmp/cheddar-test.db';

async function queryDb(fn) {
  await initDb();
  const db = getDatabase();
  try {
    return await fn(db);
  } finally {
    closeDatabase();
  }
}

describe('pull_odds_hourly job', () => {
  beforeAll(() => {
    process.env.DATABASE_PATH = TEST_DB_PATH;
    // Remove test DB if exists
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  afterAll(() => {
    // Clean up test DB
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  test('job executes successfully with exit code 0', () => {
    try {
      const result = execSync(
        `DATABASE_PATH=${TEST_DB_PATH} npm run job:pull-odds`,
        {
          cwd: '/Users/ajcolubiale/projects/cheddar-logic/apps/worker',
          stdio: 'pipe',
          encoding: 'utf-8'
        }
      );
      expect(result).toBeDefined();
    } catch (error) {
      throw new Error(`Job failed with exit code ${error.status}: ${error.stdout || error.message}`);
    }
  });

  test('job_runs table records job execution as success', async () => {
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
    expect(new Date(result.started_at).getTime()).toBeLessThan(new Date(result.ended_at).getTime());
  });

  test('odds_snapshots table has valid schema and non-null required fields', async () => {
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
    results.forEach(row => {
      expect(row.id).toBeTruthy();
      expect(row.game_id).toBeTruthy();
      expect(row.sport).toBeTruthy();
      expect(row.captured_at).toBeTruthy();
      
      // captured_at should be ISO 8601 UTC
      const capturedTime = new Date(row.captured_at);
      expect(capturedTime.getTime()).toBeGreaterThan(0);
      expect(row.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      // Odds should be numbers (or null for optional fields)
      expect(typeof row.h2h_home === 'number' || row.h2h_home === null).toBe(true);
      expect(typeof row.h2h_away === 'number' || row.h2h_away === null).toBe(true);
      expect(typeof row.total === 'number' || row.total === null).toBe(true);

      // Should link to job_run
      expect(row.job_run_id).toBeTruthy();
    });
  });

  test('odds_snapshots has at least one snapshot per fetched sport', async () => {
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
    console.log('Sports fetched:', results.map(r => `${r.sport}(${r.count})`).join(', '));

    results.forEach(row => {
      expect(row.count).toBeGreaterThan(0);
    });
  });

  test('all odds_snapshots reference valid job_run', async () => {
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

  test('job_runs record has no error_message on success', async () => {
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
});
