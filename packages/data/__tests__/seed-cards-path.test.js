const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cheddar-seed-'));
}

function resetEnv() {
  delete process.env.DATABASE_PATH;
  delete process.env.CHEDDAR_DATA_DIR;
}

describe('seed-cards DATABASE_PATH', () => {
  let tempDir;
  let dbPath;
  let altDir;

  beforeEach(() => {
    tempDir = makeTempDir();
    dbPath = path.join(tempDir, 'cheddar.db');
    altDir = path.join(tempDir, 'alt-data');
  });

  afterEach(() => {
    resetEnv();
    jest.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('writes card payloads to DATABASE_PATH', async () => {
    process.env.DATABASE_PATH = dbPath;
    process.env.CHEDDAR_DATA_DIR = altDir;

    jest.resetModules();
    const { initDb, getDatabase, closeDatabase } = require('../src/db.js');

    await initDb();
    const db = getDatabase();

    db.exec(`
      CREATE TABLE games (
        id TEXT PRIMARY KEY,
        sport TEXT NOT NULL,
        game_id TEXT NOT NULL UNIQUE,
        home_team TEXT NOT NULL,
        away_team TEXT NOT NULL,
        game_time_utc TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    db.exec(`
      CREATE TABLE card_payloads (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        sport TEXT NOT NULL,
        card_type TEXT NOT NULL,
        card_title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        payload_data TEXT NOT NULL,
        model_output_ids TEXT,
        metadata TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (game_id) REFERENCES games(game_id)
      );
    `);

    const gameId = 'test-game-1';
    const now = new Date();
    const futureTime = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO games (
        id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'game-1',
      'NBA',
      gameId,
      'Home Team',
      'Away Team',
      futureTime,
      'scheduled',
      now.toISOString(),
      now.toISOString()
    );

    closeDatabase();

    jest.resetModules();
    const { seedCards } = require('../src/seed-cards.js');
    await seedCards();

    jest.resetModules();
    const { initDb: initDb2, getDatabase: getDatabase2, closeDatabase: closeDatabase2 } = require('../src/db.js');
    await initDb2();
    const db2 = getDatabase2();

    const count = db2.prepare('SELECT COUNT(*) as c FROM card_payloads').get();
    closeDatabase2();

    expect(count.c).toBeGreaterThan(0);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(path.join(altDir, 'cheddar.db'))).toBe(false);
  });
});
