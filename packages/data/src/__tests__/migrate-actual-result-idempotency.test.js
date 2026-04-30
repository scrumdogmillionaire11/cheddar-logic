const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL_MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');
const ACTUAL_RESULT_MIGRATION = '090_add_card_payloads_actual_result.sql';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeTempDbPath() {
  return path.join(makeTempDir('cheddar-migrate-actual-result-'), 'test.db');
}

function resetDbEnv() {
  delete process.env.CHEDDAR_DB_PATH;
  delete process.env.CHEDDAR_MIGRATIONS_DIR;
  delete process.env.CHEDDAR_DB_AUTODISCOVER;
  delete process.env.DATABASE_PATH;
  delete process.env.DATABASE_URL;
  delete process.env.RECORD_DATABASE_PATH;
}

function copyMigrationsBeforeActualResult(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  const files = fs.readdirSync(REAL_MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql') && file < ACTUAL_RESULT_MIGRATION)
    .sort();

  for (const file of files) {
    fs.copyFileSync(
      path.join(REAL_MIGRATIONS_DIR, file),
      path.join(targetDir, file),
    );
  }
}

function getCardPayloadColumns(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('PRAGMA table_info(card_payloads)').all();
  } finally {
    db.close();
  }
}

describe('runMigrations actual_result idempotency', () => {
  afterEach(() => {
    try {
      require('../db/connection').closeDatabase();
    } catch {
      // best effort cleanup
    }
    jest.resetModules();
    resetDbEnv();
  });

  test('clean database gets actual_result via migration 090', async () => {
    const dbPath = makeTempDbPath();
    process.env.CHEDDAR_DB_PATH = dbPath;

    const { runMigrations } = require('../migrate');
    await runMigrations();

    const columns = getCardPayloadColumns(dbPath);
    expect(columns.some((column) => column.name === 'actual_result')).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    try {
      const migration = db.prepare(
        'SELECT name FROM migrations WHERE name = ?',
      ).get(ACTUAL_RESULT_MIGRATION);
      expect(migration).toEqual({ name: ACTUAL_RESULT_MIGRATION });
    } finally {
      db.close();
    }
  });

  test('pre-existing actual_result column is treated as already migrated', async () => {
    const dbPath = makeTempDbPath();
    const pre090MigrationsDir = makeTempDir('cheddar-migrations-pre-090-');

    process.env.CHEDDAR_DB_PATH = dbPath;
    process.env.CHEDDAR_MIGRATIONS_DIR = pre090MigrationsDir;
    copyMigrationsBeforeActualResult(pre090MigrationsDir);

    const { runMigrations } = require('../migrate');
    await runMigrations();

    require('../db/connection').closeDatabase();

    const db = new Database(dbPath);
    try {
      db.exec('ALTER TABLE card_payloads ADD COLUMN actual_result TEXT');
    } finally {
      db.close();
    }

    process.env.CHEDDAR_MIGRATIONS_DIR = REAL_MIGRATIONS_DIR;
    await runMigrations();

    const columns = getCardPayloadColumns(dbPath);
    expect(columns.filter((column) => column.name === 'actual_result')).toHaveLength(1);

    const verifyDb = new Database(dbPath, { readonly: true });
    try {
      const migration = verifyDb.prepare(
        'SELECT name FROM migrations WHERE name = ?',
      ).get(ACTUAL_RESULT_MIGRATION);
      expect(migration).toEqual({ name: ACTUAL_RESULT_MIGRATION });
    } finally {
      verifyDb.close();
    }
  });
});
