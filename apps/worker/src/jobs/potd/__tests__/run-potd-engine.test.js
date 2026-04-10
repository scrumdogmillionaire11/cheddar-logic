'use strict';

const fs = require('fs');
const Database = require('better-sqlite3');

const TEST_DB_PATH = '/tmp/cheddar-test-run-potd-engine.db';
const LOCK_PATH = `${TEST_DB_PATH}.lock`;

function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best effort
  }
}

function resetTables() {
  const db = new Database(TEST_DB_PATH);
  db.exec(`
    DELETE FROM potd_bankroll;
    DELETE FROM potd_plays;
    DELETE FROM card_results;
    DELETE FROM card_payloads;
    DELETE FROM games;
    DELETE FROM job_runs;
  `);
  db.close();
}

function readRows(sql, params = []) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  const rows = db.prepare(sql).all(...params);
  db.close();
  return rows;
}

function buildSelectedCandidate(overrides = {}) {
  return {
    gameId: 'potd-game-001',
    sport: 'NHL',
    home_team: 'Boston Bruins',
    away_team: 'Toronto Maple Leafs',
    commence_time: '2026-04-10T00:00:00.000Z',
    marketType: 'TOTAL',
    selection: 'OVER',
    selectionLabel: 'OVER 5.5',
    line: 5.5,
    price: 115,
    oddsContext: {
      total: 5.5,
      total_price_over: 115,
      total_price_under: -122,
      captured_at: '2026-04-09T18:00:00.000Z',
    },
    totalScore: 0.73,
    modelWinProb: 0.49,
    impliedProb: 0.465,
    edgePct: 0.025,
    confidenceLabel: 'HIGH',
    scoreBreakdown: {
      lineValue: 0.81,
      marketConsensus: 0.59,
    },
    ...overrides,
  };
}

describe('runPotdEngine', () => {
  let dataModule;

  beforeAll(async () => {
    process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS = 'false';
    process.env.POTD_STARTING_BANKROLL = '10';
    process.env.POTD_KELLY_FRACTION = '0.25';
    process.env.POTD_MAX_WAGER_PCT = '0.2';
    process.env.DISCORD_POTD_WEBHOOK_URL = 'https://discord.example/potd';

    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);

    dataModule = require('@cheddar-logic/data');
    await dataModule.runMigrations();
    dataModule.closeDatabase();
  });

  beforeEach(() => {
    dataModule.closeDatabase();
    resetTables();
  });

  afterAll(() => {
    try {
      dataModule.closeDatabase();
    } catch {
      // best effort
    }
  });

  test('no-play day exits cleanly without writing POTD rows', async () => {
    const { runPotdEngine } = require('../run_potd_engine');

    const result = await runPotdEngine({
      jobKey: 'potd|2026-04-09',
      fetchOddsFn: async () => ({ games: [], errors: [] }),
    });

    expect(result.success).toBe(true);
    expect(result.noPlay).toBe(true);
    expect(readRows('SELECT * FROM potd_plays')).toEqual([]);
    expect(readRows('SELECT * FROM potd_bankroll')).toHaveLength(1);
  });

  test('seeds bankroll and writes published TOTAL play plus settlement-compatible potd-call', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const candidate = buildSelectedCandidate();

    const result = await runPotdEngine({
      jobKey: 'potd|2026-04-09',
      fetchOddsFn: async () => ({
        games: [{ gameId: candidate.gameId }],
        errors: [],
      }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (value) => value,
      selectBestPlayFn: (values) => values[0],
      kellySizeFn: () => 2.5,
      sendDiscordMessagesFn: async () => 1,
    });

    expect(result.success).toBe(true);
    expect(result.discordPosted).toBe(true);

    const bankrollRows = readRows(
      `SELECT event_type, amount_before, amount_change, amount_after
       FROM potd_bankroll
       ORDER BY created_at ASC, id ASC`,
    );
    expect(bankrollRows).toEqual([
      {
        event_type: 'initial',
        amount_before: 0,
        amount_change: 10,
        amount_after: 10,
      },
      {
        event_type: 'play_posted',
        amount_before: 10,
        amount_change: 0,
        amount_after: 10,
      },
    ]);

    const playRows = readRows(
      `SELECT play_date, card_id, market_type, selection, wager_amount, bankroll_at_post, discord_posted
       FROM potd_plays`,
    );
    expect(playRows).toHaveLength(1);
    expect(playRows[0]).toMatchObject({
      market_type: 'TOTAL',
      selection: 'OVER',
      wager_amount: 2.5,
      bankroll_at_post: 10,
      discord_posted: 1,
    });

    const cardResult = readRows(
      `SELECT market_type, selection, line, locked_price
       FROM card_results
       WHERE card_id = ?`,
      [playRows[0].card_id],
    )[0];
    expect(cardResult).toMatchObject({
      market_type: 'TOTAL',
      selection: 'OVER',
      line: 5.5,
      locked_price: 115,
    });
  });

  test.each([
    [
      'SPREAD',
      buildSelectedCandidate({
        marketType: 'SPREAD',
        selection: 'HOME',
        selectionLabel: 'Boston Bruins -1.5',
        line: -1.5,
        price: -108,
        oddsContext: {
          spread_home: -1.5,
          spread_away: 1.5,
          spread_price_home: -108,
          spread_price_away: -112,
          captured_at: '2026-04-09T18:00:00.000Z',
        },
      }),
      { market_type: 'SPREAD', selection: 'HOME', line: -1.5, locked_price: -108 },
    ],
    [
      'MONEYLINE',
      buildSelectedCandidate({
        marketType: 'MONEYLINE',
        selection: 'AWAY',
        selectionLabel: 'Toronto Maple Leafs',
        line: null,
        price: 125,
        oddsContext: {
          h2h_home: -135,
          h2h_away: 125,
          captured_at: '2026-04-09T18:00:00.000Z',
        },
      }),
      { market_type: 'MONEYLINE', selection: 'AWAY', line: null, locked_price: 125 },
    ],
  ])('writes market contract fields for %s plays', async (_label, candidate, expected) => {
    const { runPotdEngine } = require('../run_potd_engine');

    const result = await runPotdEngine({
      jobKey: `potd|${candidate.marketType}`,
      fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (value) => value,
      selectBestPlayFn: (values) => values[0],
      kellySizeFn: () => 1.5,
      sendDiscordMessagesFn: async () => 1,
    });

    expect(result.success).toBe(true);
    const cardResult = readRows(
      `SELECT market_type, selection, line, locked_price
       FROM card_results
       WHERE card_id = ?`,
      [result.cardId],
    )[0];
    expect(cardResult).toMatchObject(expected);

    dataModule.closeDatabase();
    resetTables();
  });

  test('discord failure is non-fatal after DB commit', async () => {
    const { runPotdEngine } = require('../run_potd_engine');
    const candidate = buildSelectedCandidate();

    const result = await runPotdEngine({
      jobKey: 'potd|discord-failure',
      fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (value) => value,
      selectBestPlayFn: (values) => values[0],
      kellySizeFn: () => 2,
      sendDiscordMessagesFn: async () => {
        throw new Error('webhook down');
      },
    });

    expect(result.success).toBe(true);
    expect(result.discordPosted).toBe(false);
    expect(result.discordError).toBe('webhook down');

    const playRow = readRows(
      `SELECT discord_posted FROM potd_plays LIMIT 1`,
    )[0];
    expect(playRow.discord_posted).toBe(0);
  });
});
