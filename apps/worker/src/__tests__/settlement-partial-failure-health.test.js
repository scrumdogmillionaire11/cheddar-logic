'use strict';

const fs = require('fs');
const path = require('path');
const {
  buildMarketKey,
  closeDatabase,
  getDatabase,
  runMigrations,
} = require('@cheddar-logic/data');

jest.mock('../utils/db-backup.js', () => ({
  backupDatabase: jest.fn(),
}));

jest.mock('../jobs/check_pipeline_health', () => ({
  writePipelineHealth: jest.fn(),
}));

const { settlePendingCards } = require('../jobs/settle_pending_cards');

function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // best effort
  }
}

function runInsert(db, sql, ...params) {
  db.prepare(sql).run(...params);
}

function seedPendingSettlementRow(
  db,
  {
    cardId,
    resultId,
    marketType,
    selection,
    line,
    marketKey,
  },
) {
  const now = new Date().toISOString();
  const gameId = `game-${cardId}`;

  runInsert(
    db,
    `
    INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    `g-${cardId}`,
    'NBA',
    gameId,
    'Home A',
    'Away A',
    now,
    'completed',
  );

  runInsert(
    db,
    `
    INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    cardId,
    gameId,
    'nba',
    'nba-model-output',
    `Card ${cardId}`,
    now,
    JSON.stringify({
      home_team: 'Home A',
      away_team: 'Away A',
      kind: 'PLAY',
      decision_v2: { official_status: 'PLAY' },
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
    resultId,
    cardId,
    gameId,
    'nba',
    'nba-model-output',
    marketType === 'TOTAL' ? 'total' : 'moneyline',
    'pending',
    marketKey,
    marketType,
    selection,
    line,
    -110,
  );

  runInsert(
    db,
    `
    INSERT INTO card_display_log (pick_id, run_id, game_id, sport, displayed_at, api_endpoint)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    cardId,
    'run-test',
    gameId,
    'NBA',
    now,
    '/api/cards',
  );

  runInsert(
    db,
    `
    INSERT INTO game_results (
      id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    `gr-${cardId}`,
    gameId,
    'NBA',
    110,
    100,
    'final',
    'manual',
    now,
  );

  return { gameId };
}

describe('settlement fail-closed job health', () => {
  let testDbPath;
  let lockPath;

  beforeEach(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    testDbPath = path.join('/tmp', `cheddar-settlement-health-${suffix}.db`);
    lockPath = `${testDbPath}.lock`;

    process.env.CHEDDAR_DB_PATH = testDbPath;
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS = 'false';

    removeIfExists(testDbPath);
    removeIfExists(lockPath);

    await runMigrations();
  });

  afterEach(() => {
    closeDatabase();
    removeIfExists(testDbPath);
    removeIfExists(lockPath);
  });

  test('market key mismatch fails the run instead of silently succeeding', async () => {
    const db = getDatabase();
    const correctMarketKey = buildMarketKey({
      gameId: 'unused',
      marketType: 'MONEYLINE',
      selection: 'HOME',
      line: null,
    });
    seedPendingSettlementRow(db, {
      cardId: 'card-mismatch',
      resultId: 'result-mismatch',
      marketType: 'MONEYLINE',
      selection: 'HOME',
      line: null,
      marketKey: `${correctMarketKey}-wrong`,
    });

    const result = await settlePendingCards({ dryRun: false });

    const reader = getDatabase();
    const settledRow = reader
      .prepare(`SELECT status, result FROM card_results WHERE id = ?`)
      .get('result-mismatch');
    const jobRunRow = reader
      .prepare(
        `
        SELECT status, error_message
        FROM job_runs
        WHERE job_name = 'settle_pending_cards'
        ORDER BY started_at DESC
        LIMIT 1
      `,
      )
      .get();

    expect(settledRow).toMatchObject({ status: 'error', result: 'void' });
    expect(jobRunRow.status).toBe('failed');
    expect(result).toMatchObject({
      ok: false,
      success: false,
      exitCode: 1,
      jobStatus: 'failed',
    });
    expect(result.healthIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          healthClass: 'SETTLEMENT_CRITICAL_MISMATCH_UNRESOLVED',
          cardId: 'card-mismatch',
        }),
      ]),
    );
  });

  test('missing market line is promoted to partial-write critical failure', async () => {
    const db = getDatabase();
    seedPendingSettlementRow(db, {
      cardId: 'card-missing-line',
      resultId: 'result-missing-line',
      marketType: 'TOTAL',
      selection: 'OVER',
      line: null,
      marketKey: 'game-card-missing-line-total-over-missing-line',
    });

    const result = await settlePendingCards({ dryRun: false });

    const reader = getDatabase();
    const settledRow = reader
      .prepare(`SELECT status, result FROM card_results WHERE id = ?`)
      .get('result-missing-line');
    const jobRunRow = reader
      .prepare(
        `
        SELECT status, error_message
        FROM job_runs
        WHERE job_name = 'settle_pending_cards'
        ORDER BY started_at DESC
        LIMIT 1
      `,
      )
      .get();

    expect(settledRow).toMatchObject({ status: 'error', result: 'void' });
    expect(jobRunRow.status).toBe('failed');
    expect(result).toMatchObject({
      ok: false,
      success: false,
      exitCode: 1,
      jobStatus: 'failed',
    });
    expect(result.healthIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          healthClass: 'SETTLEMENT_PARTIAL_WRITE_CRITICAL',
          cardId: 'card-missing-line',
        }),
      ]),
    );
  });
});
