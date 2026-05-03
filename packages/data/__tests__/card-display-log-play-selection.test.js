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
      first_seen_price INTEGER,
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
  });

  afterEach(() => {
    if (dbModule) dbModule.closeDatabase();
    resetEnv();
    jest.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('logs only PLAY/Slight Edge rows (not Pass and not EVIDENCE kind)', () => {
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
      id: 'card-play',
      gameId,
      sport: 'nba',
      cardType: 'nba-test-play',
      cardTitle: 'Play card',
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
        price: 118,
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
        `SELECT pick_id, market_type, selection, line, odds FROM card_display_log ORDER BY pick_id`,
      )
      .all();

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.pick_id)).toEqual(['card-lean', 'card-play']);
    expect(rows[0]).toMatchObject({
      pick_id: 'card-lean',
      market_type: 'SPREAD',
      selection: 'HOME',
      line: -2.5,
      odds: -108,
    });
    expect(rows[1]).toMatchObject({
      pick_id: 'card-play',
      market_type: 'MONEYLINE',
      selection: 'AWAY',
      line: null,
      odds: 118,
    });
  });

  test('uses strict legacy status fallback only when official_status is absent', () => {
    const db = dbModule.getDatabase();
    ensureCoreTables(db);
    const now = new Date().toISOString();
    const cases = [
      { suffix: 'play', status: 'PLAY', expected: true },
      { suffix: 'fire', status: 'FIRE', expected: true },
      { suffix: 'lean', status: 'LEAN', expected: true },
      { suffix: 'watch', status: 'WATCH', expected: false },
      { suffix: 'hold', status: 'HOLD', expected: false },
      { suffix: 'pass', status: 'PASS', expected: false },
      { suffix: 'unknown', status: 'MONITOR', expected: false },
      { suffix: 'missing', status: undefined, expected: false },
    ];

    for (const testCase of cases) {
      const gameId = `game-legacy-${testCase.suffix}`;
      db.prepare(
        `
        INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        `g-legacy-${testCase.suffix}`,
        'mlb',
        gameId,
        'Home',
        'Away',
        now,
        'scheduled',
      );

      const payloadData = buildPlayPayload({
        gameId,
        sport: 'MLB',
        homeTeam: 'Home',
        awayTeam: 'Away',
        officialStatus: undefined,
        marketType: 'TOTAL',
        selection: 'OVER',
        line: 8.5,
        price: -110,
      });
      delete payloadData.decision_v2.official_status;
      if (testCase.status === undefined) {
        delete payloadData.status;
        delete payloadData.action;
      } else {
        payloadData.status = testCase.status;
        payloadData.action = testCase.status;
      }

      dbModule.insertCardPayload({
        id: `card-legacy-${testCase.suffix}`,
        gameId,
        sport: 'mlb',
        cardType: 'mlb-full-game',
        cardTitle: `Legacy ${testCase.status || 'missing'}`,
        createdAt: now,
        payloadData,
        runId: `run-legacy-${testCase.suffix}`,
      });
    }

    const rows = db
      .prepare(
        `
        SELECT pick_id
        FROM card_display_log
        WHERE pick_id LIKE 'card-legacy-%'
        ORDER BY pick_id
      `,
      )
      .all();

    expect(rows.map((row) => row.pick_id)).toEqual([
      'card-legacy-fire',
      'card-legacy-lean',
      'card-legacy-play',
    ]);
  });

  test('enrolls every eligible row across mixed markets and sides in the same run', () => {
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

    const rows = db
      .prepare(
        `
        SELECT pick_id, line, odds, run_id, game_id, market_type, selection
        FROM card_display_log
        WHERE game_id = ?
        ORDER BY pick_id
        `,
      )
      .all(gameId);

    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      {
        pick_id: 'card-moneyline-play',
        line: null,
        odds: 110,
        run_id: 'run-b',
        game_id: gameId,
        market_type: 'MONEYLINE',
        selection: 'AWAY',
      },
      {
        pick_id: 'card-spread-play',
        line: -4.5,
        odds: -110,
        run_id: 'run-b',
        game_id: gameId,
        market_type: 'SPREAD',
        selection: 'HOME',
      },
    ]);
  });
});
