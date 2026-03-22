const fs = require('fs');
const {
  closeDatabase,
  getDatabase,
  runMigrations,
} = require('@cheddar-logic/data');
const {
  determineExitCode,
  formatTelemetryCalibrationReport,
  generateTelemetryCalibrationReport,
  parseArgs,
} = require('../report_telemetry_calibration');

const TEST_DB_PATH = '/tmp/cheddar-test-telemetry-calibration.db';
const LOCK_PATH = `${TEST_DB_PATH}.lock`;

function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup.
  }
}

function runInsert(db, sql, ...params) {
  db.prepare(sql).run(...params);
}

function ensureTelemetryTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_perf_ledger (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      sport TEXT,
      prop_type TEXT,
      player_name TEXT,
      pick_side TEXT,
      projection REAL,
      prop_line REAL,
      actual_result REAL,
      won INTEGER,
      confidence TEXT,
      volatility_band TEXT,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      settled_at TEXT,
      decision_basis TEXT NOT NULL DEFAULT 'PROJECTION_ONLY'
    );

    CREATE TABLE IF NOT EXISTS clv_ledger (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      sport TEXT,
      market_type TEXT,
      prop_type TEXT,
      selection TEXT,
      line REAL,
      odds_at_pick REAL,
      closing_odds REAL,
      clv_pct REAL,
      volatility_band TEXT,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT,
      decision_basis TEXT NOT NULL DEFAULT 'ODDS_BACKED'
    );

    CREATE TABLE IF NOT EXISTS odds_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT,
      sport TEXT,
      captured_at TEXT,
      raw_data TEXT
    );
  `);
}

function clearTelemetryTables(db) {
  db.exec(`
    DELETE FROM card_results;
    DELETE FROM card_payloads;
    DELETE FROM projection_perf_ledger;
    DELETE FROM clv_ledger;
    DELETE FROM odds_snapshots;
  `);
}

function seedBreachFixture(db) {
  const now = '2026-03-18T10:00:00.000Z';

  for (let index = 0; index < 60; index += 1) {
    const won = index < 24 ? 1 : 0;
    runInsert(
      db,
      `
      INSERT INTO projection_perf_ledger (
        id, card_id, game_id, sport, prop_type, pick_side, prop_line,
        actual_result, won, confidence, recorded_at, settled_at, decision_basis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      `proj-high-${index}`,
      `card-high-${index}`,
      `game-high-${index}`,
      'NHL',
      'PLAYER_SHOTS',
      'OVER',
      2.5,
      3.0,
      won,
      'HIGH',
      now,
      now,
      'PROJECTION_ONLY',
    );
  }

  for (let index = 0; index < 40; index += 1) {
    const won = index < 22 ? 1 : 0;
    runInsert(
      db,
      `
      INSERT INTO projection_perf_ledger (
        id, card_id, game_id, sport, prop_type, pick_side, prop_line,
        actual_result, won, confidence, recorded_at, settled_at, decision_basis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      `proj-medium-${index}`,
      `card-medium-${index}`,
      `game-medium-${index}`,
      'NHL',
      'PLAYER_SHOTS',
      'OVER',
      2.5,
      2.0,
      won,
      'MEDIUM',
      now,
      now,
      'PROJECTION_ONLY',
    );
  }

  for (let index = 0; index < 150; index += 1) {
    const clv = index < 45 ? -0.06 : -0.015;
    runInsert(
      db,
      `
      INSERT INTO clv_ledger (
        id, card_id, game_id, sport, market_type, clv_pct,
        recorded_at, closed_at, decision_basis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      `clv-${index}`,
      `card-clv-${index}`,
      `game-clv-${index}`,
      'NHL',
      'MONEYLINE',
      clv,
      now,
      now,
      'ODDS_BACKED',
    );
  }
}

