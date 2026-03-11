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
} = require('../jobs/settle_pending_cards.js');

const TEST_DB_PATH = '/tmp/cheddar-test-settlement-pipeline.db';
const LOCK_PATH = `${TEST_DB_PATH}.lock`;

function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // best effort
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

function insertScenario({
  db,
  now,
  gameId,
  sport,
  homeTeam,
  awayTeam,
  finalHome,
  finalAway,
  firstPeriodHome = null,
  firstPeriodAway = null,
  cardId,
  resultId,
  cardType,
  selection,
  line,
  lockedPrice,
  period = 'FULL_GAME',
}) {
  runInsert(
    db,
    `
    INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    `g-${gameId}`,
    sport,
    gameId,
    homeTeam,
    awayTeam,
    now,
    'completed',
  );

  runInsert(
    db,
    `
    INSERT INTO game_results (
      id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    `gr-${gameId}`,
    gameId,
    sport,
    finalHome,
    finalAway,
    'final',
    'manual',
    now,
    JSON.stringify({
      firstPeriodScores:
        Number.isFinite(firstPeriodHome) && Number.isFinite(firstPeriodAway)
          ? { home: firstPeriodHome, away: firstPeriodAway }
          : null,
    }),
  );

  const payloadData = {
    game_id: gameId,
    sport,
    kind: 'PLAY',
    status: 'FIRE',
    home_team: homeTeam,
    away_team: awayTeam,
    market_type: 'TOTAL',
    selection: { side: selection },
    line,
    price: lockedPrice,
    period,
  };

  runInsert(
    db,
    `
    INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    cardId,
    gameId,
    String(sport).toLowerCase(),
    cardType,
    `Card ${cardId}`,
    now,
    JSON.stringify(payloadData),
  );

  runInsert(
    db,
    `
    INSERT INTO card_display_log (
      pick_id, run_id, game_id, sport, market_type, selection, line, odds, displayed_at, api_endpoint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    cardId,
    'run-test',
    gameId,
    sport,
    'TOTAL',
    selection,
    line,
    lockedPrice,
    now,
    '/api/games',
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
    String(sport).toLowerCase(),
    cardType,
    'total',
    'pending',
    buildMarketKey({
      gameId,
      marketType: 'TOTAL',
      selection,
      line,
      period,
    }),
    'TOTAL',
    selection,
    line,
    lockedPrice,
  );
}

describe('settlement pipeline integration (totals + 1P)', () => {
  beforeAll(async () => {
    process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS = 'false';

    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);
    removeBackupsForDb();

    await runMigrations();
    const db = getDatabase();
    const now = new Date().toISOString();

    insertScenario({
      db,
      now,
      gameId: 'nba-over-win',
      sport: 'NBA',
      homeTeam: 'Home NBA A',
      awayTeam: 'Away NBA A',
      finalHome: 112,
      finalAway: 103,
      cardId: 'card-nba-over-win',
      resultId: 'result-nba-over-win',
      cardType: 'nba-totals-call',
      selection: 'OVER',
      line: 214.5,
      lockedPrice: -110,
    });

    insertScenario({
      db,
      now,
      gameId: 'nba-under-loss',
      sport: 'NBA',
      homeTeam: 'Home NBA B',
      awayTeam: 'Away NBA B',
      finalHome: 120,
      finalAway: 110,
      cardId: 'card-nba-under-loss',
      resultId: 'result-nba-under-loss',
      cardType: 'nba-totals-call',
      selection: 'UNDER',
      line: 220.5,
      lockedPrice: -110,
    });

    insertScenario({
      db,
      now,
      gameId: 'nba-over-null-pnl',
      sport: 'NBA',
      homeTeam: 'Home NBA C',
      awayTeam: 'Away NBA C',
      finalHome: 109,
      finalAway: 101,
      cardId: 'card-nba-over-null-pnl',
      resultId: 'result-nba-over-null-pnl',
      cardType: 'nba-totals-call',
      selection: 'OVER',
      line: 205.5,
      lockedPrice: 0,
    });

    insertScenario({
      db,
      now,
      gameId: 'nhl-total-under-win',
      sport: 'NHL',
      homeTeam: 'Home NHL A',
      awayTeam: 'Away NHL A',
      finalHome: 2,
      finalAway: 1,
      firstPeriodHome: 1,
      firstPeriodAway: 0,
      cardId: 'card-nhl-total-under-win',
      resultId: 'result-nhl-total-under-win',
      cardType: 'nhl-totals-call',
      selection: 'UNDER',
      line: 5.5,
      lockedPrice: 105,
    });

    insertScenario({
      db,
      now,
      gameId: 'nhl-total-push',
      sport: 'NHL',
      homeTeam: 'Home NHL B',
      awayTeam: 'Away NHL B',
      finalHome: 3,
      finalAway: 3,
      firstPeriodHome: 1,
      firstPeriodAway: 1,
      cardId: 'card-nhl-total-push',
      resultId: 'result-nhl-total-push',
      cardType: 'nhl-totals-call',
      selection: 'OVER',
      line: 6.0,
      lockedPrice: -110,
    });

    insertScenario({
      db,
      now,
      gameId: 'nhl-1p-over-win',
      sport: 'NHL',
      homeTeam: 'Home NHL C',
      awayTeam: 'Away NHL C',
      finalHome: 4,
      finalAway: 2,
      firstPeriodHome: 2,
      firstPeriodAway: 0,
      cardId: 'card-nhl-1p-over-win',
      resultId: 'result-nhl-1p-over-win',
      cardType: 'nhl-pace-1p',
      selection: 'OVER',
      line: 1.5,
      lockedPrice: -110,
      period: '1P',
    });

    insertScenario({
      db,
      now,
      gameId: 'nhl-1p-under-loss',
      sport: 'NHL',
      homeTeam: 'Home NHL D',
      awayTeam: 'Away NHL D',
      finalHome: 4,
      finalAway: 3,
      firstPeriodHome: 2,
      firstPeriodAway: 1,
      cardId: 'card-nhl-1p-under-loss',
      resultId: 'result-nhl-1p-under-loss',
      cardType: 'nhl-pace-1p',
      selection: 'UNDER',
      line: 1.5,
      lockedPrice: -110,
      period: '1P',
    });

    insertScenario({
      db,
      now,
      gameId: 'nhl-1p-missing-period-score',
      sport: 'NHL',
      homeTeam: 'Home NHL E',
      awayTeam: 'Away NHL E',
      finalHome: 3,
      finalAway: 2,
      cardId: 'card-nhl-1p-missing-period-score',
      resultId: 'result-nhl-1p-missing-period-score',
      cardType: 'nhl-pace-1p',
      selection: 'OVER',
      line: 1.5,
      lockedPrice: -110,
      period: '1P',
    });
  });

  afterAll(() => {
    closeDatabase();
    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);
    removeBackupsForDb();
  });

  test('settles NBA/NHL totals and NHL 1P totals with market-specific grading', async () => {
    const result = await settlePendingCards();
    expect(result.success).toBe(true);

    const db = getDatabase();
    const rows = db
      .prepare(
        `
        SELECT card_id, status, result, pnl_units
        FROM card_results
        ORDER BY card_id
      `,
      )
      .all();

    const byCardId = Object.fromEntries(rows.map((row) => [row.card_id, row]));

    expect(byCardId['card-nba-over-win']).toMatchObject({
      status: 'settled',
      result: 'win',
    });
    expect(byCardId['card-nba-under-loss']).toMatchObject({
      status: 'settled',
      result: 'loss',
    });
    expect(byCardId['card-nba-over-null-pnl']).toMatchObject({
      status: 'settled',
      result: 'win',
      pnl_units: null,
    });

    expect(byCardId['card-nhl-total-under-win']).toMatchObject({
      status: 'settled',
      result: 'win',
    });
    expect(byCardId['card-nhl-total-push']).toMatchObject({
      status: 'settled',
      result: 'push',
      pnl_units: 0,
    });

    expect(byCardId['card-nhl-1p-over-win']).toMatchObject({
      status: 'settled',
      result: 'win',
    });
    expect(byCardId['card-nhl-1p-under-loss']).toMatchObject({
      status: 'settled',
      result: 'loss',
    });
    expect(byCardId['card-nhl-1p-missing-period-score']).toMatchObject({
      status: 'error',
      result: 'void',
    });

    expect(result.coverage.marketDailyCounts).toEqual({
      NBA_TOTAL: { pending: 3, settled: 3, failed: 0 },
      NHL_TOTAL: { pending: 2, settled: 2, failed: 0 },
      NHL_1P_TOTAL: { pending: 3, settled: 2, failed: 1 },
    });
  });
});
