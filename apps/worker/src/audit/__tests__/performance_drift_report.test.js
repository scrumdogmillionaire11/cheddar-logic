const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'performance-drift-report-'));
}

function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup.
  }
}

function ensureAuditTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS card_payloads (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      sport TEXT NOT NULL,
      card_type TEXT NOT NULL,
      card_title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload_data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS card_results (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL UNIQUE,
      game_id TEXT NOT NULL,
      sport TEXT NOT NULL,
      card_type TEXT NOT NULL,
      recommended_bet_type TEXT NOT NULL,
      market_type TEXT,
      status TEXT NOT NULL,
      result TEXT,
      settled_at TEXT,
      pnl_units REAL
    );

    CREATE TABLE IF NOT EXISTS clv_ledger (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      clv_pct REAL,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS game_results (
      id TEXT PRIMARY KEY,
      game_id TEXT UNIQUE,
      sport TEXT,
      status TEXT,
      final_score_home INTEGER,
      final_score_away INTEGER,
      metadata TEXT
    );
  `);
}

function insertSeedRow(db, params = {}) {
  const id = params.id || `card-${Math.random().toString(16).slice(2)}`;
  const gameId = params.gameId || `${id}-game`;
  const settledAt = params.settledAt || '2026-04-02T12:00:00.000Z';
  const sport = params.sport || 'NBA';
  const cardType = params.cardType || 'nba-totals-call';
  const marketType = params.marketType || 'TOTAL';
  const lineSource = params.lineSource || 'odds_snapshot';
  const decisionBasis = params.decisionBasis || 'ODDS_BACKED';
  const modelVersion = params.modelVersion || 'nba-v1';
  const executionStatus = params.executionStatus || 'EXECUTABLE';
  const officialStatus = params.officialStatus || 'PLAY';
  const actionable =
    params.actionable !== undefined ? params.actionable : executionStatus === 'EXECUTABLE';
  const pFair = params.pFair !== undefined ? params.pFair : 0.55;
  const reasonCodes = params.reasonCodes || [];
  const primaryReasonCode =
    params.primaryReasonCode || (reasonCodes.length > 0 ? reasonCodes[0] : null);
  const payload = {
    actionable,
    card_type: cardType,
    decision_basis_meta: {
      decision_basis: decisionBasis,
      execution_eligible: decisionBasis === 'ODDS_BACKED',
      market_line_source:
        decisionBasis === 'ODDS_BACKED' ? 'odds_api' : 'projection_floor',
    },
    decision_v2: {
      official_status: officialStatus,
      primary_reason_code: primaryReasonCode,
    },
    execution_status: executionStatus,
    market_context: {
      market_type: marketType,
      wager: {
        line_source: lineSource,
      },
    },
    model_version: modelVersion,
    p_fair: pFair,
    reason_codes: reasonCodes,
    sport,
  };

  if (params.play) {
    payload.play = params.play;
  }

  if (params.payloadOverrides) {
    Object.assign(payload, params.payloadOverrides);
  }

  db.prepare(
    `
      INSERT INTO card_payloads (
        id, game_id, sport, card_type, card_title, created_at, payload_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    gameId,
    sport.toLowerCase(),
    cardType,
    `${cardType}-${id}`,
    settledAt,
    JSON.stringify(payload),
  );

  db.prepare(
    `
      INSERT INTO card_results (
        id, card_id, game_id, sport, card_type, recommended_bet_type,
        market_type, status, result, settled_at, pnl_units
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'settled', ?, ?, ?)
    `,
  ).run(
    `result-${id}`,
    id,
    gameId,
    sport.toLowerCase(),
    cardType,
    params.recommendedBetType || 'total',
    marketType,
    params.result || 'win',
    settledAt,
    params.pnlUnits !== undefined ? params.pnlUnits : 0.91,
  );

  db.prepare(
    `
      INSERT INTO game_results (
        id, game_id, sport, status, final_score_home, final_score_away, metadata
      ) VALUES (?, ?, ?, 'final', ?, ?, ?)
    `,
  ).run(
    `game-result-${gameId}`,
    gameId,
    sport.toLowerCase(),
    params.finalScoreHome !== undefined ? params.finalScoreHome : 3,
    params.finalScoreAway !== undefined ? params.finalScoreAway : 2,
    JSON.stringify(params.gameResultMetadata || {}),
  );

  if (params.clvPct !== undefined) {
    db.prepare(
      `
        INSERT INTO clv_ledger (id, card_id, clv_pct, closed_at)
        VALUES (?, ?, ?, ?)
      `,
    ).run(`clv-${id}`, id, params.clvPct, settledAt);
  }
}

describe('performance_drift_report', () => {
  let tempDir;
  let dbPath;
  let data;
  let reportModule;

  beforeEach(() => {
    tempDir = makeTempDir();
    dbPath = path.join(tempDir, 'cheddar.db');
    process.env.CHEDDAR_DB_PATH = dbPath;

    jest.resetModules();
    data = require('@cheddar-logic/data');
    reportModule = require('../performance_drift_report');

    const db = data.getDatabase();
    ensureAuditTables(db);
  });

  afterEach(() => {
    if (data) {
      data.closeDatabase();
    }
    removeIfExists(`${dbPath}.lock`);
    delete process.env.CHEDDAR_DB_PATH;
    jest.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('groups by card_family/card_mode/execution_status, keeps modes separate, and applies actionable guardrail', () => {
    const db = data.getDatabase();

    insertSeedRow(db, {
      id: 'nba-old-1',
      modelVersion: 'nba-v1',
      settledAt: '2026-03-01T00:00:00.000Z',
    });
    insertSeedRow(db, {
      id: 'nba-old-2',
      modelVersion: 'nba-v1',
      settledAt: '2026-03-02T00:00:00.000Z',
    });
    insertSeedRow(db, {
      id: 'nba-new-1',
      modelVersion: 'nba-v2',
      settledAt: '2026-04-02T00:00:00.000Z',
      actionable: true,
      result: 'win',
      pnlUnits: 1,
    });
    insertSeedRow(db, {
      id: 'nba-new-2',
      modelVersion: 'nba-v2',
      settledAt: '2026-04-01T00:00:00.000Z',
      actionable: false,
      result: 'loss',
      pnlUnits: -1,
    });
    insertSeedRow(db, {
      id: 'nba-proj-1',
      modelVersion: 'nba-v2',
      settledAt: '2026-03-31T00:00:00.000Z',
      actionable: false,
      decisionBasis: 'PROJECTION_ONLY',
      executionStatus: 'PROJECTION_ONLY',
      lineSource: 'projection_floor',
      pnlUnits: 0.5,
      result: 'win',
    });

    const report = reportModule.generatePerformanceDriftReport({
      db,
      sport: 'NBA',
    });

    const segments = report.windows.season_to_date.segments;
    const executableSegment = segments.find(
      (segment) =>
        segment.card_family === 'NBA_TOTAL' &&
        segment.card_mode === 'ODDS_BACKED' &&
        segment.execution_status === 'EXECUTABLE' &&
        segment.model_version === 'nba-v2',
    );
    const projectionSegment = segments.find(
      (segment) =>
        segment.card_family === 'NBA_TOTAL' &&
        segment.card_mode === 'PROJECTION_ONLY' &&
        segment.execution_status === 'PROJECTION_ONLY',
    );

    expect(executableSegment).toMatchObject({
      actionable_sample_count: 1,
      sample_count: 2,
      wins: 1,
      losses: 0,
      previous_model_version: 'nba-v1',
    });
    expect(executableSegment.projection_metrics).toBeUndefined();
    expect(projectionSegment).toMatchObject({
      actionable_sample_count: 0,
      projection_metrics: {
        actuals_available: false,
        sample_count: 0,
        rows_seen: 1,
      },
      sample_count: 1,
      card_mode: 'PROJECTION_ONLY',
      execution_status: 'PROJECTION_ONLY',
    });
  });

  test('emits calibration divergence with HIGH severity when adjacent sufficient p_fair buckets diverge', () => {
    const db = data.getDatabase();
    const baseTime = Date.parse('2026-04-02T12:00:00.000Z');

    for (let index = 0; index < 25; index += 1) {
      insertSeedRow(db, {
        id: `nhl-cal-a-${index}`,
        sport: 'NHL',
        cardType: 'nhl-totals-call',
        modelVersion: 'nhl-v1',
        pFair: 0.51,
        result: index < 5 ? 'win' : 'loss',
        pnlUnits: index < 5 ? 1 : -1,
        settledAt: new Date(baseTime - index * 60000).toISOString(),
      });
    }

    for (let index = 0; index < 25; index += 1) {
      insertSeedRow(db, {
        id: `nhl-cal-b-${index}`,
        sport: 'NHL',
        cardType: 'nhl-totals-call',
        modelVersion: 'nhl-v1',
        pFair: 0.53,
        result: index < 20 ? 'win' : 'loss',
        pnlUnits: index < 20 ? 1 : -1,
        settledAt: new Date(baseTime - (index + 25) * 60000).toISOString(),
      });
    }

    const report = reportModule.generatePerformanceDriftReport({
      db,
      sport: 'NHL',
    });

    const alert = report.alerts.find(
      (entry) =>
        entry.alert_type === 'CALIBRATION_DIVERGENCE' &&
        entry.sport === 'NHL' &&
        entry.window === 'last_50',
    );

    expect(alert).toMatchObject({
      severity: 'HIGH',
      threshold: 0.15,
      execution_status: 'EXECUTABLE',
    });
  });

  test('suppresses calibration alerts when an adjacent bucket is below the minimum sample', () => {
    const db = data.getDatabase();
    const baseTime = Date.parse('2026-04-02T12:00:00.000Z');

    for (let index = 0; index < 41; index += 1) {
      insertSeedRow(db, {
        id: `nhl-sparse-a-${index}`,
        sport: 'NHL',
        cardType: 'nhl-totals-call',
        pFair: 0.51,
        result: index < 8 ? 'win' : 'loss',
        pnlUnits: index < 8 ? 1 : -1,
        settledAt: new Date(baseTime - index * 60000).toISOString(),
      });
    }

    for (let index = 0; index < 9; index += 1) {
      insertSeedRow(db, {
        id: `nhl-sparse-b-${index}`,
        sport: 'NHL',
        cardType: 'nhl-totals-call',
        pFair: 0.53,
        result: 'win',
        pnlUnits: 1,
        settledAt: new Date(baseTime - (index + 41) * 60000).toISOString(),
      });
    }

    const report = reportModule.generatePerformanceDriftReport({
      db,
      sport: 'NHL',
    });

    const segment = report.windows.last_50.segments.find(
      (entry) => entry.card_family === 'NHL_TOTAL',
    );
    const sparseBucket = segment.calibration.buckets.find(
      (bucket) => bucket.label === '0.52-0.54',
    );

    expect(sparseBucket).toMatchObject({
      count: 9,
      sufficient_sample: false,
    });
    expect(
      report.alerts.some((entry) => entry.alert_type === 'CALIBRATION_DIVERGENCE'),
    ).toBe(false);
  });

  test('escalates sustained executable-rate and pass-rate alerts to CRITICAL across 50/100/200 windows', () => {
    const db = data.getDatabase();
    const baseTime = Date.parse('2026-04-02T12:00:00.000Z');

    for (let index = 0; index < 200; index += 1) {
      insertSeedRow(db, {
        id: `nba-critical-${index}`,
        sport: 'NBA',
        cardType: 'nba-totals-call',
        executionStatus: 'EXECUTABLE',
        officialStatus: 'PLAY',
        actionable: true,
        result: index % 3 === 0 ? 'loss' : 'win',
        pnlUnits: index % 3 === 0 ? -1 : 1,
        settledAt: new Date(baseTime - index * 60000).toISOString(),
      });
    }

    const report = reportModule.generatePerformanceDriftReport({
      db,
      sport: 'NBA',
    });

    const executableAlert = report.alerts.find(
      (entry) =>
        entry.alert_type === 'EXECUTABLE_RATE_SPIKE' &&
        entry.window === 'last_50',
    );
    const passAlert = report.alerts.find(
      (entry) =>
        entry.alert_type === 'PASS_RATE_COLLAPSE' &&
        entry.window === 'last_50',
    );
    const segment = report.windows.last_50.segments.find(
      (entry) =>
        entry.card_family === 'NBA_TOTAL' &&
        entry.execution_status === 'EXECUTABLE',
    );

    expect(executableAlert).toMatchObject({
      severity: 'CRITICAL',
      baseline_window: 'previous_50',
      value: 1,
    });
    expect(passAlert).toMatchObject({
      severity: 'CRITICAL',
      baseline_window: 'previous_50',
      value: 0,
    });
    expect(segment.clv_available).toBe(false);
    expect(report.alerts.some((entry) => entry.alert_type.includes('CLV'))).toBe(false);
  });

  test('adds projection_metrics for PROJECTION_ONLY segments and suppresses execution block-rate alerts', () => {
    const db = data.getDatabase();
    const baseTime = Date.parse('2026-04-02T12:00:00.000Z');

    for (let index = 0; index < 50; index += 1) {
      insertSeedRow(db, {
        id: `nhl-proj-${index}`,
        sport: 'NHL',
        cardType: 'nhl-player-shots',
        marketType: 'PROP',
        decisionBasis: 'PROJECTION_ONLY',
        executionStatus: 'PROJECTION_ONLY',
        actionable: false,
        lineSource: 'projection_floor',
        reasonCodes: index < 20 ? ['BLOCKED_MISSING_PRICING'] : [],
        settledAt: new Date(baseTime - index * 60000).toISOString(),
        play: {
          market_type: 'PROP',
          period: 'full_game',
          player_id: '97',
          player_name: 'Connor McDavid',
          prop_type: 'shots_on_goal',
          selection: {
            side: 'OVER',
          },
        },
        payloadOverrides: {
          decision: {
            model_projection: 4,
          },
        },
        gameResultMetadata: {
          playerShots: {
            fullGameByPlayerId: {
              97: 5,
            },
            firstPeriodByPlayerId: {},
            playerIdByNormalizedName: {
              'connor mcdavid': '97',
            },
          },
        },
      });
    }

    const report = reportModule.generatePerformanceDriftReport({
      db,
      sport: 'NHL',
    });

    const blockAlert = report.alerts.find(
      (entry) =>
        entry.alert_type === 'BLOCK_RATE_SHIFT' &&
        entry.card_mode === 'PROJECTION_ONLY',
    );
    const projectionAlert = report.alerts.find(
      (entry) =>
        entry.alert_type === 'PROJECTION_BIAS_BREACH' &&
        entry.window === 'season_to_date',
    );
    const segment = report.windows.season_to_date.segments.find(
      (entry) =>
        entry.card_family === 'NHL_PLAYER_SHOTS' &&
        entry.card_mode === 'PROJECTION_ONLY' &&
        entry.execution_status === 'PROJECTION_ONLY',
    );

    expect(blockAlert).toBeUndefined();
    expect(segment.projection_metrics).toMatchObject({
      actuals_available: true,
      bias: -1,
      directional_accuracy: 1,
      mae: 1,
      sample_count: 50,
      rows_seen: 50,
    });
    expect(projectionAlert).toMatchObject({
      card_family: 'NHL_PLAYER_SHOTS',
      card_mode: 'PROJECTION_ONLY',
      severity: 'CRITICAL',
      threshold: 0.6,
      value: -1,
      window: 'season_to_date',
    });
  });

  test('writes CLI JSON output', async () => {
    const db = data.getDatabase();
    const outputPath = path.join(tempDir, 'report.json');

    insertSeedRow(db, {
      id: 'cli-row',
      sport: 'NBA',
      settledAt: '2026-04-02T12:00:00.000Z',
    });

    let stdout = '';
    let stderr = '';
    const exitCode = await reportModule.runCli(
      ['--sport', 'NBA', '--output', outputPath],
      {
        stderr: { write(chunk) { stderr += chunk; } },
        stdout: { write(chunk) { stdout += chunk; } },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('"dimensions"');
    const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(written).toMatchObject({
      dimensions: [
        'sport',
        'card_family',
        'card_mode',
        'execution_status',
        'model_version',
      ],
    });
  });
});
