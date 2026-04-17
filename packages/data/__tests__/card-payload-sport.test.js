const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cheddar-card-sport-'));
}

function resetEnv() {
  delete process.env.CHEDDAR_DB_PATH;
}

function ensureSettlementTables(db) {
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
      first_seen_price REAL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (game_id) REFERENCES games(game_id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS card_results (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL UNIQUE,
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
        first_seen_price REAL,
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

  test('backfillCardResultsSportCasing normalizes mixed-case sport values', () => {
    const db = dbModule.getDatabase();
    const now = new Date();

    // Create minimal schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS card_results (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL UNIQUE,
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
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Insert card_results with mixed-case sports (simulating historical data)
    db.prepare(`
      INSERT INTO card_results (
        id, card_id, game_id, sport, card_type, recommended_bet_type, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'result-1',
      'card-1',
      'game-1',
      'NBA',
      'test-card',
      'moneyline',
      'pending',
      now.toISOString(),
      now.toISOString()
    );

    db.prepare(`
      INSERT INTO card_results (
        id, card_id, game_id, sport, card_type, recommended_bet_type, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'result-2',
      'card-2',
      'game-2',
      'Nhl',
      'test-card',
      'moneyline',
      'pending',
      now.toISOString(),
      now.toISOString()
    );

    db.prepare(`
      INSERT INTO card_results (
        id, card_id, game_id, sport, card_type, recommended_bet_type, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'result-3',
      'card-3',
      'game-3',
      'ncaam',
      'test-card',
      'moneyline',
      'pending',
      now.toISOString(),
      now.toISOString()
    );

    // Verify mixed-case before backfill
    const beforeBackfill = db.prepare('SELECT sport FROM card_results ORDER BY id').all();
    expect(beforeBackfill[0].sport).toBe('NBA');
    expect(beforeBackfill[1].sport).toBe('Nhl');
    expect(beforeBackfill[2].sport).toBe('ncaam');

    // Run backfill
    const result = dbModule.backfillCardResultsSportCasing();
    expect(result.errors).toBeNull();
    // Affected should be 2 (NBA and Nhl need normalization)
    expect(result.affected).toBeGreaterThanOrEqual(2);

    // Verify all lowercase after backfill
    const afterBackfill = db.prepare('SELECT sport FROM card_results ORDER BY id').all();
    expect(afterBackfill[0].sport).toBe('nba');
    expect(afterBackfill[1].sport).toBe('nhl');
    expect(afterBackfill[2].sport).toBe('ncaam');
  });

  test('insertCardResult always writes lowercase sport regardless of input case (guardrail)', () => {
    const db = dbModule.getDatabase();
    const now = new Date();
    const futureTime = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const gameId = 'test-game-guardrail';

    // Create minimal schema
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
        first_seen_price REAL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (game_id) REFERENCES games(game_id)
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS card_results (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL UNIQUE,
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
      'game-guardrail',
      'nba',
      gameId,
      'Home Team',
      'Away Team',
      futureTime,
      'scheduled',
      now.toISOString(),
      now.toISOString()
    );

    db.prepare(`
      INSERT INTO card_payloads (
        id, game_id, sport, card_type, card_title, created_at, expires_at,
        payload_data, model_output_ids, metadata, run_id, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'card-guardrail',
      gameId,
      'nba',
      'test-card',
      'Test Card',
      now.toISOString(),
      futureTime,
      '{}',
      null,
      null,
      'run-guardrail',
      now.toISOString()
    );

    // Insert card result with mixed-case sport (guardrail test)
    dbModule.insertCardResult({
      id: 'result-guardrail',
      cardId: 'card-guardrail',
      gameId,
      sport: 'NBA',  // Mixed case input
      cardType: 'test-card',
      recommendedBetType: 'moneyline',
      status: 'pending',
    });

    // Verify sport is normalized to lowercase in the database
    const resultRow = db
      .prepare('SELECT sport FROM card_results WHERE id = ?')
      .get('result-guardrail');

    expect(resultRow).toBeDefined();
    expect(resultRow.sport).toBe('nba');
    expect(resultRow.sport).not.toBe('NBA');
  });

  test('all card_results rows have lowercase sport (regression check)', () => {
    const db = dbModule.getDatabase();
    const now = new Date();

    // Create schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS card_results (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL UNIQUE,
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
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Insert several test records with various casing
    const testCases = [
      { id: 'r1', card: 'c1', game: 'g1', sport: 'nba' },
      { id: 'r2', card: 'c2', game: 'g2', sport: 'NHL' },
      { id: 'r3', card: 'c3', game: 'g3', sport: 'NcAam' },
    ];

    testCases.forEach(tc => {
      db.prepare(`
        INSERT INTO card_results (
          id, card_id, game_id, sport, card_type, recommended_bet_type, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tc.id,
        tc.card,
        tc.game,
        tc.sport,
        'test-card',
        'moneyline',
        'pending',
        now.toISOString(),
        now.toISOString()
      );
    });

    // Verify all rows have lowercase sport (after backfill)
    dbModule.backfillCardResultsSportCasing();

    const allRows = db.prepare('SELECT sport FROM card_results ORDER BY id').all();
    const allLowercase = allRows.every(row => row.sport === row.sport.toLowerCase());
    expect(allLowercase).toBe(true);

    // Verify specific normalized values
    expect(allRows[0].sport).toBe('nba');
    expect(allRows[1].sport).toBe('nhl');
    expect(allRows[2].sport).toBe('ncaam');
  });

  test('NHL full-game totals with PASS status do not enroll in card_display_log', () => {
    const db = dbModule.getDatabase();
    const now = new Date();
    const gameTimeUtc = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const gameId = 'test-nhl-full-total-pass';
    ensureSettlementTables(db);

    db.prepare(
      `INSERT INTO games (
        id, sport, game_id, home_team, away_team, game_time_utc, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'game-nhl-full-total-pass',
      'nhl',
      gameId,
      'Home Team',
      'Away Team',
      gameTimeUtc,
      'scheduled'
    );

    dbModule.insertCardPayload({
      id: 'card-nhl-full-total-pass',
      gameId,
      sport: 'nhl',
      cardType: 'nhl-totals-call',
      cardTitle: 'NHL Totals: OVER 6.5',
      createdAt: now.toISOString(),
      payloadData: {
        game_id: gameId,
        sport: 'NHL',
        kind: 'PLAY',
        status: 'PASS',
        decision_v2: { official_status: 'PASS' },
        market_type: 'TOTAL',
        selection: { side: 'OVER' },
        line: 6.5,
        odds_context: {
          total: 6.5,
          total_price_over: -110,
          total_price_under: -110,
        },
      },
      runId: 'run-nhl-full-total-pass',
    });

    const resultRow = db
      .prepare(
        `SELECT market_type, selection, line, locked_price, market_key
         FROM card_results
         WHERE card_id = ?`
      )
      .get('card-nhl-full-total-pass');
    expect(resultRow).toMatchObject({
      market_type: 'TOTAL',
      selection: 'OVER',
      line: 6.5,
      locked_price: -110,
      market_key: `${gameId}:TOTAL:OVER:6.5`,
    });

    const displayRow = db
      .prepare(
        `SELECT pick_id, market_type, selection
         FROM card_display_log
         WHERE pick_id = ?`
      )
      .get('card-nhl-full-total-pass');
    expect(displayRow).toBeNull();
  });

  test('NHL 1P totals lock from *_1p prices and only enroll actionable statuses', () => {
    const db = dbModule.getDatabase();
    const now = new Date();
    const gameTimeUtc = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const gameId = 'test-nhl-1p-actionable';
    ensureSettlementTables(db);

    db.prepare(
      `INSERT INTO games (
        id, sport, game_id, home_team, away_team, game_time_utc, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'game-nhl-1p-actionable',
      'nhl',
      gameId,
      'Home Team',
      'Away Team',
      gameTimeUtc,
      'scheduled'
    );

    dbModule.insertCardPayload({
      id: 'card-nhl-1p-lean',
      gameId,
      sport: 'nhl',
      cardType: 'nhl-pace-1p',
      cardTitle: 'NHL 1P Total: LEAN_OVER @ 1.50',
      createdAt: now.toISOString(),
      payloadData: {
        game_id: gameId,
        sport: 'NHL',
        kind: 'PLAY',
        status: 'WATCH',
        decision_v2: { official_status: 'LEAN' },
        market_type: 'FIRST_PERIOD',
        period: '1P',
        recommended_bet_type: 'total',
        selection: { side: 'OVER' },
        line: 1.5,
        odds_context: {
          total_1p: 1.5,
          total_price_over_1p: -124,
          total_price_under_1p: 102,
        },
      },
      runId: 'run-nhl-1p-actionable',
    });

    dbModule.insertCardPayload({
      id: 'card-nhl-1p-pass',
      gameId,
      sport: 'nhl',
      cardType: 'nhl-pace-1p',
      cardTitle: 'NHL 1P Total: PASS @ 1.50',
      createdAt: new Date(now.getTime() + 1000).toISOString(),
      payloadData: {
        game_id: gameId,
        sport: 'NHL',
        kind: 'PLAY',
        status: 'PASS',
        decision_v2: { official_status: 'PASS' },
        market_type: 'FIRST_PERIOD',
        period: '1P',
        recommended_bet_type: 'total',
        selection: { side: 'OVER' },
        line: 1.5,
        odds_context: {
          total_1p: 1.5,
          total_price_over_1p: -124,
          total_price_under_1p: 102,
        },
      },
      runId: 'run-nhl-1p-actionable',
    });

    const leanResult = db
      .prepare(
        `SELECT market_key, market_type, selection, locked_price
         FROM card_results
         WHERE card_id = ?`
      )
      .get('card-nhl-1p-lean');
    expect(leanResult).toMatchObject({
      market_key: `${gameId}:TOTAL:1P:OVER:1.5`,
      market_type: 'TOTAL',
      selection: 'OVER',
      locked_price: -124,
    });

    const displayRows = db
      .prepare(
        `SELECT pick_id
         FROM card_display_log
         WHERE pick_id IN (?, ?)
         ORDER BY pick_id`
      )
      .all('card-nhl-1p-lean', 'card-nhl-1p-pass');
    expect(displayRows.map((row) => row.pick_id)).toEqual(['card-nhl-1p-lean']);
  });

  test('NHL moneyline enrolls for actionable PLAY/LEAN and excludes PASS', () => {
    const db = dbModule.getDatabase();
    const now = new Date();
    const gameTimeUtc = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const gameId = 'test-nhl-ml-actionable';
    ensureSettlementTables(db);

    db.prepare(
      `INSERT INTO games (
        id, sport, game_id, home_team, away_team, game_time_utc, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'game-nhl-ml-actionable',
      'nhl',
      gameId,
      'Home Team',
      'Away Team',
      gameTimeUtc,
      'scheduled'
    );

    dbModule.insertCardPayload({
      id: 'card-nhl-ml-lean',
      gameId,
      sport: 'nhl',
      cardType: 'nhl-moneyline-call',
      cardTitle: 'NHL ML: Away',
      createdAt: now.toISOString(),
      payloadData: {
        game_id: gameId,
        sport: 'NHL',
        kind: 'PLAY',
        status: 'WATCH',
        decision_v2: { official_status: 'LEAN' },
        market_type: 'MONEYLINE',
        selection: { side: 'AWAY' },
        odds_context: {
          h2h_home: -130,
          h2h_away: 115,
        },
      },
      runId: 'run-nhl-ml-actionable',
    });

    dbModule.insertCardPayload({
      id: 'card-nhl-ml-pass',
      gameId,
      sport: 'nhl',
      cardType: 'nhl-moneyline-call',
      cardTitle: 'NHL ML: Home',
      createdAt: new Date(now.getTime() + 1000).toISOString(),
      payloadData: {
        game_id: gameId,
        sport: 'NHL',
        kind: 'PLAY',
        status: 'PASS',
        decision_v2: { official_status: 'PASS' },
        market_type: 'MONEYLINE',
        selection: { side: 'HOME' },
        odds_context: {
          h2h_home: -130,
          h2h_away: 115,
        },
      },
      runId: 'run-nhl-ml-actionable',
    });

    const displayRows = db
      .prepare(
        `SELECT pick_id
         FROM card_display_log
         WHERE pick_id IN (?, ?)
         ORDER BY pick_id`
      )
      .all('card-nhl-ml-lean', 'card-nhl-ml-pass');
    expect(displayRows.map((row) => row.pick_id)).toEqual(['card-nhl-ml-lean']);
  });
});
