const fs = require('fs');
const path = require('path');
const {
  buildMarketKey,
  closeDatabase,
  getDatabase,
  runMigrations,
} = require('@cheddar-logic/data');
const {
  settlePendingCards,
  __private,
} = require('../jobs/settle_pending_cards.js');

const TEST_DB_PATH = '/tmp/cheddar-test-settle-coverage.db';
const LOCK_PATH = `${TEST_DB_PATH}.lock`;

function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best-effort cleanup for test artifacts.
  }
}

function removeBackupsForDb() {
  const backupsDir = path.join(path.dirname(TEST_DB_PATH), 'backups');
  if (!fs.existsSync(backupsDir)) return;
  for (const entry of fs.readdirSync(backupsDir)) {
    if (
      entry.startsWith('cheddar-before-settle-cards-') &&
      entry.endsWith('.db')
    ) {
      removeIfExists(path.join(backupsDir, entry));
    }
  }
}

function runInsert(db, sql, ...params) {
  db.prepare(sql).run(...params);
}

function insertSeedData(db) {
  const now = new Date().toISOString();
  const finalNba = 'game-final-nba';
  const finalNhl = 'game-final-nhl';
  const liveNba = 'game-live-nba';

  runInsert(
    db,
    `
    INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    'g-1',
    'NBA',
    finalNba,
    'Home A',
    'Away A',
    now,
    'completed',
  );
  runInsert(
    db,
    `
    INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    'g-2',
    'NHL',
    finalNhl,
    'Home B',
    'Away B',
    now,
    'completed',
  );
  runInsert(
    db,
    `
    INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    'g-3',
    'NBA',
    liveNba,
    'Home C',
    'Away C',
    now,
    'in_progress',
  );

  runInsert(
    db,
    `
    INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    'card-p1',
    finalNba,
    'nba',
    'nba-model-output',
    'P1',
    now,
    JSON.stringify({ home_team: 'Home A', away_team: 'Away A' }),
  );
  runInsert(
    db,
    `
    INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    'card-p2',
    finalNba,
    'nba',
    'nba-model-output',
    'P2',
    now,
    JSON.stringify({ home_team: 'Home A', away_team: 'Away A' }),
  );
  runInsert(
    db,
    `
    INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    'card-p3',
    liveNba,
    'nba',
    'nba-model-output',
    'P3',
    now,
    JSON.stringify({ home_team: 'Home C', away_team: 'Away C' }),
  );
  runInsert(
    db,
    `
    INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    'card-p4',
    finalNhl,
    'nhl',
    'nhl-model-output',
    'P4',
    now,
    JSON.stringify({ home_team: 'Home B', away_team: 'Away B' }),
  );
  runInsert(
    db,
    `
    INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    'card-p5',
    finalNhl,
    'nhl',
    'nhl-model-output',
    'P5',
    now,
    JSON.stringify({
      kind: 'PLAY',
      status: 'FIRE',
      market_type: 'MONEYLINE',
      selection: { side: 'HOME' },
      line: null,
      price: -120,
      home_team: 'Home B',
      away_team: 'Away B',
    }),
  );

  const nbaHomeKey = buildMarketKey({
    gameId: finalNba,
    marketType: 'MONEYLINE',
    selection: 'HOME',
    line: null,
  });
  const nhlAwayKey = buildMarketKey({
    gameId: finalNhl,
    marketType: 'MONEYLINE',
    selection: 'AWAY',
    line: null,
  });

  runInsert(
    db,
    `
    INSERT INTO card_results (
      id, card_id, game_id, sport, card_type, recommended_bet_type,
      status, market_key, market_type, selection, line, locked_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    'result-p1',
    'card-p1',
    finalNba,
    'nba',
    'nba-model-output',
    'moneyline',
    'pending',
    nbaHomeKey,
    'MONEYLINE',
    'HOME',
    null,
    -110,
  );
  runInsert(
    db,
    `
    INSERT INTO card_results (
      id, card_id, game_id, sport, card_type, recommended_bet_type,
      status, market_key, market_type, selection, line, locked_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    'result-p2',
    'card-p2',
    finalNba,
    'nba',
    'nba-model-output',
    'moneyline',
    'settled',
    nbaHomeKey,
    'MONEYLINE',
    'HOME',
    null,
    -110,
  );
  runInsert(
    db,
    `
    INSERT INTO card_results (
      id, card_id, game_id, sport, card_type, recommended_bet_type,
      status, market_key, market_type, selection, line, locked_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    'result-p3',
    'card-p3',
    liveNba,
    'nba',
    'nba-model-output',
    'moneyline',
    'pending',
    buildMarketKey({
      gameId: liveNba,
      marketType: 'MONEYLINE',
      selection: 'HOME',
      line: null,
    }),
    'MONEYLINE',
    'HOME',
    null,
    -105,
  );
  runInsert(
    db,
    `
    INSERT INTO card_results (
      id, card_id, game_id, sport, card_type, recommended_bet_type,
      status, market_key, market_type, selection, line, locked_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    'result-p4',
    'card-p4',
    finalNhl,
    'nhl',
    'nhl-model-output',
    'moneyline',
    'pending',
    nhlAwayKey,
    'MONEYLINE',
    'AWAY',
    null,
    -115,
  );
  runInsert(
    db,
    `
    INSERT INTO card_results (
      id, card_id, game_id, sport, card_type, recommended_bet_type,
      status, market_key, market_type, selection, line, locked_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    'result-p5',
    'card-p5',
    finalNhl,
    'nhl',
    'nhl-model-output',
    'moneyline',
    'pending',
    buildMarketKey({
      gameId: finalNhl,
      marketType: 'MONEYLINE',
      selection: 'HOME',
      line: null,
    }),
    'MONEYLINE',
    'HOME',
    null,
    -120,
  );

  runInsert(
    db,
    `
    INSERT INTO card_display_log (pick_id, run_id, game_id, sport, displayed_at, api_endpoint)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    'card-p1',
    'run-test',
    finalNba,
    'NBA',
    now,
    '/api/games',
  );
  runInsert(
    db,
    `
    INSERT INTO card_display_log (pick_id, run_id, game_id, sport, displayed_at, api_endpoint)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    'card-p2',
    'run-test',
    finalNba,
    'NBA',
    now,
    '/api/games',
  );
  runInsert(
    db,
    `
    INSERT INTO card_display_log (pick_id, run_id, game_id, sport, displayed_at, api_endpoint)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    'card-p3',
    'run-test',
    liveNba,
    'NBA',
    now,
    '/api/games',
  );
  runInsert(
    db,
    `
    INSERT INTO card_display_log (pick_id, run_id, game_id, sport, displayed_at, api_endpoint)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    'card-p4',
    'run-test',
    finalNhl,
    'NHL',
    now,
    '/api/games',
  );
  runInsert(
    db,
    `
    INSERT INTO card_display_log (pick_id, run_id, game_id, sport, displayed_at, api_endpoint)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    'card-missing',
    'run-test',
    finalNhl,
    'NHL',
    now,
    '/api/games',
  );

  runInsert(
    db,
    `
    INSERT INTO game_results (
      id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    'gr-nba-final',
    finalNba,
    'NBA',
    110,
    100,
    'final',
    'manual',
    now,
  );
  runInsert(
    db,
    `
    INSERT INTO game_results (
      id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    'gr-nhl-final',
    finalNhl,
    'NHL',
    3,
    2,
    'final',
    'manual',
    now,
  );
  runInsert(
    db,
    `
    INSERT INTO game_results (
      id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    'gr-nba-live',
    liveNba,
    'NBA',
    95,
    92,
    'in_progress',
    'manual',
    now,
  );
}

describe('settlement coverage parity', () => {
  beforeAll(async () => {
    process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS = 'false';

    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);
    removeBackupsForDb();

    await runMigrations();
    const db = getDatabase();
    insertSeedData(db);
  });

  afterAll(() => {
    closeDatabase();
    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);
    removeBackupsForDb();
  });

  test('diagnostics capture displayed-final settlement gaps', () => {
    const db = getDatabase();
    const diagnostics = __private.getSettlementCoverageDiagnostics(db);

    expect(diagnostics.totalPending).toBe(4);
    expect(diagnostics.eligiblePendingFinalDisplayed).toBe(2);
    expect(diagnostics.settledDisplayedFinal).toBe(1);
    expect(diagnostics.displayedFinal).toBe(4);
    expect(diagnostics.finalDisplayedMissingResults).toBe(1);
    expect(diagnostics.finalDisplayedUnsettled).toBe(3);
    expect(diagnostics.pendingWithFinalNoDisplay).toBe(1);
    expect(diagnostics.pendingWithFinalButNotDisplayed).toBe(1);

    const nbaDiagnostics = __private.getSettlementCoverageDiagnostics(
      db,
      'NBA',
    );
    expect(nbaDiagnostics.totalPending).toBe(2);
    expect(nbaDiagnostics.eligiblePendingFinalDisplayed).toBe(1);
    expect(nbaDiagnostics.settledDisplayedFinal).toBe(1);
    expect(nbaDiagnostics.displayedFinal).toBe(2);
    expect(nbaDiagnostics.finalDisplayedMissingResults).toBe(0);
    expect(nbaDiagnostics.finalDisplayedUnsettled).toBe(1);
  });

  test('settlePendingCards settles only displayed + final eligible rows', async () => {
    const originalGate = process.env.CHEDDAR_SETTLEMENT_ENABLE_DISPLAY_BACKFILL;
    delete process.env.CHEDDAR_SETTLEMENT_ENABLE_DISPLAY_BACKFILL;
    try {
      const result = await settlePendingCards({ allowDisplayBackfill: true });
      expect(result.success).toBe(true);
      expect(result.cardsErrored).toBe(0);
      expect(result.coverage).toMatchObject({
        pending: 4,
        eligible: 2,
      });
      expect(result.coverage.marketDailyCounts?.NHL_MONEYLINE).toMatchObject({
        pending: 1,
        settled: 1,
        failed: 0,
      });

      const db = getDatabase();
      const statuses = db
        .prepare(
          `
          SELECT card_id, status, result
          FROM card_results
          ORDER BY card_id
        `,
        )
        .all();

      const byCard = Object.fromEntries(
        statuses.map((row) => [
          row.card_id,
          { status: row.status, result: row.result },
        ]),
      );
      expect(byCard['card-p1'].status).toBe('settled');
      expect(byCard['card-p1'].result).toBe('win');
      expect(byCard['card-p2'].status).toBe('settled');
      expect(byCard['card-p3'].status).toBe('pending');
      expect(byCard['card-p4'].status).toBe('settled');
      expect(byCard['card-p4'].result).toBe('loss');
      expect(byCard['card-p5'].status).toBe('pending');

      const diagnosticsAfter = __private.getSettlementCoverageDiagnostics(db);
      expect(diagnosticsAfter.eligiblePendingFinalDisplayed).toBe(0);
      expect(diagnosticsAfter.finalDisplayedUnsettled).toBe(1);
      expect(diagnosticsAfter.finalDisplayedMissingResults).toBe(1);
      expect(diagnosticsAfter.pendingWithFinalButNotDisplayed).toBe(1);
    } finally {
      if (originalGate === undefined) {
        delete process.env.CHEDDAR_SETTLEMENT_ENABLE_DISPLAY_BACKFILL;
      } else {
        process.env.CHEDDAR_SETTLEMENT_ENABLE_DISPLAY_BACKFILL = originalGate;
      }
    }
  });

  test('allowDisplayBackfill settles pending final cards missing display-log', async () => {
    const originalGate = process.env.CHEDDAR_SETTLEMENT_ENABLE_DISPLAY_BACKFILL;
    process.env.CHEDDAR_SETTLEMENT_ENABLE_DISPLAY_BACKFILL = 'true';
    try {
      const result = await settlePendingCards({ allowDisplayBackfill: true });
      expect(result.success).toBe(true);
      expect(result.cardsErrored).toBe(0);
      expect(result.coverage.marketDailyCounts?.NHL_MONEYLINE).toMatchObject({
        pending: 1,
        settled: 1,
        failed: 0,
      });

      const db = getDatabase();
      const cardP5 = db
        .prepare(
          `
          SELECT status, result
          FROM card_results
          WHERE card_id = ?
        `,
        )
        .get('card-p5');
      expect(cardP5?.status).toBe('settled');
      expect(cardP5?.result).toBe('win');

      const diagnosticsAfterBackfill = __private.getSettlementCoverageDiagnostics(db);
      expect(diagnosticsAfterBackfill.pendingWithFinalButNotDisplayed).toBe(0);
    } finally {
      if (originalGate === undefined) {
        delete process.env.CHEDDAR_SETTLEMENT_ENABLE_DISPLAY_BACKFILL;
      } else {
        process.env.CHEDDAR_SETTLEMENT_ENABLE_DISPLAY_BACKFILL = originalGate;
      }
    }
  });

  test('settlePendingCards auto-closes final PASS rows as void errors', async () => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const finalNhl = 'game-final-nhl';

    runInsert(
      db,
      `
      INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      'card-p6-pass',
      finalNhl,
      'nhl',
      'nhl-model-output',
      'P6',
      now,
      JSON.stringify({
        kind: 'PLAY',
        status: 'PASS',
        decision_v2: { official_status: 'PASS' },
        market_type: 'MONEYLINE',
        selection: { side: 'HOME' },
        price: -125,
        home_team: 'Home B',
        away_team: 'Away B',
      }),
    );

    runInsert(
      db,
      `
      INSERT INTO card_results (
        id, card_id, game_id, sport, card_type, recommended_bet_type,
        status, market_key, market_type, selection, line, locked_price
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      'result-p6-pass',
      'card-p6-pass',
      finalNhl,
      'nhl',
      'nhl-model-output',
      'moneyline',
      'pending',
      buildMarketKey({
        gameId: finalNhl,
        marketType: 'MONEYLINE',
        selection: 'HOME',
        line: null,
      }),
      'MONEYLINE',
      'HOME',
      null,
      -125,
    );

    const settledAt = new Date().toISOString();
    const closeResult = __private.autoCloseNonActionableFinalPendingRows(
      db,
      settledAt,
    );
    expect(closeResult.closed).toBeGreaterThanOrEqual(1);
    expect(
      closeResult.reasonCounts.NON_ACTIONABLE_FINAL_PASS,
    ).toBeGreaterThanOrEqual(1);

    const row = db
      .prepare(
        `
        SELECT status, result, settled_at, metadata
        FROM card_results
        WHERE id = ?
      `,
      )
      .get('result-p6-pass');

    expect(row?.status).toBe('error');
    expect(row?.result).toBe('void');
    expect(row?.settled_at).toBeTruthy();
    const metadata = row?.metadata ? JSON.parse(row.metadata) : {};
    expect(metadata?.settlement_error?.code).toBe('NON_ACTIONABLE_FINAL_PASS');
    expect(metadata?.settlement_error?.classification).toBe(
      'NON_ACTIONABLE_AUTO_CLOSE',
    );
    expect(metadata?.settlement_error?.at).toBe(settledAt);
  });

  test('computePnlUnits follows canonical forward-only formula', () => {
    expect(__private.computePnlUnits('win', 150)).toBeCloseTo(1.5, 6);
    expect(__private.computePnlUnits('win', -125)).toBeCloseTo(0.8, 6);
    expect(__private.computePnlUnits('loss', -110)).toBe(-1);
    expect(__private.computePnlUnits('push', -110)).toBe(0);
    expect(__private.computePnlUnits('win', 0)).toBeNull();
    expect(__private.computePnlUnits('win', null)).toBeNull();
  });

  test('computePnlOutcome flags malformed-odds anomaly without failing settlement', () => {
    const outcome = __private.computePnlOutcome('win', 0);
    expect(outcome).toMatchObject({
      pnlUnits: null,
      anomalyCode: 'PNL_ODDS_INVALID',
    });
  });

  test('gradeLockedMarket uses first-period scores for 1P totals', () => {
    expect(
      __private.gradeLockedMarket({
        marketType: 'TOTAL',
        selection: 'OVER',
        line: 1.5,
        homeScore: 4,
        awayScore: 3,
        period: '1P',
        firstPeriodScores: { home: 2, away: 0 },
      }),
    ).toBe('win');

    expect(
      __private.gradeLockedMarket({
        marketType: 'TOTAL',
        selection: 'UNDER',
        line: 1.5,
        homeScore: 4,
        awayScore: 3,
        period: '1P',
        firstPeriodScores: { home: 2, away: 0 },
      }),
    ).toBe('loss');
  });
});
