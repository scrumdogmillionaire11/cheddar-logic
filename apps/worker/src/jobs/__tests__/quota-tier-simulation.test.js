/**
 * Quota Tier Simulation Tests (Items 2a, 2b, 2d from ODDS_FETCH_REMAINING.md)
 *
 * Tests the DB-layer quota functions and T-minus dedup behavior that gates
 * odds fetches. Does not spin up the full scheduler — tests the DB contracts
 * that getCurrentQuotaTier() and claimTminusPullSlot() depend on.
 *
 * 2a — CRITICAL tier: near-zero balance → tokens_remaining ≤ 10% of limit
 * 2b — Burn rate alarm: high session spend → burn rate projection forces MEDIUM
 * 2c — Restart-safe dedup: claimTminusPullSlot idempotent across "restarts"
 * 2d — 25-game night: 25 NBA games in same T-30 window → 1 slot claimed
 */

const fs = require('fs');
const {
  initDb,
  runMigrations,
  getDatabase,
  closeDatabase,
  upsertQuotaLedger,
  getQuotaLedger,
  claimTminusPullSlot,
  purgeStaleTminusPullLog,
} = require('@cheddar-logic/data');

const TEST_DB_PATH = '/tmp/cheddar-quota-sim-test.db';

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB_PATH;
  process.env.RECORD_DATABASE_PATH = '';
  process.env.CHEDDAR_DB_PATH = '';
  process.env.DATABASE_URL = '';
  process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  await runMigrations();
});

