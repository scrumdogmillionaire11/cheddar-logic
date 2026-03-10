const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cheddar-card-sport-'));
}

function resetEnv() {
  delete process.env.CHEDDAR_DB_PATH;
}

describe('card payload/card_results sport normalization', () => {
  let tempDir;
  let dbPath;
  let dbModule;

  beforeEach(async () => {
    tempDir = makeTempDir();
    dbPath = path.join(tempDir, 'cheddar.db');
    process.env.CHEDDAR_DB_PATH = dbPath;

    jest.resetModules();
    dbModule = require('../src/db.js');
    await dbModule.initDb();
  });

  afterEach(() => {
    if (dbModule) {
      dbModule.closeDatabase();
    }
    resetEnv();
    jest.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('insertCardPayload writes lowercase sport and auto-enrolled card_results sport is lowercase', () => {
    const db = dbModule.getDatabase();
    const now = new Date();
    const futureTime = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const gameId = 'test-game-sport-1';

    db.exec(`
      CREATE TABLE IF NOT EXISTS games (
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
      CREATE TABLE IF NOT EXISTS card_payloads (
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
        run_id TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (game_id) REFERENCES games(game_id)
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS card_results (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        sport TEXT NOT NULL,
        card_type TEXT NOT NULL,
        recommended_bet_type TEXT NOT NULL,
        market_key TEXT,
        market_type TEXT,
        selection TEXT,
        line REAL,
        locked_price INTEGER,
        status TEXT NOT NULL,
        result TEXT,
        settled_at TEXT,
        pnl_units REAL,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (card_id) REFERENCES card_payloads(id)
      );
    `);

    db.prepare(
      `INSERT INTO games (
        id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'game-1',
      'nba',
      gameId,
      'Home Team',
      'Away Team',
      futureTime,
      'scheduled',
      now.toISOString(),
      now.toISOString()
    );

    dbModule.insertCardPayload({
      id: 'card-test-1',
      gameId,
      sport: 'nba',
      cardType: 'test-card',
      cardTitle: 'Test Card',
      createdAt: now.toISOString(),
      expiresAt: futureTime,
      payloadData: {
        game_id: gameId,
        sport: 'nba',
        home_team: 'Home Team',
        away_team: 'Away Team',
        recommendation: {
          type: 'ML_HOME',
          text: 'Test recommendation',
        },
        prediction: 'HOME',
        recommended_bet_type: 'moneyline',
        odds_context: {
          h2h_home: -110,
          h2h_away: 100,
        },
      },
      modelOutputIds: null,
      metadata: null,
      runId: 'run-test-1',
    });

    const row = db
      .prepare('SELECT sport FROM card_payloads WHERE id = ?')
      .get('card-test-1');

    expect(row.sport).toBe('nba');

    const resultRow = db
      .prepare('SELECT sport FROM card_results WHERE card_id = ?')
      .get('card-test-1');

    expect(resultRow).toBeDefined();
    expect(resultRow.sport).toBe('nba');
  });
});
