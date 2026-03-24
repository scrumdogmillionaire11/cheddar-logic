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
  confidencePct = 63.5,
  edgePct = 0.01,
  edgeDeltaPct,
  supportScore = 50,
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
      edge_pct: edgePct,
      edge_delta_pct: edgeDeltaPct,
      support_score: supportScore,
    },
    confidence_pct: confidencePct,
  };
}

function seedSettledPerformanceRows(
  db,
  { sport, marketType, wins, losses, prefix },
) {
  const gameId = `${prefix}-perf-game`;
  const now = Date.now();
  db.prepare(
    `
    INSERT OR IGNORE INTO games (
      id, sport, game_id, home_team, away_team, game_time_utc, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    `${gameId}-id`,
    String(sport).toLowerCase(),
    gameId,
    'Perf Home',
    'Perf Away',
    new Date(now + 60 * 60 * 1000).toISOString(),
    'scheduled',
  );

  const totalRows = wins + losses;
  for (let i = 0; i < totalRows; i += 1) {
    const isWin = i < wins;
    const settledAt = new Date(now - (i + 1) * 60 * 60 * 1000).toISOString();
    const cardId = `${prefix}-perf-card-${i}`;
    const resultId = `${prefix}-perf-result-${i}`;
    const isMoneyline = String(marketType).toUpperCase() === 'MONEYLINE';
    const isSpread = String(marketType).toUpperCase() === 'SPREAD';
    const selection = isMoneyline || isSpread ? 'HOME' : 'OVER';
    const line = isMoneyline ? null : 1.5;
    const recommendedBetType = isMoneyline
      ? 'moneyline'
      : isSpread
        ? 'spread'
        : 'total';

    db.prepare(
      `
      INSERT INTO card_payloads (
        id, game_id, sport, card_type, card_title, created_at, payload_data, run_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      cardId,
      gameId,
      String(sport).toLowerCase(),
      'perf-card',
      'Performance seed',
      settledAt,
      JSON.stringify({
        game_id: gameId,
        sport,
        kind: 'EVIDENCE',
        market_type: marketType,
        selection: { side: selection },
        line,
        price: -110,
      }),
      `${prefix}-perf-run`,
    );

    db.prepare(
      `
      INSERT INTO card_results (
        id,
        card_id,
        game_id,
        sport,
        card_type,
        recommended_bet_type,
        market_key,
        market_type,
        selection,
        line,
        locked_price,
        status,
        result,
        settled_at,
        pnl_units,
        metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?, ?, ?, '{}')
    `,
    ).run(
      resultId,
      cardId,
      gameId,
      String(sport).toUpperCase(),
      'perf-card',
      recommendedBetType,
      `${gameId}:${marketType}:${selection}:${line ?? 'NA'}`,
      String(marketType).toUpperCase(),
      selection,
      line,
      -110,
      isWin ? 'win' : 'loss',
      settledAt,
      isWin ? 0.909 : -1,
    );
  }
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

  test('enforces one row per run_id + game_id across mixed markets/sides', () => {
    const db = dbModule.getDatabase();
    ensureCoreTables(db);
    const now = new Date().toISOString();
    const gameId = 'game-one-true-play-1';

    db.prepare(
      `
      INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('g-2', 'nba', gameId, 'Home', 'Away', now, 'scheduled');

    dbModule.insertCardPayload({
      id: 'card-spread-play',
      gameId,
      sport: 'nba',
      cardType: 'nba-test-play',
      cardTitle: 'Spread Play',
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
        price: -110,
        confidencePct: 61,
        edgePct: 0.07,
        supportScore: 74,
      }),
      runId: 'run-b',
    });

    dbModule.insertCardPayload({
      id: 'card-moneyline-play',
      gameId,
      sport: 'nba',
      cardType: 'nba-test-play',
      cardTitle: 'Moneyline Play',
      createdAt: now,
      payloadData: buildPlayPayload({
        gameId,
        sport: 'NBA',
        homeTeam: 'Home',
        awayTeam: 'Away',
        officialStatus: 'PLAY',
        marketType: 'MONEYLINE',
        selection: 'AWAY',
        line: undefined,
        price: 110,
        confidencePct: 67,
        edgePct: 0.01,
        supportScore: 20,
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
    expect(row.pick_id).toBe('card-moneyline-play');
    expect(row.line).toBeNull();
    expect(row.odds).toBe(110);
    expect(row.run_id).toBe('run-b');
    expect(String(row.market_type).toUpperCase()).toBe('MONEYLINE');
    expect(String(row.selection).toUpperCase()).toBe('AWAY');

    const totalRows = db
      .prepare(`SELECT COUNT(*) AS count FROM card_display_log WHERE game_id = ?`)
      .get(gameId);
    expect(totalRows.count).toBe(1);
  });

  test('ranks by confidence x 30-day market performance before edge/support', () => {
    const db = dbModule.getDatabase();
    ensureCoreTables(db);
    const now = new Date().toISOString();
    const gameId = 'game-rank-perf-1';

    db.prepare(
      `
      INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('g-rank-1', 'nba', gameId, 'Home', 'Away', now, 'scheduled');

    seedSettledPerformanceRows(db, {
      sport: 'NBA',
      marketType: 'SPREAD',
      wins: 20,
      losses: 5,
      prefix: 'spread-high-perf',
    });
    seedSettledPerformanceRows(db, {
      sport: 'NBA',
      marketType: 'MONEYLINE',
      wins: 10,
      losses: 15,
      prefix: 'moneyline-low-perf',
    });

    dbModule.insertCardPayload({
      id: 'card-spread-perf',
      gameId,
      sport: 'nba',
      cardType: 'nba-test-play',
      cardTitle: 'Spread higher weighted confidence',
      createdAt: now,
      payloadData: buildPlayPayload({
        gameId,
        sport: 'NBA',
        homeTeam: 'Home',
        awayTeam: 'Away',
        officialStatus: 'PLAY',
        marketType: 'SPREAD',
        selection: 'HOME',
        line: -3.5,
        price: -110,
        confidencePct: 60,
        edgePct: 0.02,
        supportScore: 40,
      }),
      runId: 'run-perf-rank',
    });

    dbModule.insertCardPayload({
      id: 'card-moneyline-perf',
      gameId,
      sport: 'nba',
      cardType: 'nba-test-play',
      cardTitle: 'Moneyline lower weighted confidence',
      createdAt: now,
      payloadData: buildPlayPayload({
        gameId,
        sport: 'NBA',
        homeTeam: 'Home',
        awayTeam: 'Away',
        officialStatus: 'PLAY',
        marketType: 'MONEYLINE',
        selection: 'AWAY',
        line: undefined,
        price: 115,
        confidencePct: 70,
        edgePct: 0.15,
        supportScore: 95,
      }),
      runId: 'run-perf-rank',
    });

    const row = db
      .prepare(
        `
        SELECT pick_id, market_type, selection
        FROM card_display_log
        WHERE game_id = ? AND run_id = ?
      `,
      )
      .get(gameId, 'run-perf-rank');

    expect(row).toBeDefined();
    expect(row.pick_id).toBe('card-spread-perf');
    expect(String(row.market_type).toUpperCase()).toBe('SPREAD');
    expect(String(row.selection).toUpperCase()).toBe('HOME');
  });

  test('falls back to decision_v2.edge_delta_pct when ranking display-log candidates', () => {
    const db = dbModule.getDatabase();
    ensureCoreTables(db);
    const now = new Date().toISOString();
    const gameId = 'game-edge-delta-pct-rank-1';

    db.prepare(
      `
      INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('g-edge-delta-1', 'nhl', gameId, 'Home', 'Away', now, 'scheduled');

    dbModule.insertCardPayload({
      id: 'card-edge-delta-low',
      gameId,
      sport: 'nhl',
      cardType: 'nhl-test-play',
      cardTitle: 'Lower edge delta',
      createdAt: now,
      payloadData: buildPlayPayload({
        gameId,
        sport: 'NHL',
        homeTeam: 'Home',
        awayTeam: 'Away',
        officialStatus: 'PLAY',
        marketType: 'TOTAL',
        selection: 'OVER',
        line: 5.5,
        price: -110,
        confidencePct: 65,
        edgePct: null,
        edgeDeltaPct: 0.04,
        supportScore: 60,
      }),
      runId: 'run-edge-delta-rank',
    });

    dbModule.insertCardPayload({
      id: 'card-edge-delta-high',
      gameId,
      sport: 'nhl',
      cardType: 'nhl-test-play',
      cardTitle: 'Higher edge delta',
      createdAt: now,
      payloadData: buildPlayPayload({
        gameId,
        sport: 'NHL',
        homeTeam: 'Home',
        awayTeam: 'Away',
        officialStatus: 'PLAY',
        marketType: 'TOTAL',
        selection: 'UNDER',
        line: 5.5,
        price: -110,
        confidencePct: 65,
        edgePct: null,
        edgeDeltaPct: 0.09,
        supportScore: 60,
      }),
      runId: 'run-edge-delta-rank',
    });

    const row = db
      .prepare(
        `
        SELECT pick_id, selection
        FROM card_display_log
        WHERE game_id = ? AND run_id = ?
      `,
      )
      .get(gameId, 'run-edge-delta-rank');

    expect(row).toBeDefined();
    expect(row.pick_id).toBe('card-edge-delta-high');
    expect(String(row.selection).toUpperCase()).toBe('UNDER');
  });
});
