const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cheddar-display-log-'));
}

function resetEnv() {
  delete process.env.CHEDDAR_DB_PATH;
  delete process.env.CHEDDAR_DB_AUTODISCOVER;
}

function buildPlayPayload({
  gameId,
  sport,
  homeTeam,
  awayTeam,
  officialStatus,
  marketType,
  selection,
  line,
  price,
  kind = 'PLAY',
}) {
  return {
    game_id: gameId,
    sport,
    kind,
    home_team: homeTeam,
    away_team: awayTeam,
    market_type: marketType,
    recommended_bet_type: marketType.toLowerCase(),
    selection: { side: selection },
    line,
    price,
    decision_v2: {
      official_status: officialStatus,
    },
    confidence_pct: 63.5,
  };
}

function ensureCoreTables(db) {
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS card_display_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pick_id TEXT UNIQUE NOT NULL,
      run_id TEXT,
      game_id TEXT,
      sport TEXT,
      market_type TEXT,
      selection TEXT,
      line REAL,
      odds REAL,
      odds_book TEXT,
      confidence_pct REAL,
      displayed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      api_endpoint TEXT
    );
  `);
}

describe('card_display_log capture for playable rows', () => {
  let tempDir;
  let dbPath;
  let dbModule;

  beforeEach(async () => {
    tempDir = makeTempDir();
    dbPath = path.join(tempDir, 'cheddar.db');
    process.env.CHEDDAR_DB_PATH = dbPath;
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';

    jest.resetModules();
    dbModule = require('../src/db.js');
    await dbModule.initDb();
  });

  afterEach(() => {
    if (dbModule) dbModule.closeDatabase();
    resetEnv();
    jest.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('logs only PLAY/LEAN rows (not PASS and not EVIDENCE kind)', () => {
    const db = dbModule.getDatabase();
    ensureCoreTables(db);
    const now = new Date().toISOString();
    const gameId = 'game-log-filter-1';

    db.prepare(
      `
      INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('g-1', 'nba', gameId, 'Home', 'Away', now, 'scheduled');

    dbModule.insertCardPayload({
      id: 'card-pass',
      gameId,
      sport: 'nba',
      cardType: 'nba-test-play',
      cardTitle: 'Pass card',
      createdAt: now,
      payloadData: buildPlayPayload({
        gameId,
        sport: 'NBA',
        homeTeam: 'Home',
        awayTeam: 'Away',
        officialStatus: 'PASS',
        marketType: 'SPREAD',
        selection: 'HOME',
        line: -3.5,
        price: -110,
      }),
      runId: 'run-a',
    });

    dbModule.insertCardPayload({
      id: 'card-evidence',
      gameId,
      sport: 'nba',
      cardType: 'nba-test-driver',
      cardTitle: 'Evidence card',
      createdAt: now,
      payloadData: buildPlayPayload({
        gameId,
        sport: 'NBA',
        homeTeam: 'Home',
        awayTeam: 'Away',
        officialStatus: 'PLAY',
        marketType: 'SPREAD',
        selection: 'HOME',
        line: -4.5,
        price: -112,
        kind: 'EVIDENCE',
      }),
      runId: 'run-a',
    });

    dbModule.insertCardPayload({
      id: 'card-lean',
      gameId,
      sport: 'nba',
      cardType: 'nba-test-play',
      cardTitle: 'Lean card',
      createdAt: now,
      payloadData: buildPlayPayload({
        gameId,
        sport: 'NBA',
        homeTeam: 'Home',
        awayTeam: 'Away',
        officialStatus: 'LEAN',
        marketType: 'SPREAD',
        selection: 'HOME',
        line: -2.5,
        price: -108,
      }),
      runId: 'run-a',
    });

    const rows = db
      .prepare(
        `SELECT pick_id, market_type, selection, line, odds FROM card_display_log ORDER BY id`,
      )
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].pick_id).toBe('card-lean');
    expect(String(rows[0].market_type).toUpperCase()).toBe('SPREAD');
    expect(String(rows[0].selection).toUpperCase()).toBe('HOME');
    expect(rows[0].line).toBe(-2.5);
    expect(rows[0].odds).toBe(-108);
  });

  test('keeps best line then best odds for duplicate game market picks', () => {
    const db = dbModule.getDatabase();
    ensureCoreTables(db);
    const now = new Date().toISOString();
    const gameId = 'game-best-line-1';

    db.prepare(
      `
      INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('g-2', 'nba', gameId, 'Home', 'Away', now, 'scheduled');

    dbModule.insertCardPayload({
      id: 'card-spread-a',
      gameId,
      sport: 'nba',
      cardType: 'nba-test-play',
      cardTitle: 'Spread A',
      createdAt: now,
      payloadData: buildPlayPayload({
        gameId,
        sport: 'NBA',
        homeTeam: 'Home',
        awayTeam: 'Away',
        officialStatus: 'PLAY',
        marketType: 'SPREAD',
        selection: 'HOME',
        line: -10.5,
        price: -110,
      }),
      runId: 'run-b',
    });

    dbModule.insertCardPayload({
      id: 'card-spread-b',
      gameId,
      sport: 'nba',
      cardType: 'nba-test-play',
      cardTitle: 'Spread B',
      createdAt: now,
      payloadData: buildPlayPayload({
        gameId,
        sport: 'NBA',
        homeTeam: 'Home',
        awayTeam: 'Away',
        officialStatus: 'PLAY',
        marketType: 'SPREAD',
        selection: 'HOME',
        line: -9.5, // better than -10.5
        price: -120,
      }),
      runId: 'run-b',
    });

    dbModule.insertCardPayload({
      id: 'card-spread-c',
      gameId,
      sport: 'nba',
      cardType: 'nba-test-play',
      cardTitle: 'Spread C',
      createdAt: now,
      payloadData: buildPlayPayload({
        gameId,
        sport: 'NBA',
        homeTeam: 'Home',
        awayTeam: 'Away',
        officialStatus: 'PLAY',
        marketType: 'SPREAD',
        selection: 'HOME',
        line: -9.5, // same best line, better odds
        price: -105,
      }),
      runId: 'run-b',
    });

    const row = db
      .prepare(
        `
        SELECT pick_id, line, odds, run_id, game_id, market_type, selection
        FROM card_display_log
        WHERE game_id = ?
        `,
      )
      .get(gameId);

    expect(row).toBeDefined();
    expect(row.pick_id).toBe('card-spread-c');
    expect(row.line).toBe(-9.5);
    expect(row.odds).toBe(-105);
    expect(row.run_id).toBe('run-b');
    expect(String(row.market_type).toUpperCase()).toBe('SPREAD');
    expect(String(row.selection).toUpperCase()).toBe('HOME');

    const totalRows = db
      .prepare(`SELECT COUNT(*) AS count FROM card_display_log WHERE game_id = ?`)
      .get(gameId);
    expect(totalRows.count).toBe(1);
  });
});