function seedInsufficientFixture(db) {
  const now = '2026-03-18T10:00:00.000Z';

  for (let index = 0; index < 20; index += 1) {
    runInsert(
      db,
      `
      INSERT INTO projection_perf_ledger (
        id, card_id, game_id, sport, prop_type, won, confidence,
        recorded_at, settled_at, decision_basis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      `proj-small-${index}`,
      `card-proj-small-${index}`,
      `game-proj-small-${index}`,
      'NBA',
      'POINTS',
      index % 2,
      index % 3 === 0 ? 'HIGH' : 'MEDIUM',
      now,
      now,
      'PROJECTION_ONLY',
    );
  }

  for (let index = 0; index < 6; index += 1) {
    runInsert(
      db,
      `
      INSERT INTO projection_perf_ledger (
        id, card_id, game_id, sport, prop_type, won, confidence,
        recorded_at, settled_at, decision_basis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      `proj-open-${index}`,
      `card-proj-open-${index}`,
      `game-proj-open-${index}`,
      'NBA',
      'ASSISTS',
      null,
      'MEDIUM',
      now,
      null,
      'PROJECTION_ONLY',
    );
  }

  for (let index = 0; index < 30; index += 1) {
    runInsert(
      db,
      `
      INSERT INTO clv_ledger (
        id, card_id, game_id, sport, market_type, clv_pct,
        recorded_at, closed_at, decision_basis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      `clv-small-${index}`,
      `card-clv-small-${index}`,
      `game-clv-small-${index}`,
      'NBA',
      'SPREAD',
      -0.004,
      now,
      now,
      'ODDS_BACKED',
    );
  }

  for (let index = 0; index < 8; index += 1) {
    runInsert(
      db,
      `
      INSERT INTO clv_ledger (
        id, card_id, game_id, sport, market_type, clv_pct,
        recorded_at, closed_at, decision_basis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      `clv-open-${index}`,
      `card-clv-open-${index}`,
      `game-clv-open-${index}`,
      'NBA',
      'MONEYLINE',
      null,
      now,
      null,
      'ODDS_BACKED',
    );
  }

  for (let index = 0; index < 2; index += 1) {
    runInsert(
      db,
      `
      INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      `g-odds-${index}`,
      'nba',
      `odds-game-${index}`,
      'Home Team',
      'Away Team',
      now,
      'scheduled',
    );

    runInsert(
      db,
      `
      INSERT INTO odds_snapshots (game_id, sport, captured_at, raw_data)
      VALUES (?, ?, ?, ?)
    `,
      `odds-game-${index}`,
      'NBA',
      now,
      JSON.stringify({ source: 'test' }),
    );
  }
}

function insertSettledNhlMoneylineCard(db, {
  id,
  gameId,
  side,
  marginHome,
  result,
  timestamp,
}) {
  runInsert(
    db,
    `
    INSERT OR IGNORE INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    `g-${gameId}`,
    'nhl',
    gameId,
    `Home ${gameId}`,
    `Away ${gameId}`,
    timestamp,
    'final',
  );

  const payloadData = {
    sport: 'NHL',
    prediction: side,
    selection: { side },
    projection: {
      margin_home: marginHome,
      win_prob_home: null,
    },
    market_context: {
      projection: {
        margin_home: marginHome,
      },
    },
  };

  runInsert(
    db,
    `
    INSERT INTO card_payloads (
      id, game_id, sport, card_type, card_title, created_at, payload_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    id,
    gameId,
    'nhl',
    'nhl-moneyline-call',
    `NHL ML ${id}`,
    timestamp,
    JSON.stringify(payloadData),
  );

  runInsert(
    db,
    `
    INSERT INTO card_results (
      id, card_id, game_id, sport, card_type, recommended_bet_type,
      market_key, market_type, selection, line, locked_price,
      status, result, settled_at, pnl_units, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    `result-${id}`,
    id,
    gameId,
    'nhl',
    'nhl-moneyline-call',
    'moneyline',
    `nhl|moneyline|${gameId}|${side}`,
    'MONEYLINE',
    side,
    null,
    -110,
    'settled',
    result,
    timestamp,
    result === 'win' ? 0.91 : -1.0,
    JSON.stringify({ source: 'test-fixture' }),
  );
}

function seedNhlMoneylineCalibrationFixture(db, scenario = 'justified') {
  const now = '2026-03-18T10:00:00.000Z';

  if (scenario === 'justified') {
    for (let index = 0; index < 10; index += 1) {
      insertSettledNhlMoneylineCard(db, {
        id: `nhl-ml-j-home-${index}`,
        gameId: `nhl-ml-j-home-game-${index}`,
        side: 'HOME',
        marginHome: 2.0,
        result: 'win',
        timestamp: now,
      });
      insertSettledNhlMoneylineCard(db, {
        id: `nhl-ml-j-away-${index}`,
        gameId: `nhl-ml-j-away-game-${index}`,
        side: 'AWAY',
        marginHome: -2.0,
        result: 'win',
        timestamp: now,
      });
    }
    return;
  }

  for (let index = 0; index < 10; index += 1) {
    insertSettledNhlMoneylineCard(db, {
      id: `nhl-ml-nj-home-${index}`,
      gameId: `nhl-ml-nj-home-game-${index}`,
      side: 'HOME',
      marginHome: 2.0,
      result: 'loss',
      timestamp: now,
    });
    insertSettledNhlMoneylineCard(db, {
      id: `nhl-ml-nj-away-${index}`,
      gameId: `nhl-ml-nj-away-game-${index}`,
      side: 'AWAY',
      marginHome: -2.0,
      result: 'loss',
      timestamp: now,
    });
  }
}

describe('telemetry calibration report', () => {
  beforeAll(async () => {
    process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS = 'false';

    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);

    await runMigrations();
    const db = getDatabase();
    ensureTelemetryTables(db);
  });

  afterAll(() => {
    closeDatabase();
    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);
  });

  test('computes all four thresholds and fails enforcement when breached', async () => {
    const db = getDatabase();
    clearTelemetryTables(db);
    seedBreachFixture(db);

    const report = await generateTelemetryCalibrationReport({ db, days: 14 });
    expect(report.overallStatus).toBe('NO_GO');
    expect(report.ledgers.projection.sampleSize).toBe(100);
    expect(report.ledgers.clv.sampleSize).toBe(150);
    expect(report.ledgers.projection.checks.winRateFloor.status).toBe('FAIL');
    expect(report.ledgers.projection.checks.confidenceDrift.status).toBe('FAIL');
    expect(report.ledgers.clv.checks.meanClv.status).toBe('FAIL');
    expect(report.ledgers.clv.checks.tailRisk.status).toBe('FAIL');
    expect(determineExitCode(report, true)).toBe(1);

    const text = formatTelemetryCalibrationReport(report, { enforce: true });
    expect(text).toContain('projection_perf_ledger');
    expect(text).toContain('clv_ledger');
    expect(text).toContain('nhl_moneyline_calibration');
    expect(text).toContain('Overall status: NO_GO');
  });

  test('emits NHL ML calibration schema and JUSTIFIED verdict when selected mapping outperforms baseline', async () => {
    const db = getDatabase();
    clearTelemetryTables(db);
    seedNhlMoneylineCalibrationFixture(db, 'justified');

    const report = await generateTelemetryCalibrationReport({ db, days: 180 });
    expect(report).toHaveProperty('nhlMoneylineCalibration');
    expect(report.nhlMoneylineCalibration).toMatchObject({
      status: 'OK',
      selectionRule: 'selected_improves_both_brier_and_log_loss',
      verdict: 'JUSTIFIED',
      sampleWindow: {
        days: 180,
        anchorField: 'settled_at',
      },
    });
    expect(report.nhlMoneylineCalibration.sampleSize).toBe(20);
    expect(report.nhlMoneylineCalibration.mappings.baseline.mappingKey).toBe('legacy_sigma_12');
    expect(report.nhlMoneylineCalibration.mappings.baseline.sigmaMargin).toBe(12);
    expect(report.nhlMoneylineCalibration.mappings.selected.mappingKey).toBe('nhl_sigma_default');
    expect(report.nhlMoneylineCalibration.mappings.selected.sigmaMargin).toBe(2);
    expect(report.nhlMoneylineCalibration.mappings.baseline.reliabilityBins).toHaveLength(5);
    expect(report.nhlMoneylineCalibration.mappings.selected.reliabilityBins).toHaveLength(5);
    expect(report.nhlMoneylineCalibration.deltas.brierSelectedMinusBaseline).toBeLessThan(0);
    expect(report.nhlMoneylineCalibration.deltas.logLossSelectedMinusBaseline).toBeLessThan(0);

    const text = formatTelemetryCalibrationReport(report, { enforce: true });
    expect(text).toContain('nhl_moneyline_calibration');
    expect(text).toContain('verdict: JUSTIFIED');
  });

  test('marks NHL ML calibration as NOT_JUSTIFIED when selected mapping does not improve both metrics', async () => {
    const db = getDatabase();
    clearTelemetryTables(db);
    seedNhlMoneylineCalibrationFixture(db, 'not_justified');

    const report = await generateTelemetryCalibrationReport({ db, days: 180 });
    expect(report.nhlMoneylineCalibration.status).toBe('OK');
    expect(report.nhlMoneylineCalibration.verdict).toBe('NOT_JUSTIFIED');
    expect(report.nhlMoneylineCalibration.deltas.brierSelectedMinusBaseline).toBeGreaterThan(0);
    expect(report.nhlMoneylineCalibration.deltas.logLossSelectedMinusBaseline).toBeGreaterThan(0);

    const text = formatTelemetryCalibrationReport(report, { enforce: true });
    expect(text).toContain('verdict: NOT_JUSTIFIED');
  });

  test('returns insufficient-data status with learning diagnostics and zero enforce exit', async () => {
    const db = getDatabase();
    clearTelemetryTables(db);
    seedInsufficientFixture(db);

    const report = await generateTelemetryCalibrationReport({ db, days: 14 });
    expect(report.overallStatus).toBe('INSUFFICIENT_DATA');
    expect(report.ledgers.projection.sampleGateMet).toBe(false);
    expect(report.ledgers.clv.sampleGateMet).toBe(false);
    expect(report.diagnostics.projectionUnresolvedTopBuckets.length).toBeGreaterThan(0);
    expect(report.diagnostics.clvUnresolvedTopBuckets.length).toBeGreaterThan(0);
    expect(report.diagnostics.recommendations.length).toBeGreaterThan(0);
    expect(report.nhlMoneylineCalibration.status).toBe('INSUFFICIENT_DATA');
    expect(report.nhlMoneylineCalibration.verdict).toBe('INSUFFICIENT_DATA');
    expect(report.nhlMoneylineCalibration.sampleSize).toBe(0);
    expect(report.nhlMoneylineCalibration.mappings.baseline.reliabilityBins).toHaveLength(5);
    expect(report.nhlMoneylineCalibration.mappings.selected.reliabilityBins).toHaveLength(5);
    expect(determineExitCode(report, true)).toBe(0);

    const text = formatTelemetryCalibrationReport(report, { enforce: true });
    expect(text).toContain('learning_diagnostics');
    expect(text).toContain('recommendations');
    expect(text).toContain('nhl_moneyline_calibration');
    expect(text).toContain('verdict: INSUFFICIENT_DATA');
    expect(text).toContain('INSUFFICIENT_DATA');
  });

  test('parses CLI flags deterministically', () => {
    expect(parseArgs(['--json', '--enforce', '--days=7'])).toMatchObject({
      json: true,
      enforce: true,
      days: 7,
    });

    expect(parseArgs(['--days', 'abc'])).toMatchObject({
      days: 14,
      enforce: false,
    });
  });
});