afterAll(() => {
  closeDatabase();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

const PERIOD = '2026-03';
const MONTHLY_LIMIT = 20000;

// Helper: compute tier from ledger row (mirrors getCurrentQuotaTier logic)
function computeTier(row, opts = {}) {
  const monthlyLimit = opts.monthlyLimit ?? MONTHLY_LIMIT;
  const reservePct = opts.reservePct ?? 15;
  const effectiveLimit = monthlyLimit * (1 - reservePct / 100);
  const hoursElapsed = opts.hoursElapsed ?? 240; // arbitrary non-zero

  if (row.tokens_remaining === null) return 'FULL';

  const pctRemaining = (row.tokens_remaining / monthlyLimit) * 100;

  if (hoursElapsed > 0 && row.tokens_spent_session > 0) {
    const projectedMonthly = (row.tokens_spent_session / hoursElapsed) * 24 * 30;
    if (projectedMonthly > effectiveLimit) return 'MEDIUM';
  }

  if (pctRemaining > 50) return 'FULL';
  if (pctRemaining > 25) return 'MEDIUM';
  if (pctRemaining > 10) return 'LOW';
  return 'CRITICAL';
}

// ─────────────────────────────────────────────────────────────────────────────
// 2a — CRITICAL tier: near-zero balance gates all fetches
// ─────────────────────────────────────────────────────────────────────────────

describe('2a — CRITICAL tier (near-zero balance)', () => {
  test('tokens_remaining=500 with 20000 limit → CRITICAL (<10%)', () => {
    upsertQuotaLedger({
      provider: 'odds_api',
      period: PERIOD,
      tokens_remaining: 500,
      tokens_spent_session: 0,
      monthly_limit: MONTHLY_LIMIT,
      updated_by: 'test-2a',
    });

    const ledger = getQuotaLedger('odds_api', PERIOD);
    expect(ledger.tokens_remaining).toBe(500);

    const pctRemaining = (ledger.tokens_remaining / MONTHLY_LIMIT) * 100;
    expect(pctRemaining).toBeLessThanOrEqual(10); // confirms CRITICAL threshold

    const tier = computeTier(ledger);
    expect(tier).toBe('CRITICAL');
  });

  test('CRITICAL tier: 9% remaining → CRITICAL', () => {
    upsertQuotaLedger({
      provider: 'odds_api',
      period: PERIOD,
      tokens_remaining: 1800, // 9%
      tokens_spent_session: 0,
      monthly_limit: MONTHLY_LIMIT,
      updated_by: 'test-2a-boundary',
    });

    const ledger = getQuotaLedger('odds_api', PERIOD);
    const tier = computeTier(ledger);
    expect(tier).toBe('CRITICAL');
  });

  test('11% remaining → LOW (not CRITICAL)', () => {
    upsertQuotaLedger({
      provider: 'odds_api',
      period: PERIOD,
      tokens_remaining: 2200, // 11%
      tokens_spent_session: 0,
      monthly_limit: MONTHLY_LIMIT,
      updated_by: 'test-2a-low',
    });

    const ledger = getQuotaLedger('odds_api', PERIOD);
    const tier = computeTier(ledger);
    expect(tier).toBe('LOW');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2b — Burn rate alarm forces MEDIUM even with >50% remaining
// ─────────────────────────────────────────────────────────────────────────────

describe('2b — Burn rate alarm', () => {
  test('high session spend with 75% remaining → MEDIUM (burn rate alarm)', () => {
    // 15000 remaining (75%) but 8000 tokens spent in short session
    // projectedMonthly = (8000 / hoursElapsed) * 24 * 30
    // Use hoursElapsed=24 → projected = (8000/24)*24*30 = 240000 >> effectiveLimit(17000)
    upsertQuotaLedger({
      provider: 'odds_api',
      period: PERIOD,
      tokens_remaining: 15000,
      tokens_spent_session: 8000,
      monthly_limit: MONTHLY_LIMIT,
      updated_by: 'test-2b',
    });

    const ledger = getQuotaLedger('odds_api', PERIOD);
    expect(ledger.tokens_remaining).toBe(15000);

    // Raw pctRemaining = 75% → would normally be FULL
    const rawPct = (ledger.tokens_remaining / MONTHLY_LIMIT) * 100;
    expect(rawPct).toBeGreaterThan(50);

    // But burn rate projection overrides to MEDIUM
    const tier = computeTier(ledger, { hoursElapsed: 24 });
    expect(tier).toBe('MEDIUM');
  });

  test('low session spend with 75% remaining → FULL (no alarm)', () => {
    upsertQuotaLedger({
      provider: 'odds_api',
      period: PERIOD,
      tokens_remaining: 15000,
      tokens_spent_session: 100, // trivial spend
      monthly_limit: MONTHLY_LIMIT,
      updated_by: 'test-2b-no-alarm',
    });

    const ledger = getQuotaLedger('odds_api', PERIOD);
    // projected = (100/240)*24*30 = 300/month — well under 17000 effectiveLimit
    const tier = computeTier(ledger, { hoursElapsed: 240 });
    expect(tier).toBe('FULL');
  });

  test('zero session spend → burn rate alarm never fires', () => {
    upsertQuotaLedger({
      provider: 'odds_api',
      period: PERIOD,
      tokens_remaining: 5000, // 25% → LOW
      tokens_spent_session: 0,
      monthly_limit: MONTHLY_LIMIT,
      updated_by: 'test-2b-zero',
    });

    const ledger = getQuotaLedger('odds_api', PERIOD);
    const tier = computeTier(ledger, { hoursElapsed: 1 });
    expect(tier).toBe('LOW');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2c — Restart-safe dedup (claimTminusPullSlot)
// ─────────────────────────────────────────────────────────────────────────────

describe('2c — Restart-safe T-minus dedup', () => {
  const WINDOW = 'nba|T-30|2026-03-25T19';

  test('first claim for a window returns true (should queue)', () => {
    const claimed = claimTminusPullSlot('nba', WINDOW);
    expect(claimed).toBe(true);
  });

  test('second claim for same window returns false (already queued)', () => {
    const claimed = claimTminusPullSlot('nba', WINDOW);
    expect(claimed).toBe(false);
  });

  test('"restart" — third claim still returns false (DB persists across resets)', () => {
    // Simulates a process restart: in-memory state would have reset,
    // but DB-backed INSERT OR IGNORE still blocks the duplicate
    const claimed = claimTminusPullSlot('nba', WINDOW);
    expect(claimed).toBe(false);
  });

  test('different sport, same T-minus window → independent slot (returns true)', () => {
    // window_key includes sport prefix, so nhl gets its own unique key
    const nhlWindow = `nhl|T-30|2026-03-25T19`;
    const claimed = claimTminusPullSlot('nhl', nhlWindow);
    expect(claimed).toBe(true);
  });

  test('different hour slot → new slot (returns true)', () => {
    const newWindow = 'nba|T-30|2026-03-25T20';
    const claimed = claimTminusPullSlot('nba', newWindow);
    expect(claimed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2d — 25-game night: same window → exactly 1 slot claimed
// ─────────────────────────────────────────────────────────────────────────────

describe('2d — 25-game night: one pull per sport per T-minus window', () => {
  const HOUR = '2026-03-26T19';

  test('25 NBA games in T-30 window → exactly 1 odds pull slot claimed', () => {
    const window = `nba|T-30|${HOUR}`;
    let claimed = 0;

    for (let i = 0; i < 25; i++) {
      if (claimTminusPullSlot('nba', window)) claimed++;
    }

    expect(claimed).toBe(1);
  });

  test('4 T-minus windows × 2 sports → 8 total slots claimed (not 25×8)', () => {
    const WINDOWS = ['T-120', 'T-60', 'T-30', 'T-10'];
    const SPORTS = ['nba', 'nhl'];
    let claimed = 0;
    const HOUR2 = '2026-03-26T20';

    for (const sport of SPORTS) {
      for (const win of WINDOWS) {
        const windowKey = `${sport}|${win}|${HOUR2}`;
        for (let game = 0; game < 25; game++) {
          if (claimTminusPullSlot(sport, windowKey)) claimed++;
        }
      }
    }

    // 2 sports × 4 windows = 8 unique slots, not 25×8=200
    expect(claimed).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// purgeStaleTminusPullLog
// ─────────────────────────────────────────────────────────────────────────────

describe('purgeStaleTminusPullLog', () => {
  test('rows older than 48h are deleted, recent rows are kept', () => {
    const db = getDatabase();

    // Insert a stale row directly
    db.prepare(
      `INSERT OR IGNORE INTO tminus_pull_log (sport, window_key, queued_at)
       VALUES ('test', 'test|T-30|2026-01-01T00', datetime('now', '-72 hours'))`,
    ).run();

    // Insert a fresh row
    db.prepare(
      `INSERT OR IGNORE INTO tminus_pull_log (sport, window_key, queued_at)
       VALUES ('test', 'test|T-30|fresh', datetime('now'))`,
    ).run();

    purgeStaleTminusPullLog();

    const stale = db
      .prepare(`SELECT 1 FROM tminus_pull_log WHERE window_key = 'test|T-30|2026-01-01T00'`)
      .get();
    const fresh = db
      .prepare(`SELECT 1 FROM tminus_pull_log WHERE window_key = 'test|T-30|fresh'`)
      .get();

    expect(stale).toBeNull(); // better-sqlite3 .get() returns null for no match
    expect(fresh).not.toBeNull();
  });
});
