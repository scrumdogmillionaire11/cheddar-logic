/*
 * API POTD behavioral smoke test.
 *
 * Run: node web/src/__tests__/api-potd.test.js
 */

import assert from 'node:assert/strict';
import db from '../../../packages/data/src/db.js';
import {
  setupIsolatedTestDb,
  startIsolatedNextServer,
} from './db-test-runtime.js';

const ET_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function getEtDateKey(date = new Date()) {
  return ET_DATE_FORMATTER.format(date);
}

function insertPotdPlay(client, row) {
  client
    .prepare(
      `INSERT INTO potd_plays
       (id, play_date, game_id, card_id, sport, home_team, away_team,
        market_type, selection, selection_label, line, price, confidence_label,
        total_score, model_win_prob, implied_prob, edge_pct, score_breakdown,
        wager_amount, bankroll_at_post, kelly_fraction, game_time_utc,
        posted_at, discord_posted, discord_posted_at, result, settled_at,
        pnl_dollars, reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.playDate,
      row.gameId,
      row.cardId,
      row.sport,
      row.homeTeam,
      row.awayTeam,
      row.marketType,
      row.selection,
      row.selectionLabel,
      row.line,
      row.price,
      row.confidenceLabel,
      row.totalScore,
      row.modelWinProb,
      row.impliedProb,
      row.edgePct,
      JSON.stringify(row.scoreBreakdown),
      row.wagerAmount,
      row.bankrollAtPost,
      row.kellyFraction,
      row.gameTimeUtc,
      row.postedAt,
      row.discordPosted ? 1 : 0,
      row.discordPostedAt,
      row.result,
      row.settledAt,
      row.pnlDollars,
      row.reasoning,
    );
}

async function run() {
  const testRuntime = await setupIsolatedTestDb('api-potd');
  let server = null;

  try {
    const client = db.getDatabase();
    const now = new Date();
    const today = getEtDateKey(now);
    const historyDate = '2026-04-20';
    const gameTimeUtc = new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();
    const postedAt = '2026-04-22T15:00:00.000Z';

    client
      .prepare(
        `INSERT INTO games
         (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'potd-game-row',
        'mlb',
        'potd-game-1',
        'Fixture Home',
        'Fixture Away',
        gameTimeUtc,
        'scheduled',
        postedAt,
        postedAt,
      );

    insertPotdPlay(client, {
      id: 'potd-play-today',
      playDate: today,
      gameId: 'potd-game-1',
      cardId: 'potd-card-today',
      sport: 'MLB',
      homeTeam: 'Fixture Home',
      awayTeam: 'Fixture Away',
      marketType: 'total',
      selection: 'OVER',
      selectionLabel: 'Over 8.5',
      line: 8.5,
      price: -108,
      confidenceLabel: 'A',
      totalScore: 91.25,
      modelWinProb: 0.61,
      impliedProb: 0.519,
      edgePct: 9.1,
      scoreBreakdown: { model: 70, price: 21.25 },
      wagerAmount: 22,
      bankrollAtPost: 1000,
      kellyFraction: 0.022,
      gameTimeUtc,
      postedAt,
      discordPosted: true,
      discordPostedAt: '2026-04-22T15:01:00.000Z',
      result: null,
      settledAt: null,
      pnlDollars: null,
      reasoning: 'Fixture reasoning for the selected POTD.',
    });
    insertPotdPlay(client, {
      id: 'potd-play-history',
      playDate: historyDate,
      gameId: 'potd-game-history',
      cardId: 'potd-card-history',
      sport: 'NBA',
      homeTeam: 'History Home',
      awayTeam: 'History Away',
      marketType: 'spread',
      selection: 'HOME',
      selectionLabel: 'History Home -2.5',
      line: -2.5,
      price: -110,
      confidenceLabel: 'B',
      totalScore: 77.5,
      modelWinProb: 0.56,
      impliedProb: 0.524,
      edgePct: 3.6,
      scoreBreakdown: { model: 60, price: 17.5 },
      wagerAmount: 20,
      bankrollAtPost: 980,
      kellyFraction: 0.02,
      gameTimeUtc: '2026-04-20T23:00:00.000Z',
      postedAt: '2026-04-20T15:00:00.000Z',
      discordPosted: true,
      discordPostedAt: '2026-04-20T15:01:00.000Z',
      result: 'win',
      settledAt: '2026-04-21T03:00:00.000Z',
      pnlDollars: 18.18,
      reasoning: 'Historical fixture reasoning.',
    });

    client
      .prepare(
        `INSERT INTO potd_bankroll
         (id, event_date, event_type, play_id, card_id, amount_before,
          amount_change, amount_after, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'potd-bankroll-initial',
        '2026-04-01',
        'initial',
        null,
        null,
        1000,
        0,
        1000,
        'Initial test bankroll',
        '2026-04-01T12:00:00.000Z',
      );
    client
      .prepare(
        `INSERT INTO potd_bankroll
         (id, event_date, event_type, play_id, card_id, amount_before,
          amount_change, amount_after, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'potd-bankroll-latest',
        historyDate,
        'settlement',
        'potd-play-history',
        'potd-card-history',
        1000,
        18.18,
        1018.18,
        'Historical win',
        '2026-04-21T03:00:00.000Z',
      );

    client
      .prepare(
        `INSERT INTO potd_nominees
         (play_date, nominee_rank, winner_status, sport, game_id, home_team,
          away_team, market_type, selection_label, line, price, edge_pct,
          total_score, confidence_label, model_win_prob, game_time_utc, source_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        today,
        1,
        'FIRED',
        'MLB',
        'potd-game-1',
        'Fixture Home',
        'Fixture Away',
        'total',
        'Over 8.5',
        8.5,
        -108,
        9.1,
        91.25,
        'A',
        0.61,
        gameTimeUtc,
        'SPORT_WINNER',
      );
    client
      .prepare(
        `INSERT INTO potd_nominees
         (play_date, nominee_rank, winner_status, sport, game_id, home_team,
          away_team, market_type, selection_label, line, price, edge_pct,
          total_score, confidence_label, model_win_prob, game_time_utc, source_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        today,
        2,
        'FIRED',
        'NBA',
        'potd-game-2',
        'Second Home',
        'Second Away',
        'moneyline',
        'Second Home ML',
        null,
        120,
        4.2,
        75,
        'B',
        0.54,
        gameTimeUtc,
        'SPORT_WINNER',
      );

    server = await startIsolatedNextServer({
      dbPath: testRuntime.dbPath,
      label: 'api-potd',
      readinessPath: '/api/potd',
    });

    const response = await fetch(`${server.baseUrl}/api/potd`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, 'POTD route should return 200');
    assert.match(
      response.headers.get('content-type') || '',
      /application\/json/,
      'POTD response should be JSON',
    );

    const payload = await response.json();
    assert.equal(payload.success, true, 'POTD success=false');
    assert.ok(payload.data, 'POTD data is missing');

    const expectedKeys = [
      'featuredPick',
      'today',
      'history',
      'bankroll',
      'schedule',
      'nominees',
      'diagnosticNominees',
      'nearMissSummary',
      'winnerStatus',
      'nextBestFallback',
    ];
    for (const key of expectedKeys) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(payload.data, key),
        `POTD payload missing ${key}`,
      );
    }

    assert.equal(payload.data.winnerStatus, 'FIRED');
    assert.equal(payload.data.today.id, 'potd-play-today');
    assert.equal(payload.data.featuredPick.cardId, 'potd-card-today');
    assert.equal(payload.data.today.reasoning, 'Fixture reasoning for the selected POTD.');
    assert.equal(payload.data.today.discordPosted, true);
    assert.deepEqual(payload.data.today.scoreBreakdown, { model: 70, price: 21.25 });
    assert.equal(payload.data.history.length, 1, 'history should include non-today plays');
    assert.equal(payload.data.history[0].reasoning, 'Historical fixture reasoning.');
    assert.equal(payload.data.bankroll.current, 1018.18);
    assert.equal(payload.data.bankroll.starting, 1000);
    assert.equal(payload.data.bankroll.postedCount, 2);
    assert.equal(payload.data.bankroll.settledCount, 1);
    assert.equal(payload.data.bankroll.wins, 1);
    assert.equal(payload.data.nominees.length, 1, 'FIRED days should omit the rank-1 nominee');
    assert.equal(payload.data.nominees[0].rank, 2);
    assert.deepEqual(payload.data.diagnosticNominees, []);
    assert.equal(payload.data.nearMissSummary.sampleSize, 0);
    // nextBestFallback is null when an official play exists today
    assert.equal(payload.data.nextBestFallback, null, 'nextBestFallback should be null when official play exists');

    console.log('✅ API POTD behavioral smoke test passed');
  } finally {
    if (server) await server.stop();
    testRuntime.cleanup();
  }
}

