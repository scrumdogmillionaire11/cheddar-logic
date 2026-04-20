const fs = require('fs');
const {
  closeDatabase,
  getDatabase,
  runMigrations,
} = require('@cheddar-logic/data');
const {
  buildNhl1pWalkForwardReport,
  determineExitCode,
  evaluateNhl1pShadowGate,
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
    PRAGMA foreign_keys = OFF;
    DELETE FROM card_results;
    DELETE FROM card_payloads;
    DELETE FROM game_results;
    DELETE FROM games;
    DELETE FROM clv_ledger;
    DELETE FROM odds_snapshots;
    PRAGMA foreign_keys = ON;
  `);
}

function seedBreachFixture(db) {
  const now = new Date().toISOString();

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
  const now = new Date().toISOString();

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
  const now = new Date().toISOString();

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

function insertSettledDecisionTierCard(db, {
  id,
  gameId,
  sport,
  marketType,
  result,
  pnlUnits,
  officialStatus,
  timestamp,
}) {
  runInsert(
    db,
    `
    INSERT OR IGNORE INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    `g-${gameId}`,
    sport.toLowerCase(),
    gameId,
    `Home ${gameId}`,
    `Away ${gameId}`,
    timestamp,
    'final',
  );

  runInsert(
    db,
    `
    INSERT INTO card_payloads (
      id, game_id, sport, card_type, card_title, created_at, payload_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    id,
    gameId,
    sport.toLowerCase(),
    `${sport.toLowerCase()}-${marketType.toLowerCase()}-call`,
    `${sport} ${marketType} ${id}`,
    timestamp,
    JSON.stringify({
      sport,
      market_type: marketType,
      decision_v2: {
        official_status: officialStatus,
      },
    }),
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
    sport.toLowerCase(),
    `${sport.toLowerCase()}-${marketType.toLowerCase()}-call`,
    marketType.toLowerCase(),
    `${sport}|${marketType}|${gameId}`,
    marketType,
    'HOME',
    null,
    -110,
    'settled',
    result,
    timestamp,
    pnlUnits,
    JSON.stringify({ source: 'decision-tier-fixture' }),
  );
}

function seedDecisionTierAuditFixture(db) {
  const now = new Date().toISOString();

  insertSettledDecisionTierCard(db, {
    id: 'tier-play-win',
    gameId: 'tier-play-win-game',
    sport: 'NBA',
    marketType: 'TOTAL',
    result: 'win',
    pnlUnits: 0.91,
    officialStatus: 'PLAY',
    timestamp: now,
  });
  insertSettledDecisionTierCard(db, {
    id: 'tier-play-loss',
    gameId: 'tier-play-loss-game',
    sport: 'NHL',
    marketType: 'MONEYLINE',
    result: 'loss',
    pnlUnits: -1.0,
    officialStatus: 'PLAY',
    timestamp: now,
  });
  insertSettledDecisionTierCard(db, {
    id: 'tier-lean-win',
    gameId: 'tier-lean-win-game',
    sport: 'NHL',
    marketType: 'SPREAD',
    result: 'win',
    pnlUnits: 0.91,
    officialStatus: 'LEAN',
    timestamp: now,
  });
  insertSettledDecisionTierCard(db, {
    id: 'tier-lean-push',
    gameId: 'tier-lean-push-game',
    sport: 'NBA',
    marketType: 'TEAM_TOTAL',
    result: 'push',
    pnlUnits: 0,
    officialStatus: 'LEAN',
    timestamp: now,
  });
  insertSettledDecisionTierCard(db, {
    id: 'tier-ncaam-ignored',
    gameId: 'tier-ncaam-ignored-game',
    sport: 'NCAAM',
    marketType: 'TOTAL',
    result: 'win',
    pnlUnits: 0.91,
    officialStatus: 'PLAY',
    timestamp: now,
  });
}

function insertSettledNhlShotsBreakoutCard(db, {
  id,
  gameId,
  result,
  pnlUnits,
  breakoutFlags = [],
  clvPct = null,
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
    'nhl-player-shots',
    `NHL SOG ${id}`,
    timestamp,
    JSON.stringify({
      sport: 'NHL',
      breakout: {
        flags: breakoutFlags,
        score: breakoutFlags.includes('BREAKOUT_CANDIDATE') ? 4 : 1,
        eligible: breakoutFlags.includes('BREAKOUT_CANDIDATE'),
      },
      play: {
        prop_type: 'shots_on_goal',
        period: 'full_game',
        selection: {
          side: 'over',
          line: 2.5,
        },
      },
    }),
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
    'nhl-player-shots',
    'prop',
    `nhl|prop|${gameId}|over`,
    'PROP',
    'OVER',
    2.5,
    -110,
    'settled',
    result,
    timestamp,
    pnlUnits,
    JSON.stringify({ source: 'breakout-fixture' }),
  );

  if (clvPct !== null) {
    runInsert(
      db,
      `
      INSERT INTO clv_ledger (
        id, card_id, game_id, sport, market_type, prop_type, selection, line,
        odds_at_pick, closing_odds, clv_pct, recorded_at, closed_at, decision_basis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      `clv-${id}`,
      id,
      gameId,
      'NHL',
      'PROP',
      'shots_on_goal',
      'OVER',
      2.5,
      -110,
      -105,
      clvPct,
      timestamp,
      timestamp,
      'ODDS_BACKED',
    );
  }
}

