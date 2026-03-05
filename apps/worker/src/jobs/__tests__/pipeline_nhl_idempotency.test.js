/**
 * Pipeline Idempotency Test — NHL Model
 *
 * Verifies that re-running the NHL model job does not create duplicates.
 * Steps:
 * 1) Seed deterministic NHL odds
 * 2) Run NHL model job twice
 * 3) Counts remain stable and no duplicates exist
 */

const { execSync } = require('child_process');
const fs = require('fs');

const TEST_DB_PATH = '/tmp/cheddar-nhl-idempotency.db';

async function queryDb(fn) {
  jest.resetModules();
  const { initDb, getDatabase, closeDatabase } = require('@cheddar-logic/data');
  await initDb();
  const db = getDatabase();
  try {
    return await fn(db);
  } finally {
    closeDatabase();
  }
}

function runCommand(command, cwd) {
  execSync(command, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
    env: {
      ...process.env,
      DATABASE_PATH: TEST_DB_PATH,
      RECORD_DATABASE_PATH: '',
      CHEDDAR_DB_PATH: '',
      DATABASE_URL: '',
      CHEDDAR_DB_AUTODISCOVER: 'false',
    },
  });
}

async function getCounts() {
  return queryDb((db) => {
    const modelOutputs = db
      .prepare('SELECT COUNT(*) as n FROM model_outputs')
      .get().n;
    const cardPayloads = db
      .prepare('SELECT COUNT(*) as n FROM card_payloads')
      .get().n;
    return { modelOutputs, cardPayloads };
  });
}

describe('pipeline idempotency (NHL)', () => {
  beforeAll(() => {
    process.env.DATABASE_PATH = TEST_DB_PATH;
    process.env.RECORD_DATABASE_PATH = '';
    process.env.CHEDDAR_DB_PATH = '';
    process.env.DATABASE_URL = '';
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    runCommand(
      'node ../../packages/data/src/seed-test-odds.js',
      '/Users/ajcolubiale/projects/cheddar-logic/apps/worker',
    );
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  test('re-running NHL model job does not create duplicates', async () => {
    runCommand(
      'npm run job:run-nhl-model',
      '/Users/ajcolubiale/projects/cheddar-logic/apps/worker',
    );

    const firstCounts = await getCounts();

    runCommand(
      'npm run job:run-nhl-model',
      '/Users/ajcolubiale/projects/cheddar-logic/apps/worker',
    );

    const secondCounts = await getCounts();
    expect(secondCounts).toEqual(firstCounts);

    const { modelDupes, cardDupes } = await queryDb((db) => {
      const modelDupes = db
        .prepare(
          `
        SELECT game_id, model_name, COUNT(*) as count
        FROM model_outputs
        GROUP BY game_id, model_name
        HAVING COUNT(*) > 1
      `,
        )
        .all();

      const cardDupes = db
        .prepare(
          `
        SELECT game_id, card_type, COUNT(*) as count
        FROM card_payloads
        GROUP BY game_id, card_type
        HAVING COUNT(*) > 1
      `,
        )
        .all();

      return { modelDupes, cardDupes };
    });

    if (secondCounts.modelOutputs > 0 || secondCounts.cardPayloads > 0) {
      expect(modelDupes.length).toBe(0);
      expect(cardDupes.length).toBe(0);
    }
  });
});
