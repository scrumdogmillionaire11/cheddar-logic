'use strict';
/**
 * WI-1017: Regression tests for avg_pnl_per_card denominator correctness.
 *
 * Verifies that push and no_contest rows are excluded from the avg_pnl_per_card
 * denominator (wins + losses + pushes), and that win_rate uses wins / (wins + losses).
 */
const fs = require('fs');
const {
  closeDatabase,
  runMigrations,
  insertProjectionAudit,
  recomputeTrackingStats,
  getDatabase,
} = require('@cheddar-logic/data');

const TEST_DB_PATH = '/tmp/cheddar-test-tracking-denominator.db';
const LOCK_PATH = `${TEST_DB_PATH}.lock`;

function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best-effort cleanup
  }
}

describe('WI-1017: tracking_stats denominator correctness', () => {
  beforeAll(async () => {
    process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS = 'false';

    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);

    await runMigrations();
  });

  afterAll(() => {
    closeDatabase();
    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);
  });

  beforeEach(() => {
    const db = getDatabase();
    db.prepare('DELETE FROM tracking_stats').run();
    db.prepare('DELETE FROM projection_audit').run();
  });

  function seedRow(overrides = {}) {
    insertProjectionAudit({
      cardResultId: `cr-${Math.random().toString(36).slice(2)}`,
      sport: 'MLB',
      marketType: 'f5_total',
      period: null,
      playerCount: null,
      confidenceScore: null,
      oddsAmerican: -110,
      sharpPriceStatus: 'CONFIRMED',
      direction: 'OVER',
      result: 'win',
      pnlUnits: 0.909,
      settledAt: new Date().toISOString(),
      jobRunId: null,
      metadata: null,
      ...overrides,
    });
  }

  test('win_rate uses wins/(wins+losses) — push and no_contest rows do not inflate denominator', () => {
    // 3 wins, 2 losses, 4 pushes, 5 no_contests
    seedRow({ cardResultId: 'cr-w1', result: 'win',       pnlUnits: 1.0 });
    seedRow({ cardResultId: 'cr-w2', result: 'win',       pnlUnits: 1.0 });
    seedRow({ cardResultId: 'cr-w3', result: 'win',       pnlUnits: 1.0 });
    seedRow({ cardResultId: 'cr-l1', result: 'loss',      pnlUnits: -1.0 });
    seedRow({ cardResultId: 'cr-l2', result: 'loss',      pnlUnits: -1.0 });
    seedRow({ cardResultId: 'cr-p1', result: 'push',      pnlUnits: 0.0 });
    seedRow({ cardResultId: 'cr-p2', result: 'push',      pnlUnits: 0.0 });
    seedRow({ cardResultId: 'cr-p3', result: 'push',      pnlUnits: 0.0 });
    seedRow({ cardResultId: 'cr-p4', result: 'push',      pnlUnits: 0.0 });
    seedRow({ cardResultId: 'cr-nc1', result: 'no_contest', pnlUnits: null });
    seedRow({ cardResultId: 'cr-nc2', result: 'no_contest', pnlUnits: null });
    seedRow({ cardResultId: 'cr-nc3', result: 'no_contest', pnlUnits: null });
    seedRow({ cardResultId: 'cr-nc4', result: 'no_contest', pnlUnits: null });
    seedRow({ cardResultId: 'cr-nc5', result: 'no_contest', pnlUnits: null });

    recomputeTrackingStats({ fullReplace: true });

    const db = getDatabase();
    const row = db
      .prepare('SELECT * FROM tracking_stats WHERE stat_key = ?')
      .get('MLB|f5_total|all|all|all|alltime');

    expect(row).toBeDefined();
    expect(row.wins).toBe(3);
    expect(row.losses).toBe(2);
    expect(row.pushes).toBe(4);

    // win_rate = 3 / (3 + 2) = 0.6 — not 3/14 which would mean no_contests counted
    expect(Math.abs(row.win_rate - 0.6)).toBeLessThan(0.0001);
  });

  test('avg_pnl_per_card uses (wins+losses+pushes) denominator — no_contest rows excluded', () => {
    // 3 wins (+1 each), 2 losses (-1 each), 4 pushes (0 each), 5 no_contests (null pnl)
    // totalPnl = 3 - 2 = 1; denominator = 3+2+4 = 9; expected avg = 1/9 ≈ 0.1111
    seedRow({ cardResultId: 'cr-w1', result: 'win',       pnlUnits: 1.0 });
    seedRow({ cardResultId: 'cr-w2', result: 'win',       pnlUnits: 1.0 });
    seedRow({ cardResultId: 'cr-w3', result: 'win',       pnlUnits: 1.0 });
    seedRow({ cardResultId: 'cr-l1', result: 'loss',      pnlUnits: -1.0 });
    seedRow({ cardResultId: 'cr-l2', result: 'loss',      pnlUnits: -1.0 });
    seedRow({ cardResultId: 'cr-p1', result: 'push',      pnlUnits: 0.0 });
    seedRow({ cardResultId: 'cr-p2', result: 'push',      pnlUnits: 0.0 });
    seedRow({ cardResultId: 'cr-p3', result: 'push',      pnlUnits: 0.0 });
    seedRow({ cardResultId: 'cr-p4', result: 'push',      pnlUnits: 0.0 });
    seedRow({ cardResultId: 'cr-nc1', result: 'no_contest', pnlUnits: null });
    seedRow({ cardResultId: 'cr-nc2', result: 'no_contest', pnlUnits: null });
    seedRow({ cardResultId: 'cr-nc3', result: 'no_contest', pnlUnits: null });
    seedRow({ cardResultId: 'cr-nc4', result: 'no_contest', pnlUnits: null });
    seedRow({ cardResultId: 'cr-nc5', result: 'no_contest', pnlUnits: null });

    recomputeTrackingStats({ fullReplace: true });

    const db = getDatabase();
    const row = db
      .prepare('SELECT * FROM tracking_stats WHERE stat_key = ?')
      .get('MLB|f5_total|all|all|all|alltime');

    expect(row).toBeDefined();

    const expected = 1.0 / 9.0; // totalPnl / (wins+losses+pushes)
    const wrongIfNoContestIncluded = 1.0 / 14.0; // what it would be with no_contests in denominator

    expect(Math.abs(row.avg_pnl_per_card - expected)).toBeLessThan(0.0001);
    expect(Math.abs(row.avg_pnl_per_card - wrongIfNoContestIncluded)).toBeGreaterThan(0.001);
  });
});
