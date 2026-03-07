const fs = require('fs');
const {
  closeDatabase,
  insertJobRun,
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
});