function seedNhlShotsBreakoutFixture(db) {
  const now = new Date().toISOString();

  insertSettledNhlShotsBreakoutCard(db, {
    id: 'breakout-win',
    gameId: 'breakout-win-game',
    result: 'win',
    pnlUnits: 0.91,
    breakoutFlags: ['BREAKOUT_CANDIDATE', 'TOI_TREND_UP'],
    clvPct: 0.03,
    timestamp: now,
  });
  insertSettledNhlShotsBreakoutCard(db, {
    id: 'breakout-loss',
    gameId: 'breakout-loss-game',
    result: 'loss',
    pnlUnits: -1.0,
    breakoutFlags: ['BREAKOUT_CANDIDATE', 'ENV_BOOST'],
    clvPct: -0.01,
    timestamp: now,
  });
  insertSettledNhlShotsBreakoutCard(db, {
    id: 'non-breakout-win',
    gameId: 'non-breakout-win-game',
    result: 'win',
    pnlUnits: 0.91,
    breakoutFlags: ['TOI_TREND_UP'],
    clvPct: 0.01,
    timestamp: now,
  });
  insertSettledNhlShotsBreakoutCard(db, {
    id: 'non-breakout-push',
    gameId: 'non-breakout-push-game',
    result: 'push',
    pnlUnits: 0,
    breakoutFlags: [],
    clvPct: null,
    timestamp: now,
  });
}

function insertSettledNhl1pProjectionCard(db, {
  id,
  gameId,
  projection,
  direction,
  firstPeriodHome,
  firstPeriodAway,
  timestamp,
}) {
  runInsert(
    db,
    `
    INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
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

  runInsert(
    db,
    `
    INSERT INTO game_results (
      id, game_id, sport, final_score_home, final_score_away,
      status, result_source, settled_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    `gr-${gameId}`,
    gameId,
    'nhl',
    firstPeriodHome + 1,
    firstPeriodAway + 2,
    'final',
    'manual',
    timestamp,
    JSON.stringify({
      firstPeriodScores: {
        home: firstPeriodHome,
        away: firstPeriodAway,
      },
      firstPeriodVerification: {
        isComplete: true,
      },
    }),
  );

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
    'nhl-pace-1p',
    `NHL 1P ${id}`,
    timestamp,
    JSON.stringify({
      sport: 'NHL',
      numeric_projection: projection,
      recommended_direction: direction,
      play: {
        period: '1P',
        decision_v2: {
          official_status: 'PLAY',
          direction,
        },
        selection: {
          side: direction,
        },
      },
      first_period_model: {
        projection_final: projection,
      },
    }),
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
    'nhl-pace-1p',
    'total',
    `nhl|1p|${gameId}|${direction}`,
    'TOTAL',
    direction,
    projection,
    null,
    'pending',
    null,
    timestamp,
    null,
    JSON.stringify({ source: 'nhl-1p-baseline-fixture' }),
  );
}

