'use strict';

const fs = require('fs');
const {
  gradeF5Card,
  fetchF5Total,
  settleMlbF5,
} = require('../settle_mlb_f5');

// ─────────────────────────────────────────────────────────────────────────────
// gradeF5Card — pure function unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('gradeF5Card', () => {
  test('OVER win: actual total exceeds line', () => {
    expect(gradeF5Card('OVER', 8.5, 10)).toBe('won');
  });

  test('OVER loss: actual total below line', () => {
    expect(gradeF5Card('OVER', 8.5, 7)).toBe('lost');
  });

  test('UNDER win: actual total below line', () => {
    expect(gradeF5Card('UNDER', 8.5, 7)).toBe('won');
  });

  test('UNDER loss: actual total exceeds line', () => {
    expect(gradeF5Card('UNDER', 8.5, 10)).toBe('lost');
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
  return {
    liveData: {
      linescore: {
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
 * @param {string} [opts.gamePkKey] - key for mlb_game_pk_map (omit to test missing entry)
 * @param {number} [opts.gamePk]   - value for mlb_game_pk_map
 */
function insertF5Scenario(db, {
  gameId,
  cardId,
  resultId,
  marketKey,
  payloadMarketKey,
  homeTeam = 'BOS',
  awayTeam = 'NYY',
  gamePkKey,
  gamePk,
}) {
  const pastTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

  // games row — sport must be lowercase per schema CHECK constraint
  db.prepare(`
    INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
    VALUES (?, 'mlb', ?, ?, ?, ?, 'scheduled')
  `).run(`g-${gameId}`, gameId, homeTeam, awayTeam, pastTime);

  // card_payloads row — payload includes prediction, f5_line, and market_key
  const payloadData = {
    prediction: 'OVER',
    f5_line: 7.5,
    market_key: payloadMarketKey,
    market: null,
  };
  db.prepare(`
    INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data)
    VALUES (?, ?, 'mlb', 'f5-total', 'Test F5 Card', ?, ?)
  `).run(cardId, gameId, pastTime, JSON.stringify(payloadData));

  // card_results row — sport must be lowercase per schema CHECK constraint
  db.prepare(`
    INSERT INTO card_results (
      id, card_id, game_id, sport, card_type, recommended_bet_type,
      status, market_key, market_type, selection, line, locked_price
    ) VALUES (?, ?, ?, 'mlb', 'f5-total', 'total', 'pending', ?, 'TOTAL', 'OVER', 7.5, -110)
  `).run(resultId, cardId, gameId, marketKey);

  // mlb_game_pk_map table (created by pull_mlb_pitcher_stats, not a migration)
  db.exec(`
    CREATE TABLE IF NOT EXISTS mlb_game_pk_map (
      game_pk_key TEXT PRIMARY KEY,
      game_pk INTEGER NOT NULL,
      game_date TEXT
    )
  `);

  if (gamePkKey && gamePk != null) {
    db.prepare(`
      INSERT OR REPLACE INTO mlb_game_pk_map (game_pk_key, game_pk, game_date)
      VALUES (?, ?, ?)
    `).run(gamePkKey, gamePk, pastTime.slice(0, 10));
  }
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

  test('skips non-F5 cards (market_key does not include "f5")', async () => {
    const gameId = 'mlb-skip-test-1';
    const pastTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const gameDate = pastTime.slice(0, 10);

    const { getDatabase, closeDatabase } = require('@cheddar-logic/data');
    const db = getDatabase();
    insertF5Scenario(db, {
      gameId,
      cardId: `card-${gameId}`,
      resultId: `result-${gameId}`,
      marketKey: `${gameId}:mlb_totals`,
      payloadMarketKey: 'mlb_totals',  // does NOT include 'f5'
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

    // Re-open DB to verify the non-F5 card was skipped (still pending)
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
});
