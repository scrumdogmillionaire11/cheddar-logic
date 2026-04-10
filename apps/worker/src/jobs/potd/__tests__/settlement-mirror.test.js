'use strict';

const fs = require('fs');
const Database = require('better-sqlite3');

const TEST_DB_PATH = '/tmp/cheddar-test-potd-settlement.db';
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

function seedPublishedPlay({
  result = 'won',
  pnlUnits = 0.9,
  lockedPrice = -110,
  wagerAmount = 2.5,
  line = 5.5,
} = {}) {
  const db = new Database(TEST_DB_PATH);
  db.prepare(
    `UPDATE card_results
     SET status = 'settled', result = ?, settled_at = ?, pnl_units = ?, locked_price = ?, line = ?
     WHERE card_type = 'potd-call'`,
  ).run(
    result,
    '2026-04-10T03:00:00.000Z',
    pnlUnits,
    lockedPrice,
    line,
  );
  db.prepare(
    `UPDATE potd_plays
     SET price = ?, wager_amount = ?
     WHERE card_id IN (SELECT card_id FROM card_results WHERE card_type = 'potd-call' LIMIT 1)`,
  ).run(lockedPrice, wagerAmount);
  db.close();
}

function readRows(sql, params = []) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  const rows = db.prepare(sql).all(...params);
  db.close();
  return rows;
}

describe('mirrorPotdSettlement', () => {
  let dataModule;

  async function publishPlay({ price = -110 } = {}) {
    const { runPotdEngine } = require('../run_potd_engine');
    const candidate = {
      gameId: 'potd-game-001',
      sport: 'NHL',
      home_team: 'Boston Bruins',
      away_team: 'Toronto Maple Leafs',
      commence_time: '2035-04-10T00:00:00.000Z',
      marketType: 'TOTAL',
      selection: 'OVER',
      selectionLabel: 'OVER 5.5',
      line: 5.5,
      price,
      oddsContext: {
        total: 5.5,
        total_price_over: price,
        total_price_under: -110,
        captured_at: '2026-04-09T18:00:00.000Z',
      },
      totalScore: 0.73,
      modelWinProb: 0.49,
      impliedProb: 0.46,
      edgePct: 0.03,
      confidenceLabel: 'HIGH',
      scoreBreakdown: { lineValue: 0.8, marketConsensus: 0.6 },
    };

    const result = await runPotdEngine({
      jobKey: 'potd|settlement-seed',
      fetchOddsFn: async () => ({ games: [{ gameId: candidate.gameId }], errors: [] }),
      buildCandidatesFn: () => [candidate],
      scoreCandidateFn: (value) => value,
      selectBestPlayFn: (values) => values[0],
      kellySizeFn: () => 2.5,
      sendDiscordMessagesFn: async () => 1,
      nowFn: () => ({
        toUTC: () => ({ toISO: () => '2026-04-09T18:00:00.000Z' }),
        toISODate: () => '2026-04-09',
      }),
    });

    return result;
  }

  beforeAll(async () => {
    process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS = 'false';
    process.env.POTD_STARTING_BANKROLL = '10';

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
    delete process.env.POTD_STARTING_BANKROLL;
    try {
      dataModule.closeDatabase();
    } catch {
      // best effort
    }
  });

  test('mirrors settled card_results into potd tables once', async () => {
    await publishPlay({ price: -110 });
    seedPublishedPlay({ result: 'won', pnlUnits: 0.9, wagerAmount: 2.5, lockedPrice: -110 });

    const { mirrorPotdSettlement } = require('../settlement-mirror');
    const first = await mirrorPotdSettlement({ jobKey: 'potd-settlement|2026-04-09|18' });
    expect(first.success).toBe(true);
    expect(first.settled).toBe(1);

    const playRow = readRows(
      `SELECT result, settled_at, pnl_dollars FROM potd_plays LIMIT 1`,
    )[0];
    expect(playRow).toMatchObject({
      result: 'win',
      pnl_dollars: 2.25,
    });

    const ledgerRows = readRows(
      `SELECT event_type, amount_before, amount_change, amount_after
       FROM potd_bankroll
       ORDER BY created_at ASC, id ASC`,
    );
    expect(ledgerRows).toHaveLength(3);
    expect(ledgerRows[2]).toMatchObject({
      event_type: 'result_settled',
      amount_before: 10,
      amount_change: 2.25,
      amount_after: 12.25,
    });

    const second = await mirrorPotdSettlement({ jobKey: 'potd-settlement|2026-04-09|19' });
    expect(second.success).toBe(true);
    expect(second.settled).toBe(0);
    expect(readRows(`SELECT * FROM potd_bankroll WHERE event_type = 'result_settled'`)).toHaveLength(1);
  });

  test('falls back to locked price math when pnl_units is missing', async () => {
    await publishPlay({ price: 125 });
    seedPublishedPlay({ result: 'won', pnlUnits: null, lockedPrice: 125, wagerAmount: 2.5 });

    const { mirrorPotdSettlement } = require('../settlement-mirror');
    await mirrorPotdSettlement({ jobKey: 'potd-settlement|fallback' });

    const playRow = readRows(`SELECT pnl_dollars, result FROM potd_plays LIMIT 1`)[0];
    expect(playRow).toMatchObject({
      result: 'win',
      pnl_dollars: 3.13,
    });
  });
});