function seedNhl1pBaselineFixture(db) {
  const now = new Date().toISOString();
  const rows = [
    {
      id: 'nhl-1p-low-over-win',
      projection: 1.4,
      direction: 'OVER',
      firstPeriodHome: 1,
      firstPeriodAway: 1,
    },
    {
      id: 'nhl-1p-mid-under-win',
      projection: 1.5,
      direction: 'UNDER',
      firstPeriodHome: 0,
      firstPeriodAway: 1,
    },
    {
      id: 'nhl-1p-high-over-loss',
      projection: 2.19,
      direction: 'OVER',
      firstPeriodHome: 1,
      firstPeriodAway: 0,
    },
    {
      id: 'nhl-1p-top-under-loss',
      projection: 2.2,
      direction: 'UNDER',
      firstPeriodHome: 2,
      firstPeriodAway: 1,
    },
  ];

  rows.forEach((row, index) => {
    insertSettledNhl1pProjectionCard(db, {
      ...row,
      gameId: `${row.id}-game`,
      timestamp: new Date(Date.parse(now) + index).toISOString(),
    });
  });
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

  test('computes CLV thresholds and fails enforcement when breached', async () => {
    const db = getDatabase();
    clearTelemetryTables(db);
    seedBreachFixture(db);

    const report = await generateTelemetryCalibrationReport({ db, days: 14 });
    expect(report.overallStatus).toBe('NO_GO');
    expect(report.ledgers.clv.sampleSize).toBe(150);
    expect(report.ledgers.clv.checks.meanClv.status).toBe('FAIL');
    expect(report.ledgers.clv.checks.tailRisk.status).toBe('FAIL');
    expect(determineExitCode(report, true)).toBe(1);

    const text = formatTelemetryCalibrationReport(report, { enforce: true });
    expect(text).not.toContain('projection_perf_ledger');
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

  test('includes targeted PLAY vs LEAN tier audit in windowed and all-time output', async () => {
    const db = getDatabase();
    clearTelemetryTables(db);
    seedDecisionTierAuditFixture(db);

    const report = await generateTelemetryCalibrationReport({ db, days: 14 });

    // Top-level structure: windows array (4 entries) + allTime array
    expect(report.decisionTierAudit.windows).toHaveLength(4);
    expect(report.decisionTierAudit.windows.map((w) => w.days)).toEqual([14, 30, 60, 90]);
    expect(Array.isArray(report.decisionTierAudit.allTime)).toBe(true);

    // All 4 valid fixture cards are recent (timestamp=now), so they appear in every window
    const w14 = report.decisionTierAudit.windows.find((w) => w.days === 14);
    expect(w14.rows).toHaveLength(4);

    // Verify specific rows in allTime
    const nbaTotal = report.decisionTierAudit.allTime.find(
      (r) => r.sport === 'NBA' && r.market_type === 'TOTAL' && r.tier === 'PLAY',
    );
    expect(nbaTotal).toMatchObject({ n: 1, win_rate: 1, total_pnl: 0.91 });

    const nhlMoneyline = report.decisionTierAudit.allTime.find(
      (r) => r.sport === 'NHL' && r.market_type === 'MONEYLINE' && r.tier === 'PLAY',
    );
    expect(nhlMoneyline).toMatchObject({ n: 1, win_rate: 0, total_pnl: -1 });

    // NCAAM card must be excluded from all rows
    expect(report.decisionTierAudit.allTime.find((r) => r.sport === 'NCAAM')).toBeUndefined();

    const text = formatTelemetryCalibrationReport(report, { enforce: true });
    expect(text).toContain('decision_tier_audit');
    expect(text).toContain('--- 14-day window ---');
    expect(text).toContain('--- All-time ---');
    expect(text).toContain('NBA/TOTAL/PLAY');
    expect(text).toContain('NHL/MONEYLINE/PLAY');
  });

  test('rolling window returns only cards settled within each window boundary', async () => {
    const db = getDatabase();
    clearTelemetryTables(db);

    const daysAgo = (n) =>
      new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    const recent = daysAgo(10); // within 14-day window
    const older = daysAgo(45);  // within 60-day/90-day but NOT 14-day or 30-day

    for (let i = 0; i < 5; i++) {
      insertSettledDecisionTierCard(db, {
        id: `rolling-recent-${i}`,
        gameId: `rolling-recent-game-${i}`,
        sport: 'NBA',
        marketType: 'TOTAL',
        result: 'win',
        pnlUnits: 0.91,
        officialStatus: 'PLAY',
        timestamp: recent,
      });
    }
    for (let i = 0; i < 5; i++) {
      insertSettledDecisionTierCard(db, {
        id: `rolling-older-${i}`,
        gameId: `rolling-older-game-${i}`,
        sport: 'NBA',
        marketType: 'TOTAL',
        result: 'loss',
        pnlUnits: -1.0,
        officialStatus: 'PLAY',
        timestamp: older,
      });
    }

    const report = await generateTelemetryCalibrationReport({ db });
    const { windows, allTime } = report.decisionTierAudit;
    const totalN = (rows) => rows.reduce((sum, r) => sum + r.n, 0);

    const w14 = windows.find((w) => w.days === 14);
    const w30 = windows.find((w) => w.days === 30);
    const w60 = windows.find((w) => w.days === 60);
    const w90 = windows.find((w) => w.days === 90);

    expect(totalN(w14.rows)).toBe(5);   // only recent (10d ago)
    expect(totalN(w30.rows)).toBe(5);   // only recent (45d-old not in 30d window)
    expect(totalN(w60.rows)).toBe(10);  // recent + older
    expect(totalN(w90.rows)).toBe(10);  // recent + older
    expect(totalN(allTime)).toBe(10);   // all cards

    // monotonically non-decreasing: 14d ≤ 30d ≤ 60d ≤ 90d ≤ all-time
    expect(totalN(w14.rows)).toBeLessThanOrEqual(totalN(w30.rows));
    expect(totalN(w30.rows)).toBeLessThanOrEqual(totalN(w60.rows));
    expect(totalN(w60.rows)).toBeLessThanOrEqual(totalN(w90.rows));
    expect(totalN(w90.rows)).toBeLessThanOrEqual(totalN(allTime));
  });

  test('reports breakout-tagged vs non-breakout NHL shots calibration buckets', async () => {
    const db = getDatabase();
    clearTelemetryTables(db);
    seedNhlShotsBreakoutFixture(db);

    const report = await generateTelemetryCalibrationReport({ db, days: 14 });
    expect(report.nhlShotsBreakoutCalibration).toMatchObject({
      status: 'OK',
      scope: {
        sport: 'NHL',
        propType: 'shots_on_goal',
        period: 'full_game',
        side: 'OVER',
      },
      sampleWindow: {
        days: 14,
        anchorField: 'settled_at',
      },
    });

    expect(report.nhlShotsBreakoutCalibration.buckets.breakoutTagged).toMatchObject({
      sampleSize: 2,
      wins: 1,
      losses: 1,
      pushes: 0,
      hitRate: 0.5,
      totalPnlUnits: -0.09,
      roi: -0.045,
      clvSampleSize: 2,
      meanClv: 0.01,
      p25Clv: -0.01,
    });
    expect(report.nhlShotsBreakoutCalibration.buckets.nonBreakoutTagged).toMatchObject({
      sampleSize: 2,
      wins: 1,
      losses: 0,
      pushes: 1,
      hitRate: 1,
      totalPnlUnits: 0.91,
      roi: 0.455,
      clvSampleSize: 1,
      meanClv: 0.01,
      p25Clv: 0.01,
    });

    const text = formatTelemetryCalibrationReport(report, { enforce: true });
    expect(text).toContain('nhl_shots_breakout_calibration');
    expect(text).toContain('breakout_tagged | 1W-1L-0P (2)');
    expect(text).toContain('non_breakout_tagged | 1W-0L-1P (2)');
  });

  test('reports locked NHL 1P baseline buckets with side-specific directional records', async () => {
    const db = getDatabase();
    clearTelemetryTables(db);

    const emptyReport = await generateTelemetryCalibrationReport({ db, days: 14 });
    expect(emptyReport.nhl1pBaselineScorecard.status).toBe('INSUFFICIENT_DATA');
    expect(emptyReport.nhl1pBaselineScorecard.buckets).toEqual(
      ['1.0-1.4', '1.5-1.9', '2.0-2.19', '2.20+'].map((label) =>
        expect.objectContaining({
          bucketRangeLabel: label,
          sampleSize: 0,
          rowsSeen: 0,
          overWins: 0,
          underLosses: 0,
        }),
      ),
    );

    seedNhl1pBaselineFixture(db);

    const report = await generateTelemetryCalibrationReport({ db, days: 14 });
    expect(report.nhl1pBaselineScorecard).toMatchObject({
      status: 'OK',
      sampleSize: 4,
      directionalWins: 2,
      directionalLosses: 2,
      directionalAccuracy: 0.5,
      sampleScope: {
        sport: 'NHL',
        cardFamily: 'NHL_1P_TOTAL',
        source: 'all_final_game_results',
        buckets: ['1.0-1.4', '1.5-1.9', '2.0-2.19', '2.20+'],
      },
    });

    expect(
      report.nhl1pBaselineScorecard.buckets.map((bucket) => ({
        label: bucket.bucketRangeLabel,
        sampleSize: bucket.sampleSize,
        record: `${bucket.directionalWins}-${bucket.directionalLosses}`,
        over: `${bucket.overWins}-${bucket.overLosses}`,
        under: `${bucket.underWins}-${bucket.underLosses}`,
      })),
    ).toEqual([
      { label: '1.0-1.4', sampleSize: 1, record: '1-0', over: '1-0', under: '0-0' },
      { label: '1.5-1.9', sampleSize: 1, record: '1-0', over: '0-0', under: '1-0' },
      { label: '2.0-2.19', sampleSize: 1, record: '0-1', over: '0-1', under: '0-0' },
      { label: '2.20+', sampleSize: 1, record: '0-1', over: '0-0', under: '0-1' },
    ]);

    const text = formatTelemetryCalibrationReport(report, { enforce: true });
    expect(text).toContain('nhl_1p_baseline_scorecard');
    expect(text).toContain('1.0-1.4 | sample 1');
    expect(text).toContain('2.20+ | sample 1');
  });

  test('returns insufficient-data status with learning diagnostics and zero enforce exit', async () => {
    const db = getDatabase();
    clearTelemetryTables(db);
    seedInsufficientFixture(db);

    const report = await generateTelemetryCalibrationReport({ db, days: 14 });
    expect(report.overallStatus).toBe('INSUFFICIENT_DATA');
    expect(report.ledgers.clv.sampleGateMet).toBe(false);
    expect(report.diagnostics.clvUnresolvedTopBuckets.length).toBeGreaterThan(0);
    expect(report.diagnostics.clvUnresolvedTopBuckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sport: 'NBA',
          marketType: 'MONEYLINE',
          unresolvedCount: 8,
        }),
      ]),
    );
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

  test('walk-forward report groups NHL 1P cards into 14-day windows with bucket/side metrics', () => {
    const db = getDatabase();
    clearTelemetryTables(db);

    const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

    // Seed 10 cards per window across 3 non-overlapping windows (~42d ago, ~28d ago, ~14d ago)
    // Each window's cards have timestamps within a 1-hour spread inside the window
    const windowAnchors = [40, 26, 12]; // days ago; each is well within a 14-day window
    windowAnchors.forEach((anchor, winIdx) => {
      for (let i = 0; i < 10; i += 1) {
        const ts = new Date(Date.parse(daysAgo(anchor)) + i * 60 * 1000).toISOString();
        // All OVER with projection=2.1 (2.0-2.19 bucket); actual=3 (OVER win)
        insertSettledNhl1pProjectionCard(db, {
          id: `wf-basic-w${winIdx}-c${i}`,
          gameId: `wf-basic-w${winIdx}-g${i}`,
          projection: 2.1,
          direction: 'OVER',
          firstPeriodHome: 2,
          firstPeriodAway: 1,
          timestamp: ts,
        });
      }
    });

    const report = buildNhl1pWalkForwardReport(db);

    expect(report.status).toBe('OK');
    expect(report.windowDays).toBe(14);
    expect(report.eligibleWindowCount).toBeGreaterThanOrEqual(3);
    expect(report.windows.length).toBeGreaterThanOrEqual(3);

    // Every eligible window must have sampleSize >= 10
    for (const win of report.windows.filter((w) => w.eligible)) {
      expect(win.sampleSize).toBeGreaterThanOrEqual(10);
    }

    // Aggregated 2.0-2.19 bucket: all 30 cards are OVER wins → hit rate = 1.0
    const agg219 = report.aggregatedBuckets.find((b) => b.bucketRangeLabel === '2.0-2.19');
    expect(agg219.overWins).toBe(30);
    expect(agg219.overLosses).toBe(0);
    expect(agg219.overHitRate).toBe(1);
    expect(agg219.thinSample).toBe(false);
  });

  test('shadow gate returns PROMOTE when walk-forward OVER hit-rate meets baseline in both gate buckets', () => {
    // Build mock walk-forward and baseline objects directly — no DB needed
    const mockWalkForward = {
      status: 'OK',
      eligibleWindowCount: 3,
      aggregatedBuckets: [
        { bucketRangeLabel: '1.0-1.4', overWins: 5, overLosses: 5, overHitRate: 0.5, thinSample: false },
        { bucketRangeLabel: '1.5-1.9', overWins: 5, overLosses: 5, overHitRate: 0.5, thinSample: false },
        { bucketRangeLabel: '2.0-2.19', overWins: 8, overLosses: 2, overHitRate: 0.8, thinSample: false },
        { bucketRangeLabel: '2.20+', overWins: 9, overLosses: 1, overHitRate: 0.9, thinSample: false },
      ],
    };
    const mockBaseline = {
      buckets: [
        { bucketRangeLabel: '1.0-1.4', overWins: 3, overLosses: 7 },
        { bucketRangeLabel: '1.5-1.9', overWins: 4, overLosses: 6 },
        { bucketRangeLabel: '2.0-2.19', overWins: 6, overLosses: 4 }, // baseline = 0.6
        { bucketRangeLabel: '2.20+', overWins: 7, overLosses: 3 },    // baseline = 0.7
      ],
    };

    const gate = evaluateNhl1pShadowGate(mockWalkForward, mockBaseline);

    expect(gate.verdict).toBe('PROMOTE');
    expect(gate.eligibleWindowCount).toBe(3);
    expect(gate.promoteGateBuckets).toHaveLength(2);
    expect(gate.promoteGateBuckets.find((b) => b.bucketRangeLabel === '2.0-2.19').meetsTarget).toBe(true);
    expect(gate.promoteGateBuckets.find((b) => b.bucketRangeLabel === '2.20+').meetsTarget).toBe(true);
  });

  test('shadow gate returns HOLD when walk-forward OVER hit-rate fails baseline in a gate bucket', () => {
    const mockWalkForward = {
      status: 'OK',
      eligibleWindowCount: 3,
      aggregatedBuckets: [
        { bucketRangeLabel: '1.0-1.4', overWins: 5, overLosses: 5, overHitRate: 0.5, thinSample: false },
        { bucketRangeLabel: '1.5-1.9', overWins: 5, overLosses: 5, overHitRate: 0.5, thinSample: false },
        { bucketRangeLabel: '2.0-2.19', overWins: 4, overLosses: 6, overHitRate: 0.4, thinSample: false }, // 0.4 < baseline 0.6 → FAIL
        { bucketRangeLabel: '2.20+', overWins: 9, overLosses: 1, overHitRate: 0.9, thinSample: false },
      ],
    };
    const mockBaseline = {
      buckets: [
        { bucketRangeLabel: '1.0-1.4', overWins: 3, overLosses: 7 },
        { bucketRangeLabel: '1.5-1.9', overWins: 4, overLosses: 6 },
        { bucketRangeLabel: '2.0-2.19', overWins: 6, overLosses: 4 }, // baseline = 0.6
        { bucketRangeLabel: '2.20+', overWins: 7, overLosses: 3 },    // baseline = 0.7
      ],
    };

    const gate = evaluateNhl1pShadowGate(mockWalkForward, mockBaseline);

    expect(gate.verdict).toBe('HOLD');
    expect(gate.promoteGateBuckets.find((b) => b.bucketRangeLabel === '2.0-2.19').meetsTarget).toBe(false);
    expect(gate.promoteGateBuckets.find((b) => b.bucketRangeLabel === '2.20+').meetsTarget).toBe(true);
    expect(gate.rationale).toContain('2.0-2.19');
  });

  test('shadow gate returns INSUFFICIENT_DATA when fewer than 3 eligible windows', () => {
    const mockWalkForward = {
      status: 'OK',
      eligibleWindowCount: 2, // only 2 eligible windows — not enough
      aggregatedBuckets: [
        { bucketRangeLabel: '2.0-2.19', overWins: 8, overLosses: 2, overHitRate: 0.8, thinSample: false },
        { bucketRangeLabel: '2.20+', overWins: 9, overLosses: 1, overHitRate: 0.9, thinSample: false },
      ],
    };
    const mockBaseline = { buckets: [] };

    const gate = evaluateNhl1pShadowGate(mockWalkForward, mockBaseline);

    expect(gate.verdict).toBe('INSUFFICIENT_DATA');
    expect(gate.eligibleWindowCount).toBe(2);
    expect(gate.promoteGateBuckets).toBeNull();
  });

  test('shadow gate flags thin-sample buckets but does not block PROMOTE', () => {
    const mockWalkForward = {
      status: 'OK',
      eligibleWindowCount: 3,
      aggregatedBuckets: [
        { bucketRangeLabel: '1.0-1.4', overWins: 2, overLosses: 2, overHitRate: 0.5, thinSample: true },
        { bucketRangeLabel: '1.5-1.9', overWins: 2, overLosses: 2, overHitRate: 0.5, thinSample: true },
        { bucketRangeLabel: '2.0-2.19', overWins: 8, overLosses: 2, overHitRate: 0.8, thinSample: false },
        { bucketRangeLabel: '2.20+', overWins: 2, overLosses: 1, overHitRate: 0.67, thinSample: true }, // thin — flagged, not blocking
      ],
    };
    const mockBaseline = {
      buckets: [
        { bucketRangeLabel: '2.0-2.19', overWins: 6, overLosses: 4 }, // baseline = 0.6
        { bucketRangeLabel: '2.20+', overWins: 7, overLosses: 3 },    // baseline = 0.7 (thin, not checked)
      ],
    };

    const gate = evaluateNhl1pShadowGate(mockWalkForward, mockBaseline);

    expect(gate.verdict).toBe('PROMOTE');
    expect(gate.promoteGateBuckets.find((b) => b.bucketRangeLabel === '2.20+').thinSample).toBe(true);
    expect(gate.rationale).toContain('2.20+'); // flagged in rationale
  });

  test('generateTelemetryCalibrationReport includes nhl1pWalkForward and nhl1pShadowGate', async () => {
    const db = getDatabase();
    clearTelemetryTables(db);
    // No NHL 1P data → both should be INSUFFICIENT_DATA

    const report = await generateTelemetryCalibrationReport({ db, days: 14 });

    expect(report).toHaveProperty('nhl1pWalkForward');
    expect(report).toHaveProperty('nhl1pShadowGate');
    expect(report.nhl1pWalkForward.status).toBe('INSUFFICIENT_DATA');
    expect(report.nhl1pShadowGate.verdict).toBe('INSUFFICIENT_DATA');
    expect(report.nhl1pShadowGate.promoteGateBuckets).toBeNull();

    const text = formatTelemetryCalibrationReport(report, { enforce: false });
    expect(text).toContain('nhl_1p_walk_forward');
    expect(text).toContain('nhl_1p_shadow_gate');
    expect(text).toContain('verdict: INSUFFICIENT_DATA');
  });
});
