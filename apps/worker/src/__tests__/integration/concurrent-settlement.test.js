const fs = require('fs');
const {
  closeDatabase,
  runMigrations,
  insertProjectionAudit,
  recomputeTrackingStats,
  getDatabase,
} = require('@cheddar-logic/data');

const TEST_DB_PATH = '/tmp/cheddar-test-concurrent-settlement.db';
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

describe('concurrent settlement race mitigation', () => {
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
    // Clear tables between tests for isolation
    const db = getDatabase();
    db.prepare('DELETE FROM tracking_stats').run();
    db.prepare('DELETE FROM projection_audit').run();
  });

  function seedAuditRow(overrides = {}) {
    insertProjectionAudit({
      cardResultId: `cr-${Math.random().toString(36).slice(2)}`,
      sport: 'NBA',
      marketType: 'total',
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

  test('recomputeTrackingStats produces correct aggregates from projection_audit rows', () => {
    // 2 wins + 1 loss for NBA total
    seedAuditRow({ cardResultId: 'cr-agg-1', result: 'win', pnlUnits: 0.909 });
    seedAuditRow({ cardResultId: 'cr-agg-2', result: 'win', pnlUnits: 0.909 });
    seedAuditRow({ cardResultId: 'cr-agg-3', result: 'loss', pnlUnits: -1.0 });

    recomputeTrackingStats();

    const db = getDatabase();
    const row = db.prepare('SELECT * FROM tracking_stats WHERE stat_key = ?')
      .get('NBA|total|all|all|all|alltime');

    expect(row).toBeDefined();
    expect(row.wins).toBe(2);
    expect(row.losses).toBe(1);
    expect(row.pushes).toBe(0);
    expect(row.total_cards).toBe(3);
    expect(row.settled_cards).toBe(3);
    expect(Math.abs(row.win_rate - 2/3)).toBeLessThan(0.01);
  });

  test('recomputeTrackingStats is idempotent — calling twice produces same result', () => {
    seedAuditRow({ cardResultId: 'cr-idem-1', result: 'win', pnlUnits: 0.909 });
    seedAuditRow({ cardResultId: 'cr-idem-2', result: 'loss', pnlUnits: -1.0 });
    seedAuditRow({ cardResultId: 'cr-idem-3', result: 'win', pnlUnits: 0.909 });

    recomputeTrackingStats();
    recomputeTrackingStats();

    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM tracking_stats WHERE stat_key LIKE \'NBA|total%|alltime\'').all();
    // market-level row
    const market = rows.find(r => r.stat_key === 'NBA|total|all|all|all|alltime');
    expect(market).toBeDefined();
    expect(market.wins).toBe(2);
    expect(market.losses).toBe(1);
    expect(market.total_cards).toBe(3);
  });

  test('recomputeTrackingStats excludes 1P rows from tracking_stats', () => {
    seedAuditRow({ cardResultId: 'cr-1p-full-1', result: 'win', pnlUnits: 0.909, period: null });
    seedAuditRow({ cardResultId: 'cr-1p-full-2', result: 'win', pnlUnits: 0.909, period: null });
    // This 1P row should be excluded
    seedAuditRow({ cardResultId: 'cr-1p-period', result: 'loss', pnlUnits: -1.0, period: '1P' });

    recomputeTrackingStats();

    const db = getDatabase();
    const market = db.prepare('SELECT * FROM tracking_stats WHERE stat_key = ?')
      .get('NBA|total|all|all|all|alltime');

    expect(market).toBeDefined();
    // Only the 2 full-game wins should be counted — 1P loss excluded
    expect(market.wins).toBe(2);
    expect(market.losses).toBe(0);
    expect(market.total_cards).toBe(2);

    // No stat_key should contain 'total_1p'
    const allRows = db.prepare('SELECT stat_key FROM tracking_stats').all();
    const has1p = allRows.some(r => r.stat_key.includes('total_1p'));
    expect(has1p).toBe(false);
  });

  test('recomputeTrackingStats creates separate row for each sharp_price_status segment', () => {
    seedAuditRow({
      cardResultId: 'cr-seg-confirmed',
      result: 'win', pnlUnits: 0.909,
      sharpPriceStatus: 'CONFIRMED',
    });
    seedAuditRow({
      cardResultId: 'cr-seg-estimated',
      result: 'loss', pnlUnits: -1.0,
      sharpPriceStatus: 'ESTIMATED',
    });

    recomputeTrackingStats();

    const db = getDatabase();
    const confirmed = db.prepare('SELECT * FROM tracking_stats WHERE stat_key = ?')
      .get('NBA|total|all|all|edge_verification:CONFIRMED|alltime');
    const estimated = db.prepare('SELECT * FROM tracking_stats WHERE stat_key = ?')
      .get('NBA|total|all|all|edge_verification:ESTIMATED|alltime');

    expect(confirmed).toBeDefined();
    expect(confirmed.wins).toBe(1);
    expect(confirmed.losses).toBe(0);

    expect(estimated).toBeDefined();
    expect(estimated.wins).toBe(0);
    expect(estimated.losses).toBe(1);
  });
});

