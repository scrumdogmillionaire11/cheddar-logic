const fs = require('fs');
const {
  closeDatabase,
  runMigrations,
  incrementTrackingStat,
  getTrackingStats,
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

  test('incrementTrackingStat accumulates deltas atomically', () => {
    const statKey = 'NHL|moneyline|all|all|all|test-period';

    // Simulate Process A settling 5 cards: 3 wins, 2 losses
    incrementTrackingStat({
      id: 'stat-nhl-test-1',
      statKey,
      sport: 'NHL',
      marketType: 'moneyline',
      direction: 'all',
      confidenceTier: 'all',
      driverKey: 'all',
      timePeriod: 'test-period',
      deltaWins: 3,
      deltaLosses: 2,
      deltaPushes: 0,
      deltaPnl: 1.5,
    });

    // Simulate Process B settling 8 cards concurrently: 5 wins, 2 losses, 1 push
    incrementTrackingStat({
      id: 'stat-nhl-test-1', // Same ID (will be ignored due to stat_key conflict)
      statKey,
      sport: 'NHL',
      marketType: 'moneyline',
      direction: 'all',
      confidenceTier: 'all',
      driverKey: 'all',
      timePeriod: 'test-period',
      deltaWins: 5,
      deltaLosses: 2,
      deltaPushes: 1,
      deltaPnl: 2.3,
    });

    // Simulate Process C settling 7 cards concurrently: 4 wins, 3 losses
    incrementTrackingStat({
      id: 'stat-nhl-test-1', // Same ID
      statKey,
      sport: 'NHL',
      marketType: 'moneyline',
      direction: 'all',
      confidenceTier: 'all',
      driverKey: 'all',
      timePeriod: 'test-period',
      deltaWins: 4,
      deltaLosses: 3,
      deltaPushes: 0,
      deltaPnl: 0.8,
    });

    // Verify: All increments accumulated correctly
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM tracking_stats WHERE stat_key = ?');
    const row = stmt.get(statKey);

    expect(row).toBeDefined();
    expect(row.wins).toBe(12); // 3 + 5 + 4
    expect(row.losses).toBe(7); // 2 + 2 + 3
    expect(row.pushes).toBe(1); // 0 + 1 + 0
    expect(row.total_cards).toBe(20); // 5 + 8 + 7
    expect(row.settled_cards).toBe(20);
    expect(Math.abs(row.total_pnl_units - 4.6)).toBeLessThan(0.01); // 1.5 + 2.3 + 0.8
    expect(Math.abs(row.win_rate - 12 / 19)).toBeLessThan(0.01); // 12 wins / 19 decided
    expect(Math.abs(row.avg_pnl_per_card - 4.6 / 20)).toBeLessThan(0.01);
  });

  test('incrementTrackingStat creates new stat if not exists', () => {
    const statKey = 'NBA|spread|HOME|all|all|new-period';

    incrementTrackingStat({
      id: 'stat-nba-new',
      statKey,
      sport: 'NBA',
      marketType: 'spread',
      direction: 'HOME',
      confidenceTier: 'all',
      driverKey: 'all',
      timePeriod: 'new-period',
      deltaWins: 7,
      deltaLosses: 3,
      deltaPushes: 0,
      deltaPnl: 3.2,
    });

    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM tracking_stats WHERE stat_key = ?');
    const row = stmt.get(statKey);

    expect(row).toBeDefined();
    expect(row.wins).toBe(7);
    expect(row.losses).toBe(3);
    expect(row.pushes).toBe(0);
    expect(row.total_cards).toBe(10);
    expect(Math.abs(row.total_pnl_units - 3.2)).toBeLessThan(0.01);
  });

  test('incrementTrackingStat handles zero deltas gracefully', () => {
    const statKey = 'NCAAM|total|all|all|all|zero-test';

    // Initial increment
    incrementTrackingStat({
      id: 'stat-ncaam-zero',
      statKey,
      sport: 'NCAAM',
      marketType: 'total',
      direction: 'all',
      confidenceTier: 'all',
      driverKey: 'all',
      timePeriod: 'zero-test',
      deltaWins: 5,
      deltaLosses: 0,
      deltaPushes: 0,
      deltaPnl: 2.5,
    });

    // Increment with all zeros (no-op)
    incrementTrackingStat({
      id: 'stat-ncaam-zero',
      statKey,
      sport: 'NCAAM',
      marketType: 'total',
      direction: 'all',
      confidenceTier: 'all',
      driverKey: 'all',
      timePeriod: 'zero-test',
      deltaWins: 0,
      deltaLosses: 0,
      deltaPushes: 0,
      deltaPnl: 0,
    });

    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM tracking_stats WHERE stat_key = ?');
    const row = stmt.get(statKey);

    expect(row).toBeDefined();
    expect(row.wins).toBe(5); // Unchanged
    expect(row.losses).toBe(0);
    expect(row.total_cards).toBe(5);
  });

  test('incrementTrackingStat handles negative PnL correctly', () => {
    const statKey = 'MLB|moneyline|all|all|all|negative-pnl';

    incrementTrackingStat({
      id: 'stat-mlb-negative',
      statKey,
      sport: 'MLB',
      marketType: 'moneyline',
      direction: 'all',
      confidenceTier: 'all',
      driverKey: 'all',
      timePeriod: 'negative-pnl',
      deltaWins: 2,
      deltaLosses: 8,
      deltaPushes: 0,
      deltaPnl: -3.5,
    });

    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM tracking_stats WHERE stat_key = ?');
    const row = stmt.get(statKey);

    expect(row).toBeDefined();
    expect(row.wins).toBe(2);
    expect(row.losses).toBe(8);
    expect(Math.abs(row.total_pnl_units - -3.5)).toBeLessThan(0.01);
    expect(row.win_rate).toBeCloseTo(0.2, 2); // 2/10
    expect(row.avg_pnl_per_card).toBeCloseTo(-0.35, 2);
  });
});