async function runNextBestFallback() {
  const testRuntime = await setupIsolatedTestDb('api-potd-next-best');
  let server = null;

  try {
    const client = db.getDatabase();
    const now = new Date();
    const today = getEtDateKey(now);
    const gameTimeUtc = new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();
    const capturedAt = new Date().toISOString();

    // No potd_plays row for today — intentionally omitted

    // Insert shadow candidate for today
    client
      .prepare(
        `INSERT INTO potd_shadow_candidates
         (play_date, captured_at, sport, market_type, selection_label,
          home_team, away_team, game_id, price, line, edge_pct,
          total_score, model_win_prob, projection_source, shadow_reason,
          candidate_identity_key, game_time_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        today,
        capturedAt,
        'NHL',
        'MONEYLINE',
        'Anaheim Ducks ML',
        'Anaheim Ducks',
        'San Jose Sharks',
        'nhl-game-fallback',
        145,
        null,
        0.175,
        82.5,
        0.615,
        'model_v2',
        'NON_PLAY_DECISION_OUTCOME',
        'NHL:MONEYLINE:Anaheim Ducks ML',
        gameTimeUtc,
      );

    server = await startIsolatedNextServer({
      dbPath: testRuntime.dbPath,
      label: 'api-potd-next-best',
      readinessPath: '/api/potd',
    });

    const response = await fetch(`${server.baseUrl}/api/potd`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.success, true);
    assert.equal(payload.data.today, null, 'today should be null (no official play)');
    assert.ok(payload.data.nextBestFallback, 'nextBestFallback should be populated');
    assert.equal(payload.data.nextBestFallback.presentationLabel, 'Next Best');
    assert.equal(payload.data.nextBestFallback.sourceTable, 'potd_shadow_candidates');
    assert.equal(payload.data.nextBestFallback.selectionLabel, 'Anaheim Ducks ML');
    assert.equal(payload.data.nextBestFallback.sport, 'NHL');
    assert.ok(payload.data.nextBestFallback.edgePct > 0, 'edgePct should be positive');

    console.log('✅ API POTD next-best fallback test passed');
  } finally {
    if (server) await server.stop();
    testRuntime.cleanup();
  }
}

async function runAll() {
  await run();
  await runNextBestFallback();
}

runAll().catch((error) => {
  console.error('❌ API POTD behavioral smoke test failed');
  console.error(error);
  process.exit(1);
});
