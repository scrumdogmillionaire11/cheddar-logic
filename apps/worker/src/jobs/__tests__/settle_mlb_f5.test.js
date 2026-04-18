'use strict';

const fs = require('fs');
const {
  gradeF5Card,
  fetchF5Total,
  resolveF5Snapshot,
  normalizeF5MlSelection,
  isF5TotalCard,
  isF5MlCard,
  REASON_CODES,
  settleMlbF5,
} = require('../settle_mlb_f5');
const { settlePendingCards } = require('../settle_pending_cards');

// ─────────────────────────────────────────────────────────────────────────────
// gradeF5Card — pure function unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('gradeF5Card', () => {
  test('OVER win: actual total exceeds line', () => {
    expect(gradeF5Card('OVER', 8.5, 10)).toBe('win');
  });

  test('OVER loss: actual total below line', () => {
    expect(gradeF5Card('OVER', 8.5, 7)).toBe('loss');
  });

  test('UNDER win: actual total below line', () => {
    expect(gradeF5Card('UNDER', 8.5, 7)).toBe('win');
  });

  test('UNDER loss: actual total exceeds line', () => {
    expect(gradeF5Card('UNDER', 8.5, 10)).toBe('loss');
  });

  test('push (exact): actual total equals line exactly', () => {
    expect(gradeF5Card('OVER', 8, 8)).toBe('push');
  });

  test('push (within 0.05): actual total within rounding threshold', () => {
    expect(gradeF5Card('OVER', 8, 8.04)).toBe('push');
  });

  test('PASS prediction returns null', () => {
    expect(gradeF5Card('PASS', 8, 10)).toBe(null);
  });

  test('null actual total returns null', () => {
    expect(gradeF5Card('OVER', 8, null)).toBe(null);
  });

  test('null line returns null', () => {
    expect(gradeF5Card('OVER', null, 10)).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchF5Total — mocked global.fetch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a mock linescore payload for N innings.
 * runs array: pairs [homeRuns, awayRuns] per inning, length = N.
 */
function buildLinescorePayload(runsPerInning) {
  const now = Date.now();
  return {
    gameData: {
      status: { abstractGameState: 'Final' },
    },
    metaData: {
      timeStamp: new Date(now - 20_000).toISOString(),
    },
    liveData: {
      plays: {
        currentPlay: {
          about: {
            isComplete: true,
            endTime: new Date(now - 20_000).toISOString(),
          },
        },
      },
      linescore: {
        currentInning: runsPerInning.length >= 5 ? 6 : runsPerInning.length,
        isTopInning: true,
        outs: 3,
        innings: runsPerInning.map(([homeRuns, awayRuns]) => ({
          home: { runs: homeRuns },
          away: { runs: awayRuns },
        })),
      },
    },
  };
}

describe('fetchF5Total', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (originalFetch !== undefined) {
      global.fetch = originalFetch;
    } else {
      delete global.fetch;
    }
  });

  test('returns sum of runs for 5 innings when first URL returns valid linescore', async () => {
    // 5 innings: home=[2,0,1,0,3], away=[1,0,0,1,0] => sum = 8
    const payload = buildLinescorePayload([[2, 1], [0, 0], [1, 0], [0, 1], [3, 0]]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const result = await fetchF5Total(745398);
    expect(result).toBe(8);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('returns null when linescore has only 4 innings (game incomplete)', async () => {
    const payload = buildLinescorePayload([[2, 1], [0, 0], [1, 0], [0, 1]]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    const result = await fetchF5Total(745398);
    expect(result).toBe(null);
  });

  test('falls back to second URL when first URL returns !ok', async () => {
    const payload = buildLinescorePayload([[2, 1], [0, 0], [1, 0], [0, 1], [3, 0]]);
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => payload,
      });

    const result = await fetchF5Total(745398);
    expect(result).toBe(8);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('returns null when both URLs fail (fetch throws)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network error'));

    const result = await fetchF5Total(745398);
    expect(result).toBe(null);
  });
});

