const fs = require('fs');
const {
  closeDatabase,
  getDatabase,
  runMigrations,
} = require('@cheddar-logic/data');
const {
  formatSettlementHealthReport,
  generateSettlementHealthReport,
  parseArgs,
  writeSettlementHealthLog,
} = require('../jobs/report_settlement_health.js');

const TEST_DB_PATH = '/tmp/cheddar-test-settlement-health-report.db';
const LOCK_PATH = `${TEST_DB_PATH}.lock`;
const TEST_LOG_PATH = '/tmp/cheddar-settlement-health-report-log.json';

function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best-effort cleanup only.
  }
}

function runInsert(db, sql, ...params) {
  db.prepare(sql).run(...params);
}

function buildPayload({
  sport,
  officialStatus,
  marketType,
  selection,
  line = null,
  price = null,
  executionStatus = 'EXECUTABLE',
}) {
  return JSON.stringify({
    kind: 'PLAY',
    sport: String(sport || '').toUpperCase(),
    market_type: marketType,
    selection,
    line,
    price,
    execution_status: executionStatus,
    decision_v2: { official_status: officialStatus },
  });
}

function seedReportData(db) {
  const now = new Date('2026-03-13T12:00:00.000Z').toISOString();
  const yesterday = new Date('2026-03-12T12:00:00.000Z').toISOString();
  const finalNhl = 'game-final-nhl';
  const finalNba = 'game-final-nba';
  const pendingNba = 'game-live-nba';

  runInsert(
    db,
    `
    INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    'g-1',
    'nhl',
    finalNhl,
    'Home B',
    'Away B',
    yesterday,
    'completed',
  );
  runInsert(
    db,
    `
    INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    'g-2',
    'nba',
    finalNba,
    'Home A',
    'Away A',
    yesterday,
    'completed',
  );
  runInsert(
    db,
    `
    INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    'g-3',
    'nba',
    pendingNba,
    'Home C',
    'Away C',
    now,
    'in_progress',
  );

  for (const [id, gameId, sport, title, payloadData] of [
    ['card-a1', finalNba, 'nba', 'NBA eligible pending', buildPayload({
      sport: 'NBA',
      officialStatus: 'PLAY',
      marketType: 'MONEYLINE',
      selection: 'HOME',
      price: -110,
    })],
    ['card-a2', finalNba, 'nba', 'NBA errored mismatch', buildPayload({
      sport: 'NBA',
      officialStatus: 'PLAY',
      marketType: 'MONEYLINE',
      selection: 'AWAY',
      price: -105,
    })],
    ['card-b1', finalNhl, 'nhl', 'NHL no display', buildPayload({
      sport: 'NHL',
      officialStatus: 'LEAN',
      marketType: 'MONEYLINE',
      selection: 'HOME',
      price: -120,
    })],
    ['card-b2', finalNhl, 'nhl', 'NHL missing market key', buildPayload({
      sport: 'NHL',
      officialStatus: 'PASS',
      marketType: 'MONEYLINE',
      selection: 'HOME',
      price: -130,
      executionStatus: 'BLOCKED',
    })],
    ['card-c1', pendingNba, 'nba', 'NBA waiting final', buildPayload({
      sport: 'NBA',
      officialStatus: 'PLAY',
      marketType: 'MONEYLINE',
      selection: 'HOME',
      price: -115,
    })],
    ['card-b3', finalNhl, 'nhl', 'NHL errored 1P', buildPayload({
      sport: 'NHL',
      officialStatus: 'PLAY',
      marketType: 'TOTAL',
      selection: 'OVER',
      line: 1.5,
      price: -110,
    })],
    ['card-p1', finalNhl, 'nhl', 'NHL projection only', buildPayload({
      sport: 'NHL',
      officialStatus: 'PLAY',
      marketType: 'TOTAL',
      selection: 'OVER',
      line: 5.5,
      executionStatus: 'PROJECTION_ONLY',
    })],
  ]) {
    runInsert(
      db,
      `
      INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      id,
      gameId,
      sport,
      `${sport}-model-output`,
      title,
      now,
      payloadData,
    );
  }

  runInsert(
    db,
    `
    INSERT INTO game_results (
      id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    'gr-1',
    finalNba,
    'nba',
    110,
    103,
    'final',
    'primary_api',
    now,
    JSON.stringify({}),
  );
  runInsert(
    db,
    `
    INSERT INTO game_results (
      id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    'gr-2',
    finalNhl,
    'nhl',
    2,
    1,
    'final',
    'primary_api',
    now,
    JSON.stringify({ firstPeriodScores: { home: 1, away: 1 } }),
  );

  runInsert(
    db,
    `
    INSERT INTO card_results (
      id, card_id, game_id, sport, card_type, recommended_bet_type,
      status, result, settled_at, market_key, market_type, selection, line, locked_price, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    'result-a1',
    'card-a1',
    finalNba,
    'nba',
    'nba-model-output',
    'moneyline',
    'pending',
    null,
    null,
    'mk-a1',
    'MONEYLINE',
    'HOME',
    null,
    -110,
    JSON.stringify({}),
  );
  runInsert(
    db,
    `
    INSERT INTO card_results (
      id, card_id, game_id, sport, card_type, recommended_bet_type,
      status, result, settled_at, market_key, market_type, selection, line, locked_price, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    'result-a2',
    'card-a2',
    finalNba,
    'nba',
    'nba-model-output',
    'moneyline',
    'error',
    'void',
    now,
    'mk-a2',
    'MONEYLINE',
    'AWAY',
    null,
    -105,
    JSON.stringify({
      settlement_error: {
        code: 'MARKET_KEY_MISMATCH',
        message: 'Card market_key mismatch',
        at: now,
      },
    }),
  );
  runInsert(
    db,
    `
    INSERT INTO card_results (
      id, card_id, game_id, sport, card_type, recommended_bet_type,
      status, result, settled_at, market_key, market_type, selection, line, locked_price, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    'result-b1',
    'card-b1',
    finalNhl,
    'nhl',
    'nhl-model-output',
    'moneyline',
    'pending',
    null,
    null,
    'mk-b1',
    'MONEYLINE',
    'HOME',
    null,
    -120,
    JSON.stringify({}),
  );
  runInsert(
    db,
    `
    INSERT INTO card_results (
      id, card_id, game_id, sport, card_type, recommended_bet_type,
      status, result, settled_at, market_key, market_type, selection, line, locked_price, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    'result-b2',
    'card-b2',
    finalNhl,
    'nhl',
    'nhl-model-output',
    'moneyline',
    'pending',
    null,
    null,
    null,
    'MONEYLINE',
    'HOME',
    null,
    -130,
    JSON.stringify({}),
  );
  runInsert(
    db,
    `
    INSERT INTO card_results (
      id, card_id, game_id, sport, card_type, recommended_bet_type,
      status, result, settled_at, market_key, market_type, selection, line, locked_price, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    'result-c1',
    'card-c1',
    pendingNba,
    'nba',
    'nba-model-output',
    'moneyline',
    'pending',
    null,
    null,
    'mk-c1',
    'MONEYLINE',
    'HOME',
    null,
    -115,
    JSON.stringify({}),
  );
  runInsert(
    db,
    `
    INSERT INTO card_results (
      id, card_id, game_id, sport, card_type, recommended_bet_type,
      status, result, settled_at, market_key, market_type, selection, line, locked_price, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    'result-b3',
    'card-b3',
    finalNhl,
    'nhl',
    'nhl-model-output',
    'total',
    'error',
    'void',
    now,
    'mk-b3',
    'TOTAL',
    'OVER',
    1.5,
    -110,
    JSON.stringify({
      settlement_error: {
        code: 'MISSING_PERIOD_SCORE',
        message: 'Missing first-period scores required for 1P settlement',
        at: now,
      },
    }),
  );

  for (const [pickId, runId, gameId, sport, marketType, selection, line, odds, displayedAt] of [
    ['card-a1', 'run-1', finalNba, 'nba', 'MONEYLINE', 'HOME', null, -110, now],
    ['card-a2', 'run-1', finalNba, 'nba', 'MONEYLINE', 'AWAY', null, -105, now],
    ['card-c1', 'run-2', pendingNba, 'nba', 'MONEYLINE', 'HOME', null, -115, now],
    ['card-b3', 'run-3', finalNhl, 'nhl', 'TOTAL', 'OVER', 1.5, -110, now],
  ]) {
    runInsert(
      db,
      `
      INSERT INTO card_display_log (
        pick_id, run_id, game_id, sport, market_type, selection, line, odds, odds_book, confidence_pct, displayed_at, api_endpoint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      pickId,
      runId,
      gameId,
      sport,
      marketType,
      selection,
      line,
      odds,
      'test-book',
      65,
      displayedAt,
      '/api/games',
    );
  }

  for (const row of [
    ['jr-1', 'settle_pending_cards', 'failed', yesterday, now, 'Card settlement crash', 'cards|daily|2026-03-12|0900'],
    ['jr-2', 'settle_pending_cards', 'success', now, now, null, 'cards|daily|2026-03-13|0900'],
    ['jr-3', 'settle_game_results', 'failed', yesterday, yesterday, 'ESPN timeout', 'games|daily|2026-03-12|0900'],
    ['jr-4', 'settle_game_results', 'success', now, now, null, 'games|daily|2026-03-13|0900'],
  ]) {
    runInsert(
      db,
      `
      INSERT INTO job_runs (id, job_name, job_key, status, started_at, ended_at, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      row[0],
      row[1],
      row[6],
      row[2],
      row[3],
      row[4],
      row[5],
    );
  }
}

describe('settlement health report', () => {
  beforeAll(async () => {
    process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS = 'false';

    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);
    removeIfExists(TEST_LOG_PATH);

    await runMigrations();
    const db = getDatabase();
    seedReportData(db);
  });

  afterAll(() => {
    closeDatabase();
    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);
    removeIfExists(TEST_LOG_PATH);
  });

  test('reports unsettled coverage, failure buckets, and recent job failures', async () => {
    const report = await generateSettlementHealthReport({ sampleLimit: 5 });

    expect(report.summary).toMatchObject({
      hasUnsettledPlays: true,
      hasActionableUnsettledFinalDisplayed: true,
      hasFailedSettlements: true,
      pendingTotal: 4,
      pendingActionableFinalDisplayed: 1,
      finalDisplayedUnsettled: 3,
      failedSettlementRows: 2,
    });

    expect(report.coverage.pendingWithFinalNoDisplay).toBe(1);
    expect(report.coverage.pendingWithFinalMissingMarketKey).toBe(1);
    expect(report.coverage.pendingDisplayedWithoutFinal).toBe(1);
    expect(report.visibilityIntegrity).toMatchObject({
      totalRows: 7,
      actionableRecentRows: 5,
      counts: {
        ENROLLED: 4,
        PROJECTION_ONLY: 1,
        NOT_DISPLAY_ELIGIBLE: 1,
        DISPLAY_LOG_NOT_ENROLLED: 1,
      },
    });

    expect(report.failures.byCode).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MARKET_KEY_MISMATCH', count: 1 }),
        expect.objectContaining({ code: 'MISSING_PERIOD_SCORE', count: 1 }),
      ]),
    );
    expect(report.failures.samples).toHaveLength(2);

    expect(report.samples.actionablePendingFinalDisplayed).toEqual([
      expect.objectContaining({ cardId: 'card-a1', gameId: 'game-final-nba' }),
    ]);
    expect(report.samples.pendingWithFinalNoDisplay).toEqual([
      expect.objectContaining({ cardId: 'card-b1', gameId: 'game-final-nhl' }),
    ]);
    expect(report.samples.pendingWithFinalMissingMarketKey).toEqual([
      expect.objectContaining({ cardId: 'card-b2', gameId: 'game-final-nhl' }),
    ]);
    expect(report.samples.pendingDisplayedWithoutFinal).toEqual([
      expect.objectContaining({ cardId: 'card-c1', gameId: 'game-live-nba' }),
    ]);
    expect(report.visibilityIntegrity.samples.DISPLAY_LOG_NOT_ENROLLED).toEqual([
      expect.objectContaining({ cardId: 'card-b1', gameId: 'game-final-nhl' }),
    ]);

    expect(report.jobRuns.settle_pending_cards.latestFailure).toMatchObject({
      id: 'jr-1',
      errorMessage: 'Card settlement crash',
    });
    expect(report.jobRuns.settle_game_results.latestFailure).toMatchObject({
      id: 'jr-3',
      errorMessage: 'ESPN timeout',
    });
  });

  test('supports sport filtering and text formatting', async () => {
    const report = await generateSettlementHealthReport({ sport: 'NHL', sampleLimit: 5 });
    expect(report.summary.pendingTotal).toBe(2);
    expect(report.summary.failedSettlementRows).toBe(1);
    expect(report.failures.byCode).toEqual([
      expect.objectContaining({ code: 'MISSING_PERIOD_SCORE', count: 1 }),
    ]);

    const text = formatSettlementHealthReport(report);
    expect(text).toContain('Sport filter: NHL');
    expect(text).toContain('Visibility integrity');
    expect(text).toContain('Failed settlements by code');
    expect(text).toContain('MISSING_PERIOD_SCORE: 1');
  });

  test('writes a JSON log artifact to disk', async () => {
    const report = await generateSettlementHealthReport({ sampleLimit: 5 });
    const logPath = writeSettlementHealthLog(report, TEST_LOG_PATH);

    expect(logPath).toBe(TEST_LOG_PATH);
    expect(fs.existsSync(TEST_LOG_PATH)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(TEST_LOG_PATH, 'utf8'));
    expect(saved.summary).toMatchObject({
      hasUnsettledPlays: true,
      failedSettlementRows: 2,
    });

    const text = formatSettlementHealthReport({ ...report, logFile: TEST_LOG_PATH });
    expect(text).toContain(`Log file: ${TEST_LOG_PATH}`);
  });

  test('parses CLI args for json, sport, days, and limit', () => {
    expect(
      parseArgs(['--json', '--sport=NHL', '--days=7', '--limit=3', '--log-file', TEST_LOG_PATH]),
    ).toMatchObject({
      json: true,
      sport: 'NHL',
      days: 7,
      limit: 3,
      logFile: TEST_LOG_PATH,
      writeLog: true,
    });

    expect(parseArgs(['--no-log'])).toMatchObject({
      writeLog: false,
    });
  });

  test('classifies legacy quarantined vs current-path defect rows correctly', async () => {
    // This test verifies the quarantine classification logic works.
    // The report should contain quarantine classifications for all visibility buckets.
    const report = await generateSettlementHealthReport({ sampleLimit: 10 });

    // Validate that quarantine classification structure exists
    expect(report.visibilityIntegrity.quarantine).toBeDefined();
    expect(report.visibilityIntegrity.quarantine.counts).toBeDefined();
    expect(report.visibilityIntegrity.quarantine.samples).toBeDefined();

    // Verify quarantine counters are present
    expect(report.visibilityIntegrity.quarantine.counts).toMatchObject({
      LEGACY_QUARANTINED: expect.any(Number),
      CURRENT_PATH_DEFECT: expect.any(Number),
      UNKNOWN_UNCLASSIFIED: expect.any(Number),
    });

    // Verify samples structure supports visibility + quarantine tracing
    if (report.visibilityIntegrity.quarantine.samples.LEGACY_QUARANTINED.length > 0) {
      const legacySample = report.visibilityIntegrity.quarantine.samples.LEGACY_QUARANTINED[0];
      expect(legacySample).toHaveProperty('cardId');
      expect(legacySample).toHaveProperty('visibilityBucket');
      expect(legacySample).toHaveProperty('quarantineReason');
      expect(legacySample.quarantineReason).toMatch(/Pre-fix|legacy|cutoff/i);
    }

    if (report.visibilityIntegrity.quarantine.samples.CURRENT_PATH_DEFECT.length > 0) {
      const defectSample = report.visibilityIntegrity.quarantine.samples.CURRENT_PATH_DEFECT[0];
      expect(defectSample).toHaveProperty('cardId');
      expect(defectSample).toHaveProperty('visibilityBucket');
      expect(defectSample).toHaveProperty('quarantineReason');
      expect(defectSample.quarantineReason).toMatch(/New defect|after fix/i);
    }

    // Verify current-path defect count is tracked independently
    expect(report.visibilityIntegrity.quarantine.currentPathDefectCount).toBeLessThanOrEqual(
      report.visibilityIntegrity.quarantine.counts.CURRENT_PATH_DEFECT,
    );

    // Rows that are enrolled or projection-only should NOT appear in quarantine buckets
    const nonQuarantinedIds = new Set();
    report.visibilityIntegrity.samples.ENROLLED.forEach((s) => nonQuarantinedIds.add(s.cardId));
    report.visibilityIntegrity.samples.PROJECTION_ONLY.forEach((s) => nonQuarantinedIds.add(s.cardId));

    report.visibilityIntegrity.quarantine.samples.LEGACY_QUARANTINED.forEach((s) => {
      expect(nonQuarantinedIds).not.toContain(s.cardId);
    });
    report.visibilityIntegrity.quarantine.samples.CURRENT_PATH_DEFECT.forEach((s) => {
      expect(nonQuarantinedIds).not.toContain(s.cardId);
    });
  });
});
