const fs = require('fs');
const {
  closeDatabase,
  insertJobRun,
  markJobRunSuccess,
  hasRunningJobRun,
  hasSuccessfulJobRun,
  runMigrations,
} = require('@cheddar-logic/data');

const TEST_DB_PATH = '/tmp/cheddar-test-job-run-claim.db';
const LOCK_PATH = `${TEST_DB_PATH}.lock`;

function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best-effort cleanup for test artifacts.
  }
}

describe('job run claim guard', () => {
  beforeAll(async () => {
    process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS = 'false';

    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);

    await runMigrations();
  });

  afterAll(() => {
    closeDatabase();
    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);
  });

  test('insertJobRun rejects duplicate running job_key', () => {
    const jobKey = 'odds|hourly|test|1';
    insertJobRun('pull_odds_hourly', `job-${Date.now()}-a`, jobKey);

    expect(() => {
      insertJobRun('pull_odds_hourly', `job-${Date.now()}-b`, jobKey);
    }).toThrow(/already claimed/i);
  });

  test('hasRunningJobRun detects concurrent job execution', () => {
    const jobKey = 'settle|global|pending-cards';
    const jobId = `job-${Date.now()}-a`;

    // Initially no running job
    expect(hasRunningJobRun(jobKey)).toBe(false);

    // Start a job
    insertJobRun('settle_pending_cards', jobId, jobKey);

    // Now hasRunningJobRun should return true
    expect(hasRunningJobRun(jobKey)).toBe(true);

    // Mark it as success
    markJobRunSuccess(jobId);

    // Now it's no longer running (but is successful)
    expect(hasRunningJobRun(jobKey)).toBe(false);
    expect(hasSuccessfulJobRun(jobKey)).toBe(true);
  });

  test('singleton settlement keys prevent concurrent execution', () => {
    const settlementKey = 'settle|global|game-results';

    // Process A claims settlement
    const jobIdA = `settlement-a-${Date.now()}`;
    insertJobRun('settle_game_results', jobIdA, settlementKey);

    // Process B tries to claim same settlement
    const jobIdB = `settlement-b-${Date.now()}`;
    expect(() => {
      insertJobRun('settle_game_results', jobIdB, settlementKey);
    }).toThrow(/already claimed/i);

    // Verify Process A is still running
    expect(hasRunningJobRun(settlementKey)).toBe(true);
  });

  test('game-specific model run keys prevent duplicate work', () => {
    const gameId = 'abc123';
    const runId = 'run-xyz';
    const modelJobKey = `ncaam-model|${gameId}|${runId}`;

    // Process A starts model for game
    const jobIdA = `model-a-${Date.now()}`;
    insertJobRun('run_ncaam_model', jobIdA, modelJobKey);

    // Process B detects running job and should skip
    expect(hasRunningJobRun(modelJobKey)).toBe(true);

    // Process B tries to claim (should fail)
    const jobIdB = `model-b-${Date.now()}`;
    expect(() => {
      insertJobRun('run_ncaam_model', jobIdB, modelJobKey);
    }).toThrow(/already claimed/i);
  });
});