describe('WI-1007 F5 snapshot and ML helpers', () => {
  const stableTime = {
    snapshot_fetched_at: '2026-04-18T12:00:10.000Z',
    last_event_timestamp: '2026-04-18T12:00:00.000Z',
  };

  test('resolveF5Snapshot returns READY only after stable verified F5 state', () => {
    const snapshot = resolveF5Snapshot({
      current_inning: 6,
      is_bottom_inning: false,
      home_runs: 4,
      away_runs: 2,
      current_outs: 3,
      abstract_game_state: 'Final',
      partial_play_flag: false,
      ...stableTime,
    });

    expect(snapshot.status).toBe('READY');
    expect(snapshot.is_verified).toBe(true);
    expect(snapshot.home_runs).toBe(4);
    expect(snapshot.away_runs).toBe(2);
  });

  test('resolveF5Snapshot grades 4.5 innings using pre-bottom-fifth score only', () => {
    const snapshot = resolveF5Snapshot({
      current_inning: 5,
      is_bottom_inning: true,
      home_runs: 5,
      away_runs: 2,
      home_runs_through_4: 3,
      away_runs_through_5: 2,
      current_outs: 1,
      abstract_game_state: 'In Progress',
      partial_play_flag: false,
      ...stableTime,
    });

    expect(snapshot.status).toBe('READY');
    expect(snapshot.is_verified).toBe(true);
    expect(snapshot.home_runs).toBe(3);
    expect(snapshot.away_runs).toBe(2);
  });

  test('resolveF5Snapshot keeps not-yet-eligible games pending', () => {
    const snapshot = resolveF5Snapshot({
      current_inning: 4,
      is_bottom_inning: true,
      home_runs: 1,
      away_runs: 1,
      current_outs: 1,
      abstract_game_state: 'In Progress',
      partial_play_flag: false,
      ...stableTime,
    });

    expect(snapshot.status).toBe('NOT_READY');
    expect(snapshot.reason_code).toBe(REASON_CODES.NOT_READY);
  });

  test('resolveF5Snapshot returns UNGRADABLE for unstable feed snapshots', () => {
    const snapshot = resolveF5Snapshot({
      current_inning: 6,
      is_bottom_inning: false,
      home_runs: 4,
      away_runs: 2,
      current_outs: 3,
      abstract_game_state: 'Final',
      partial_play_flag: false,
      snapshot_fetched_at: '2026-04-18T12:00:05.000Z',
      last_event_timestamp: '2026-04-18T12:00:00.000Z',
    });

    expect(snapshot.status).toBe('UNGRADABLE');
    expect(snapshot.reason_code).toBe(REASON_CODES.UNVERIFIED);
  });

  test('normalizeF5MlSelection maps side variants and fails closed', () => {
    expect(normalizeF5MlSelection({ selection: 'H' })).toBe('HOME');
    expect(normalizeF5MlSelection({ selection: 'away' })).toBe('AWAY');
    expect(
      normalizeF5MlSelection({
        selection: 'Boston Red Sox',
        home_team: 'Boston Red Sox',
        away_team: 'New York Yankees',
      }),
    ).toBe('HOME');
    expect(
      normalizeF5MlSelection({
        selection: 'Sox',
        home_team: 'Boston Red Sox',
        away_team: 'Chicago White Sox',
      }),
    ).toBe('INVALID');
  });

  test('F5 totals and ML predicates are mutually exclusive by card_type', () => {
    expect(isF5TotalCard({ card_type: 'mlb-f5' })).toBe(true);
    expect(isF5TotalCard({ card_type: 'mlb-f5-ml' })).toBe(false);
    expect(isF5MlCard({ card_type: 'mlb-f5-ml' })).toBe(true);
    expect(isF5MlCard({ card_type: 'mlb-f5' })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// settleMlbF5 integration — in-memory SQLite DB
// ─────────────────────────────────────────────────────────────────────────────

const TEST_DB_PATH = '/tmp/cheddar-test-settle-mlb-f5.db';
const LOCK_PATH = `${TEST_DB_PATH}.lock`;

function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best effort
  }
}

/**
 * Insert the minimal rows needed to simulate a pending MLB card scenario.
 *
 * @param {object} db - better-sqlite3 database instance
 * @param {object} opts
 * @param {string} opts.gameId
 * @param {string} opts.cardId
 * @param {string} opts.resultId
 * @param {string} opts.marketKey  - stored in card_results.market_key
 * @param {string} opts.payloadMarketKey - stored in card_payloads payload_data.market_key
 * @param {string} [opts.homeTeam] - home team abbreviation (default 'BOS')
 * @param {string} [opts.awayTeam] - away team abbreviation (default 'NYY')
 * @param {string} [opts.gameTimeUtc] - scheduled start for games row and scheduled-start lookup
 * @param {string} [opts.gamePkKey] - key for mlb_game_pk_map (omit to test missing entry)
 * @param {number} [opts.gamePk]   - value for mlb_game_pk_map
 */
function insertF5Scenario(db, {
  gameId,
  cardId,
  resultId,
  marketKey,
  payloadMarketKey,
  cardType = 'mlb-f5',
  marketType = 'TOTAL',
  recommendedBetType = 'total',
  selection = 'OVER',
  line = 7.5,
  lockedPrice = -110,
  prediction = 'OVER',
  selectionSide = null,
  status = 'pending',
  result = null,
  settledAt = null,
  homeTeam = 'BOS',
  awayTeam = 'NYY',
  gameTimeUtc = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
  gamePkKey,
  gamePk,
}) {
  const pastTime = gameTimeUtc;

  // games row — sport must be lowercase per schema CHECK constraint
  db.prepare(`
    INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
    VALUES (?, 'mlb', ?, ?, ?, ?, 'scheduled')
  `).run(`g-${gameId}`, gameId, homeTeam, awayTeam, pastTime);

  // card_payloads row — payload includes prediction, f5_line, and market_key
  const payloadData = {
    prediction,
    f5_line: line,
    market_key: payloadMarketKey,
    market: null,
    ...(selectionSide ? { selection: { side: selectionSide } } : {}),
  };
  db.prepare(`
    INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data)
    VALUES (?, ?, 'mlb', ?, 'Test F5 Card', ?, ?)
  `).run(cardId, gameId, cardType, pastTime, JSON.stringify(payloadData));

  // card_results row — sport must be lowercase per schema CHECK constraint
  db.prepare(`
    INSERT INTO card_results (
      id, card_id, game_id, sport, card_type, recommended_bet_type,
      status, result, market_key, market_type, selection, line, locked_price, settled_at
    ) VALUES (?, ?, ?, 'mlb', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    resultId,
    cardId,
    gameId,
    cardType,
    recommendedBetType,
    status,
    result,
    marketKey,
    marketType,
    selection,
    line,
    lockedPrice,
    settledAt,
  );

  // mlb_game_pk_map table (created by pull_mlb_pitcher_stats, not a migration)
  db.exec(`
    CREATE TABLE IF NOT EXISTS mlb_game_pk_map (
      game_pk_key TEXT PRIMARY KEY,
      game_pk INTEGER NOT NULL,
      game_date TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mlb_probable_starter_map (
      game_pk_key TEXT PRIMARY KEY,
      game_pk INTEGER NOT NULL,
      game_date TEXT NOT NULL,
      scheduled_start_utc TEXT NOT NULL,
      home_team_abbr TEXT NOT NULL,
      away_team_abbr TEXT NOT NULL
    )
  `);

  if (gamePkKey && gamePk != null) {
    db.prepare(`
      INSERT OR REPLACE INTO mlb_game_pk_map (game_pk_key, game_pk, game_date)
      VALUES (?, ?, ?)
    `).run(gamePkKey, gamePk, pastTime.slice(0, 10));
  }
  if (gamePk != null) {
    const scheduledKey = `${pastTime}|${homeTeam}|${awayTeam}`;
    db.prepare(`
      INSERT OR REPLACE INTO mlb_probable_starter_map (
        game_pk_key,
        game_pk,
        game_date,
        scheduled_start_utc,
        home_team_abbr,
        away_team_abbr
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(scheduledKey, gamePk, pastTime.slice(0, 10), pastTime, homeTeam, awayTeam);
  }
}

function insertFinalGameResult(db, gameId) {
  db.prepare(
    `
      INSERT OR REPLACE INTO game_results (
        id,
        game_id,
        sport,
        status,
        result_source,
        final_score_home,
        final_score_away,
        metadata
      ) VALUES (?, ?, 'mlb', 'final', 'primary_api', 5, 3, '{}')
    `,
  ).run(`gr-${gameId}`, gameId);
}

function mockMlbFetchByGamePk(payloadByGamePk) {
  global.fetch = jest.fn(async (url) => {
    const match = String(url).match(/\/game\/(\d+)\/feed\/live/);
    const gamePk = match?.[1];
    const payload = payloadByGamePk[gamePk];
    return payload
      ? { ok: true, json: async () => payload }
      : { ok: false, json: async () => ({}) };
  });
}

describe('settleMlbF5 integration', () => {
  let originalFetch;

  beforeAll(async () => {
    process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS = 'false';

    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);

    // Run migrations once to create the schema
    const { runMigrations, closeDatabase } = require('@cheddar-logic/data');
    await runMigrations();
    // Close after migration so withDb can re-open as needed
    closeDatabase();
  });

  afterAll(() => {
    const { closeDatabase } = require('@cheddar-logic/data');
    try { closeDatabase(); } catch { /* best effort */ }
    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);
  });

  beforeEach(() => {
    originalFetch = global.fetch;
    const { getDatabase, closeDatabase } = require('@cheddar-logic/data');
    const db = getDatabase();
    db.exec(`
      DELETE FROM card_results;
      DELETE FROM card_payloads;
      DELETE FROM game_results;
      DELETE FROM games;
      DROP TABLE IF EXISTS mlb_game_pk_map;
      DROP TABLE IF EXISTS mlb_probable_starter_map;
    `);
    closeDatabase();

    // Default mock: complete 5-inning game, F5 total = 8
    const payload = buildLinescorePayload([[2, 1], [0, 0], [1, 0], [0, 1], [3, 0]]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });
  });

  afterEach(() => {
    if (originalFetch !== undefined) {
      global.fetch = originalFetch;
    } else {
      delete global.fetch;
    }
    // Ensure DB is closed between tests so each settleMlbF5 call starts fresh
    const { closeDatabase } = require('@cheddar-logic/data');
    try { closeDatabase(); } catch { /* best effort */ }
  });

  test('settles a pending F5 card when gamePk resolves and API returns total', async () => {
    const gameId = 'mlb-f5-settle-test-1';
    const pastTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const gameDate = pastTime.slice(0, 10);

    // Open DB, insert scenario, close so withDb can re-open cleanly
    const { getDatabase, closeDatabase } = require('@cheddar-logic/data');
    const db = getDatabase();
    insertF5Scenario(db, {
      gameId,
      cardId: `card-${gameId}`,
      resultId: `result-${gameId}`,
      marketKey: `${gameId}:mlb_f5_total`,
      payloadMarketKey: 'mlb_f5_total',
      gamePkKey: `${gameDate}|BOS|NYY`,
      gamePk: 745398,
    });
    closeDatabase();

    const result = await settleMlbF5({ dryRun: true });
    expect(result.success).toBe(true);
    expect(result.settled).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
  });

  test('skips non-F5 card_type even when market_key resembles F5', async () => {
    const gameId = 'mlb-skip-test-1';
    const pastTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const gameDate = pastTime.slice(0, 10);

    const { getDatabase, closeDatabase } = require('@cheddar-logic/data');
    const db = getDatabase();
    insertF5Scenario(db, {
      gameId,
      cardId: `card-${gameId}`,
      resultId: `result-${gameId}`,
      cardType: 'mlb-full-game',
      marketKey: `${gameId}:mlb_f5_total`,
      payloadMarketKey: 'mlb_f5_total',
      homeTeam: 'CHC',
      awayTeam: 'STL',
      gamePkKey: `${gameDate}|CHC|STL`,
      gamePk: 745399,
    });

    // Verify the card starts as pending before settlement run
    const rowBefore = db.prepare(
      `SELECT status FROM card_results WHERE id = ?`
    ).get(`result-${gameId}`);
    expect(rowBefore.status).toBe('pending');
    closeDatabase();

    const result = await settleMlbF5({ dryRun: true });
    expect(result.success).toBe(true);
    expect(result.settled).toBe(0);

    // Re-open DB to verify the non-F5 card_type was skipped.
    const db2 = getDatabase();
    const rowAfter = db2.prepare(
      `SELECT status FROM card_results WHERE id = ?`
    ).get(`result-${gameId}`);
    expect(rowAfter.status).toBe('pending');
    closeDatabase();
  });

  test('counts as failed when gamePk missing from mlb_game_pk_map', async () => {
    const gameId = 'mlb-f5-no-pk-test-1';

    const { getDatabase, closeDatabase } = require('@cheddar-logic/data');
    const db = getDatabase();
    insertF5Scenario(db, {
      gameId,
      cardId: `card-${gameId}`,
      resultId: `result-${gameId}`,
      marketKey: `${gameId}:mlb_f5_total`,
      payloadMarketKey: 'mlb_f5_total',
      homeTeam: 'LAD',
      awayTeam: 'SF',
      // No gamePkKey / gamePk — simulates missing map entry for LAD|SF
    });
    closeDatabase();

    const result = await settleMlbF5({ dryRun: true });
    expect(result.success).toBe(true);
    expect(result.failed).toBeGreaterThanOrEqual(1);
  });

  test('WI-0913 Spike: uses f5_market_line from payload when available', async () => {
    const gameId = 'mlb-f5-spike-payload-line-test';
    const pastTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

    const { getDatabase, closeDatabase } = require('@cheddar-logic/data');
    const db = getDatabase();

    const cardId = `card-${gameId}`;
    const resultId = `result-${gameId}`;
    const marketKey = `${gameId}:mlb_f5_total`;

    // Use helper to create base scenario
    insertF5Scenario(db, {
      gameId,
      cardId,
      resultId,
      marketKey,
      payloadMarketKey: 'mlb_f5_total',
      gamePkKey: `${pastTime.slice(0, 10)}|BOS|NYY`,
      gamePk: 745398,
    });

    // Update the payload to inject f5_market_line (spike fetcher result)
    // Original f5_line=7.5 is kept, but f5_market_line takes precedence in settlement
    const payloadWithSpikeResult = JSON.stringify({
      prediction: 'OVER',
      f5_line: 7.5,
      market_key: 'mlb_f5_total',
      market: null,
      f5_market_line: {
        line: 7.5,
        source: 'vsin_spike',
        fetched_at: pastTime,
        confidence: 0.95,
      },
    });
    db.prepare(`UPDATE card_payloads SET payload_data = ? WHERE id = ?`).run(payloadWithSpikeResult, cardId);

    // Mock fetch returns F5 total of 8 (actual game runs)
    const payload = buildLinescorePayload([[2, 1], [0, 0], [1, 0], [0, 1], [3, 0]]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });

    closeDatabase();

    // Run settlement
    const result = await settleMlbF5({ dryRun: false });
    expect(result.success).toBe(true);

    // Verify: Actual F5 = 8, prediction = OVER, spike line = 7.5 → 8 > 7.5 → "won"
    const db2 = getDatabase();
    const settledCard = db2.prepare(
      `SELECT status, result FROM card_results WHERE id = ?`
    ).get(resultId);
    expect(settledCard.status).toBe('settled');
    expect(settledCard.result).toBe('win');
    closeDatabase();
  });

  test('e2e single path: settle_pending_cards leaves F5 pending, settle_mlb_f5 performs the only terminal write', async () => {
    const gameId = 'mlb-f5-e2e-single-path';
    const pastTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const gameDate = pastTime.slice(0, 10);

    const { getDatabase, closeDatabase } = require('@cheddar-logic/data');
    const db = getDatabase();
    const cardId = `card-${gameId}`;
    const resultId = `result-${gameId}`;

    insertF5Scenario(db, {
      gameId,
      cardId,
      resultId,
      marketKey: `${gameId}:mlb_f5_total`,
      payloadMarketKey: 'mlb_f5_total',
      gamePkKey: `${gameDate}|BOS|NYY`,
      gamePk: 745398,
    });
    insertFinalGameResult(db, gameId);
    closeDatabase();

    const pendingJobResult = await settlePendingCards({ dryRun: false });
    expect(pendingJobResult.success).toBe(true);

    const dbAfterPending = getDatabase();
    const afterPending = dbAfterPending
      .prepare('SELECT status, result FROM card_results WHERE id = ?')
      .get(resultId);
    expect(afterPending.status).toBe('pending');
    expect(afterPending.result).toBeNull();
    closeDatabase();

    const f5JobResult = await settleMlbF5({ dryRun: false });
    expect(f5JobResult.success).toBe(true);
    expect(f5JobResult.settled).toBeGreaterThanOrEqual(1);

    const dbAfterF5 = getDatabase();
    const finalRow = dbAfterF5
      .prepare('SELECT status, result, settled_at FROM card_results WHERE id = ?')
      .get(resultId);
    expect(finalRow.status).toBe('settled');
    expect(['win', 'loss', 'push']).toContain(finalRow.result);
    expect(finalRow.settled_at).toBeTruthy();
    closeDatabase();
  });

  test('idempotent terminal write guard: second settle run does not mutate already-settled F5 row', async () => {
    const gameId = 'mlb-f5-idempotent-write';
    const pastTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const gameDate = pastTime.slice(0, 10);

    const { getDatabase, closeDatabase } = require('@cheddar-logic/data');
    const db = getDatabase();
    const resultId = `result-${gameId}`;

    insertF5Scenario(db, {
      gameId,
      cardId: `card-${gameId}`,
      resultId,
      marketKey: `${gameId}:mlb_f5_total`,
      payloadMarketKey: 'mlb_f5_total',
      gamePkKey: `${gameDate}|BOS|NYY`,
      gamePk: 745398,
    });
    closeDatabase();

    const firstRun = await settleMlbF5({ dryRun: false });
    expect(firstRun.success).toBe(true);
    expect(firstRun.settled).toBeGreaterThanOrEqual(1);

    const dbAfterFirstRun = getDatabase();
    const firstRow = dbAfterFirstRun
      .prepare('SELECT status, result, settled_at FROM card_results WHERE id = ?')
      .get(resultId);
    expect(firstRow.status).toBe('settled');
    expect(['win', 'loss', 'push']).toContain(firstRow.result);
    expect(firstRow.settled_at).toBeTruthy();
    const firstSettledAt = firstRow.settled_at;
    closeDatabase();

    const secondRun = await settleMlbF5({ dryRun: false });
    expect(secondRun.success).toBe(true);
    expect(secondRun.settled).toBe(0);

    const dbAfterSecondRun = getDatabase();
    const secondRow = dbAfterSecondRun
      .prepare('SELECT status, result, settled_at FROM card_results WHERE id = ?')
      .get(resultId);
    expect(secondRow.status).toBe('settled');
    expect(secondRow.result).toBe(firstRow.result);
    expect(secondRow.settled_at).toBe(firstSettledAt);
    closeDatabase();
  });

  test('settles mlb-f5-ml HOME selection as win from F5 scoreboard state without line', async () => {
    const gameId = 'mlb-f5-ml-home-win';
    const pastTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const gameDate = pastTime.slice(0, 10);

    const { getDatabase, closeDatabase } = require('@cheddar-logic/data');
    const db = getDatabase();
    const resultId = `result-${gameId}`;
    insertF5Scenario(db, {
      gameId,
      cardId: `card-${gameId}`,
      resultId,
      cardType: 'mlb-f5-ml',
      marketType: 'MONEYLINE',
      recommendedBetType: 'moneyline',
      marketKey: `${gameId}:mlb_f5_ml`,
      payloadMarketKey: 'mlb_f5_ml',
      selection: 'HOME',
      selectionSide: 'HOME',
      line: null,
      gamePkKey: `${gameDate}|BOS|NYY`,
      gamePk: 745501,
    });
    closeDatabase();

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => buildLinescorePayload([[1, 0], [0, 1], [2, 0], [0, 0], [1, 0]]),
    });

    const result = await settleMlbF5({ dryRun: false });
    expect(result.success).toBe(true);

    const dbAfter = getDatabase();
    const row = dbAfter
      .prepare('SELECT status, result, primary_reason_code FROM card_results WHERE id = ?')
      .get(resultId);
    expect(row).toEqual({
      status: 'settled',
      result: 'win',
      primary_reason_code: REASON_CODES.HOME_LEADING,
    });
    closeDatabase();
  });

  test('settles mlb-f5-ml AWAY selection as win and tied F5 snapshot as push', async () => {
    const pastTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const gameDate = pastTime.slice(0, 10);
    const { getDatabase, closeDatabase } = require('@cheddar-logic/data');
    const db = getDatabase();

    insertF5Scenario(db, {
      gameId: 'mlb-f5-ml-away-win',
      cardId: 'card-mlb-f5-ml-away-win',
      resultId: 'result-mlb-f5-ml-away-win',
      cardType: 'mlb-f5-ml',
      marketType: 'MONEYLINE',
      recommendedBetType: 'moneyline',
      marketKey: 'mlb-f5-ml-away-win:mlb_f5_ml',
      payloadMarketKey: 'mlb_f5_ml',
      selection: 'AWAY',
      selectionSide: 'AWAY',
      line: null,
      gamePkKey: `${gameDate}|BOS|NYY`,
      gamePk: 745502,
    });
    insertF5Scenario(db, {
      gameId: 'mlb-f5-ml-push',
      cardId: 'card-mlb-f5-ml-push',
      resultId: 'result-mlb-f5-ml-push',
      cardType: 'mlb-f5-ml',
      marketType: 'MONEYLINE',
      recommendedBetType: 'moneyline',
      marketKey: 'mlb-f5-ml-push:mlb_f5_ml',
      payloadMarketKey: 'mlb_f5_ml',
      homeTeam: 'CHC',
      awayTeam: 'STL',
      selection: 'HOME',
      selectionSide: 'HOME',
      line: null,
      gamePkKey: `${gameDate}|CHC|STL`,
      gamePk: 745503,
    });
    closeDatabase();

    mockMlbFetchByGamePk({
      745502: buildLinescorePayload([[0, 1], [0, 0], [1, 2], [0, 0], [0, 0]]),
      745503: buildLinescorePayload([[1, 1], [0, 0], [1, 1], [0, 0], [0, 0]]),
    });

    const result = await settleMlbF5({ dryRun: false });
    expect(result.success).toBe(true);

    const dbAfter = getDatabase();
    expect(
      dbAfter
        .prepare('SELECT result, primary_reason_code FROM card_results WHERE id = ?')
        .get('result-mlb-f5-ml-away-win'),
    ).toEqual({
      result: 'win',
      primary_reason_code: REASON_CODES.AWAY_LEADING,
    });
    expect(
      dbAfter
        .prepare('SELECT result, primary_reason_code FROM card_results WHERE id = ?')
        .get('result-mlb-f5-ml-push'),
    ).toEqual({
      result: 'push',
      primary_reason_code: REASON_CODES.TIED_PUSH,
    });
    closeDatabase();
  });

  test('resolves same-team doubleheaders by scheduled start instead of date matchup fallback', async () => {
    const gameDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const earlyStart = `${gameDate}T17:05:00.000Z`;
    const lateStart = `${gameDate}T23:05:00.000Z`;
    const { getDatabase, closeDatabase } = require('@cheddar-logic/data');
    const db = getDatabase();

    insertF5Scenario(db, {
      gameId: 'mlb-f5-ml-doubleheader-early',
      cardId: 'card-mlb-f5-ml-doubleheader-early',
      resultId: 'result-mlb-f5-ml-doubleheader-early',
      cardType: 'mlb-f5-ml',
      marketType: 'MONEYLINE',
      recommendedBetType: 'moneyline',
      marketKey: 'mlb-f5-ml-doubleheader-early:mlb_f5_ml',
      payloadMarketKey: 'mlb_f5_ml',
      selection: 'HOME',
      selectionSide: 'HOME',
      line: null,
      homeTeam: 'BOS',
      awayTeam: 'NYY',
      gameTimeUtc: earlyStart,
      gamePk: 745601,
    });
    insertF5Scenario(db, {
      gameId: 'mlb-f5-ml-doubleheader-late',
      cardId: 'card-mlb-f5-ml-doubleheader-late',
      resultId: 'result-mlb-f5-ml-doubleheader-late',
      cardType: 'mlb-f5-ml',
      marketType: 'MONEYLINE',
      recommendedBetType: 'moneyline',
      marketKey: 'mlb-f5-ml-doubleheader-late:mlb_f5_ml',
      payloadMarketKey: 'mlb_f5_ml',
      selection: 'HOME',
      selectionSide: 'HOME',
      line: null,
      homeTeam: 'BOS',
      awayTeam: 'NYY',
      gameTimeUtc: lateStart,
      gamePk: 745602,
    });
    closeDatabase();

    mockMlbFetchByGamePk({
      745601: buildLinescorePayload([[1, 0], [0, 1], [2, 0], [0, 0], [1, 0]]),
      745602: buildLinescorePayload([[0, 1], [0, 0], [1, 2], [0, 0], [0, 0]]),
    });

    const result = await settleMlbF5({ dryRun: false });
    expect(result.success).toBe(true);
    expect(result.settled).toBe(2);

    const dbAfter = getDatabase();
    expect(
      dbAfter
        .prepare('SELECT result, primary_reason_code FROM card_results WHERE id = ?')
        .get('result-mlb-f5-ml-doubleheader-early'),
    ).toEqual({
      result: 'win',
      primary_reason_code: REASON_CODES.HOME_LEADING,
    });
    expect(
      dbAfter
        .prepare('SELECT result, primary_reason_code FROM card_results WHERE id = ?')
        .get('result-mlb-f5-ml-doubleheader-late'),
    ).toEqual({
      result: 'loss',
      primary_reason_code: REASON_CODES.AWAY_LEADING,
    });
    closeDatabase();
  });

  test('pending F5 rows are processed before settled correction-only rows hit the batch limit', async () => {
    const gameDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { getDatabase, closeDatabase } = require('@cheddar-logic/data');
    const db = getDatabase();

    for (let i = 0; i < 55; i += 1) {
      const suffix = String(i).padStart(2, '0');
      insertF5Scenario(db, {
        gameId: `mlb-f5-settled-${suffix}`,
        cardId: `card-mlb-f5-settled-${suffix}`,
        resultId: `result-mlb-f5-settled-${suffix}`,
        marketKey: `mlb-f5-settled-${suffix}:mlb_f5_total`,
        payloadMarketKey: 'mlb_f5_total',
        status: 'settled',
        result: 'win',
        settledAt: `${gameDate}T20:00:00.000Z`,
        gamePk: 745700 + i,
      });
    }
    insertF5Scenario(db, {
      gameId: 'mlb-f5-pending-priority',
      cardId: 'card-mlb-f5-pending-priority',
      resultId: 'result-mlb-f5-pending-priority',
      marketKey: 'mlb-f5-pending-priority:mlb_f5_total',
      payloadMarketKey: 'mlb_f5_total',
      gamePk: 745800,
    });
    closeDatabase();

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => buildLinescorePayload([[2, 1], [0, 0], [1, 0], [0, 1], [3, 0]]),
    });

    const result = await settleMlbF5({ dryRun: false });
    expect(result.success).toBe(true);
    expect(result.settled).toBe(1);

    const dbAfter = getDatabase();
    expect(
      dbAfter
        .prepare('SELECT status, result FROM card_results WHERE id = ?')
        .get('result-mlb-f5-pending-priority'),
    ).toEqual({ status: 'settled', result: 'win' });
    closeDatabase();
  });

  test('F5 total tied side-score still grades by total line, not ML push logic', async () => {
    const gameId = 'mlb-f5-total-tied-score-over';
    const pastTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const gameDate = pastTime.slice(0, 10);

    const { getDatabase, closeDatabase } = require('@cheddar-logic/data');
    const db = getDatabase();
    insertF5Scenario(db, {
      gameId,
      cardId: `card-${gameId}`,
      resultId: `result-${gameId}`,
      marketKey: `${gameId}:mlb_f5_total`,
      payloadMarketKey: 'mlb_f5_total',
      prediction: 'OVER',
      selection: 'OVER',
      line: 3.5,
      gamePkKey: `${gameDate}|BOS|NYY`,
      gamePk: 745603,
    });
    closeDatabase();

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => buildLinescorePayload([[1, 1], [0, 0], [1, 1], [0, 0], [0, 0]]),
    });

    const result = await settleMlbF5({ dryRun: false });
    expect(result.success).toBe(true);

    const dbAfter = getDatabase();
    expect(
      dbAfter
        .prepare('SELECT result, primary_reason_code FROM card_results WHERE id = ?')
        .get(`result-${gameId}`),
    ).toEqual({
      result: 'win',
      primary_reason_code: REASON_CODES.TOTAL_OVER,
    });
    closeDatabase();
  });

  test('keeps not-yet-eligible F5 ML pending and settles unverified snapshots as no_contest', async () => {
    const pastTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const gameDate = pastTime.slice(0, 10);
    const { getDatabase, closeDatabase } = require('@cheddar-logic/data');
    const db = getDatabase();

    insertF5Scenario(db, {
      gameId: 'mlb-f5-ml-not-ready',
      cardId: 'card-mlb-f5-ml-not-ready',
      resultId: 'result-mlb-f5-ml-not-ready',
      cardType: 'mlb-f5-ml',
      marketType: 'MONEYLINE',
      recommendedBetType: 'moneyline',
      marketKey: 'mlb-f5-ml-not-ready:mlb_f5_ml',
      payloadMarketKey: 'mlb_f5_ml',
      selection: 'HOME',
      selectionSide: 'HOME',
      line: null,
      gamePkKey: `${gameDate}|BOS|NYY`,
      gamePk: 745504,
    });
    insertF5Scenario(db, {
      gameId: 'mlb-f5-ml-unverified',
      cardId: 'card-mlb-f5-ml-unverified',
      resultId: 'result-mlb-f5-ml-unverified',
      cardType: 'mlb-f5-ml',
      marketType: 'MONEYLINE',
      recommendedBetType: 'moneyline',
      marketKey: 'mlb-f5-ml-unverified:mlb_f5_ml',
      payloadMarketKey: 'mlb_f5_ml',
      homeTeam: 'CHC',
      awayTeam: 'STL',
      selection: 'HOME',
      selectionSide: 'HOME',
      line: null,
      gamePkKey: `${gameDate}|CHC|STL`,
      gamePk: 745505,
    });
    closeDatabase();

    const notReadyPayload = buildLinescorePayload([[1, 0], [0, 1], [0, 0], [0, 0]]);
    const unverifiedPayload = buildLinescorePayload([[1, 0], [0, 1], [2, 0], [0, 0], [1, 0]]);
    unverifiedPayload.liveData.plays.currentPlay.about.endTime = new Date().toISOString();

    mockMlbFetchByGamePk({
      745504: notReadyPayload,
      745505: unverifiedPayload,
    });

    const result = await settleMlbF5({ dryRun: false });
    expect(result.success).toBe(true);

    const dbAfter = getDatabase();
    expect(
      dbAfter
        .prepare('SELECT status, result FROM card_results WHERE id = ?')
        .get('result-mlb-f5-ml-not-ready'),
    ).toEqual({ status: 'pending', result: null });
    expect(
      dbAfter
        .prepare('SELECT status, result, primary_reason_code FROM card_results WHERE id = ?')
        .get('result-mlb-f5-ml-unverified'),
    ).toEqual({
      status: 'settled',
      result: 'no_contest',
      primary_reason_code: REASON_CODES.UNVERIFIED,
    });
    closeDatabase();
  });

  test('missing F5 ML selection side stays pending with explicit reason code', async () => {
    const gameId = 'mlb-f5-ml-missing-side';
    const pastTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const gameDate = pastTime.slice(0, 10);

    const { getDatabase, closeDatabase } = require('@cheddar-logic/data');
    const db = getDatabase();
    insertF5Scenario(db, {
      gameId,
      cardId: `card-${gameId}`,
      resultId: `result-${gameId}`,
      cardType: 'mlb-f5-ml',
      marketType: 'MONEYLINE',
      recommendedBetType: 'moneyline',
      marketKey: `${gameId}:mlb_f5_ml`,
      payloadMarketKey: 'mlb_f5_ml',
      selection: null,
      selectionSide: null,
      line: null,
      gamePkKey: `${gameDate}|BOS|NYY`,
      gamePk: 745506,
    });
    closeDatabase();

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => buildLinescorePayload([[1, 0], [0, 1], [2, 0], [0, 0], [1, 0]]),
    });

    const result = await settleMlbF5({ dryRun: false });
    expect(result.success).toBe(true);
    expect(result.failed).toBe(1);

    const dbAfter = getDatabase();
    expect(
      dbAfter
        .prepare('SELECT status, result, primary_reason_code FROM card_results WHERE id = ?')
        .get(`result-${gameId}`),
    ).toEqual({
      status: 'pending',
      result: null,
      primary_reason_code: REASON_CODES.SIDE_MISSING,
    });
    closeDatabase();
  });

  test('already-settled F5 ML feed correction is detected without overwriting result', async () => {
    const gameId = 'mlb-f5-ml-correction';
    const pastTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const gameDate = pastTime.slice(0, 10);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { getDatabase, closeDatabase } = require('@cheddar-logic/data');
    const db = getDatabase();
    insertF5Scenario(db, {
      gameId,
      cardId: `card-${gameId}`,
      resultId: `result-${gameId}`,
      cardType: 'mlb-f5-ml',
      marketType: 'MONEYLINE',
      recommendedBetType: 'moneyline',
      marketKey: `${gameId}:mlb_f5_ml`,
      payloadMarketKey: 'mlb_f5_ml',
      selection: 'HOME',
      selectionSide: 'HOME',
      line: null,
      status: 'settled',
      result: 'win',
      settledAt: new Date(Date.now() - 60_000).toISOString(),
      gamePkKey: `${gameDate}|BOS|NYY`,
      gamePk: 745507,
    });
    closeDatabase();

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => buildLinescorePayload([[0, 1], [0, 0], [1, 2], [0, 0], [0, 0]]),
    });

    const result = await settleMlbF5({ dryRun: false });
    expect(result.success).toBe(true);
    expect(result.corrections).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(REASON_CODES.CORRECTION));

    const dbAfter = getDatabase();
    expect(
      dbAfter
        .prepare('SELECT status, result FROM card_results WHERE id = ?')
        .get(`result-${gameId}`),
    ).toEqual({ status: 'settled', result: 'win' });
    closeDatabase();
    warnSpy.mockRestore();
  });
});
