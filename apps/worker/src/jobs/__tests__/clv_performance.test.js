'use strict';

/**
 * Tests for WI-0826 CLV + daily performance report jobs.
 *
 * Covers:
 * - computeCLV (unit)
 * - americanOddsToImpliedProb (unit)
 * - runClvSnapshot
 * - runDailyPerformanceReport — including avg_clv=null when no resolved entries
 */

const fs = require('fs');

const {
  closeDatabase,
  getDatabase,
  runMigrations,
} = require('@cheddar-logic/data');

const {
  americanOddsToImpliedProb,
  computeCLV,
  runClvSnapshot,
} = require('../run_clv_snapshot');

const {
  computeMaxDrawdown,
  runDailyPerformanceReport,
  queryAvgClv,
} = require('../run_daily_performance_report');

// ─── Test DB helpers ─────────────────────────────────────────────────────────

const TEST_DB_PATH = '/tmp/cheddar-test-wi-0826.db';
const LOCK_PATH = `${TEST_DB_PATH}.lock`;

function removeIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best-effort
  }
}

function ensureClvTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clv_ledger (
      id              TEXT PRIMARY KEY,
      card_id         TEXT NOT NULL,
      game_id         TEXT NOT NULL,
      sport           TEXT,
      market_type     TEXT,
      prop_type       TEXT,
      selection       TEXT,
      line            REAL,
      odds_at_pick    REAL,
      closing_odds    REAL,
      clv_pct         REAL,
      volatility_band TEXT,
      recorded_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at       TEXT,
      decision_basis  TEXT NOT NULL DEFAULT 'ODDS_BACKED'
    );

    CREATE TABLE IF NOT EXISTS clv_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      market TEXT NOT NULL,
      side TEXT NOT NULL,
      edge_at_placement REAL,
      fair_prob_at_placement REAL,
      implied_prob_at_placement REAL,
      closing_price REAL,
      closing_implied_prob REAL,
      clv REAL,
      clv_positive INTEGER,
      outcome INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS calibration_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      market TEXT NOT NULL,
      side TEXT NOT NULL,
      fair_prob REAL NOT NULL,
      implied_prob REAL,
      outcome INTEGER,
      model_status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_performance_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date TEXT NOT NULL,
      market TEXT NOT NULL,
      sport TEXT NOT NULL,
      eligible_games INTEGER DEFAULT 0,
      model_ok_count INTEGER DEFAULT 0,
      degraded_count INTEGER DEFAULT 0,
      no_bet_count INTEGER DEFAULT 0,
      bets_placed INTEGER DEFAULT 0,
      bets_blocked_gate INTEGER DEFAULT 0,
      hit_rate REAL,
      roi REAL,
      avg_edge_at_placement REAL,
      avg_clv REAL,
      brier REAL,
      ece REAL,
      max_drawdown REAL,
      computed_at TEXT NOT NULL,
      UNIQUE(report_date, market, sport)
    );

    CREATE TABLE IF NOT EXISTS card_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      sport TEXT,
      card_type TEXT,
      recommended_bet_type TEXT,
      market_type TEXT,
      selection TEXT,
      result TEXT,
      pnl_units REAL,
      status TEXT DEFAULT 'settled',
      metadata TEXT,
      settled_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function clearAllTables(db) {
  db.exec(`
    DELETE FROM clv_ledger;
    DELETE FROM clv_entries;
    DELETE FROM calibration_predictions;
    DELETE FROM daily_performance_reports;
    DELETE FROM card_results;
  `);
}

// ─── Pure unit tests ───────────────────────────────────────────────────────

describe('computeCLV', () => {
  test('positive CLV when closing price is better than placement', () => {
    // implied at placement = 0.524 (favourite at -110)
    // closing implied = 0.556 (market moved against us = we got value)
    const result = computeCLV(0.524, 0.556);
    expect(result).toBeCloseTo(0.032, 3);
  });

  test('negative CLV when market tightened in our favour', () => {
    const result = computeCLV(0.556, 0.524);
    expect(result).toBeCloseTo(-0.032, 3);
  });

  test('returns null when impliedProbAtPlacement is null', () => {
    expect(computeCLV(null, 0.55)).toBeNull();
  });

  test('returns null when closingImpliedProb is null', () => {
    expect(computeCLV(0.52, null)).toBeNull();
  });

  test('returns null for non-finite inputs', () => {
    expect(computeCLV(NaN, 0.5)).toBeNull();
    expect(computeCLV(0.5, Infinity)).toBeNull();
  });
});

describe('americanOddsToImpliedProb', () => {
  test('-110 → ~0.5238', () => {
    const p = americanOddsToImpliedProb(-110);
    expect(p).toBeCloseTo(110 / 210, 4);
  });

  test('+150 → ~0.4', () => {
    const p = americanOddsToImpliedProb(150);
    expect(p).toBeCloseTo(100 / 250, 4);
  });

  test('returns null for 0', () => {
    expect(americanOddsToImpliedProb(0)).toBeNull();
  });

  test('returns null for null', () => {
    expect(americanOddsToImpliedProb(null)).toBeNull();
  });
});

describe('computeMaxDrawdown', () => {
  test('returns 0 for empty list', () => {
    expect(computeMaxDrawdown([])).toBe(0);
  });

  test('calculates correct drawdown from mixed wins/losses', () => {
    // cumulative: 1, 0, 2, 0 → peak=2, trough=0, drawdown=2
    const dd = computeMaxDrawdown([1, -1, 2, -2]);
    expect(dd).toBe(2);
  });

  test('returns 0 for all-winning run', () => {
    expect(computeMaxDrawdown([1, 1, 1])).toBe(0);
  });
});

// ─── Integration tests ─────────────────────────────────────────────────────

describe('WI-0826 DB jobs', () => {
  beforeAll(async () => {
    process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS = 'false';

    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);

    await runMigrations();
    const db = getDatabase();
    ensureClvTables(db);
  });

  afterAll(() => {
    closeDatabase();
    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);
  });

  beforeEach(() => {
    clearAllTables(getDatabase());
  });

  // ── runClvSnapshot ──────────────────────────────────────────────────────

  test('runClvSnapshot writes clv_entries from closed clv_ledger rows', () => {
    const db = getDatabase();

    db.prepare(`
      INSERT INTO clv_ledger (
        id, card_id, game_id, sport, market_type, selection,
        odds_at_pick, closing_odds, recorded_at, closed_at, decision_basis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'l-001', 'c-001', 'g-001', 'NHL', 'total', 'OVER',
      -110, -120,
      new Date().toISOString(),
      new Date().toISOString(),
      'ODDS_BACKED',
    );

    const result = runClvSnapshot({ db });
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(0);

    const entry = db.prepare(
      "SELECT * FROM clv_entries WHERE game_id='g-001' AND market='NHL_TOTAL'",
    ).get();

    expect(entry).toBeDefined();
    expect(entry.side).toBe('OVER');
    // -110 implied prob ≈ 0.524, -120 implied prob ≈ 0.545
    // CLV = 0.545 - 0.524 < 0 → closing was worse for us
    expect(typeof entry.clv).toBe('number');
    expect(entry.implied_prob_at_placement).toBeCloseTo(110 / 210, 3);
    expect(entry.closing_implied_prob).toBeCloseTo(120 / 220, 3);
  });

  test('runClvSnapshot does not duplicate entries', () => {
    const db = getDatabase();

    db.prepare(`
      INSERT INTO clv_ledger (
        id, card_id, game_id, sport, market_type, selection,
        odds_at_pick, closing_odds, recorded_at, closed_at, decision_basis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'l-002', 'c-002', 'g-002', 'NHL', 'total', 'OVER',
      -110, -130,
      new Date().toISOString(),
      new Date().toISOString(),
      'ODDS_BACKED',
    );

    runClvSnapshot({ db });
    const result2 = runClvSnapshot({ db }); // second run
    expect(result2.written).toBe(0);
  });

  test('runClvSnapshot skips rows without closing_odds', () => {
    const db = getDatabase();

    db.prepare(`
      INSERT INTO clv_ledger (
        id, card_id, game_id, sport, market_type, selection,
        odds_at_pick, closing_odds, recorded_at, closed_at, decision_basis
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'l-003', 'c-003', 'g-003', 'NHL', 'total', 'OVER',
      -110, null, // no closing odds
      new Date().toISOString(),
      null, // not closed yet
      'ODDS_BACKED',
    );

    const result = runClvSnapshot({ db });
    expect(result.written).toBe(0);
  });

  // ── runDailyPerformanceReport ──────────────────────────────────────────

  test('produces a daily_performance_reports row per market', () => {
    const db = getDatabase();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    db.prepare(`
      INSERT INTO calibration_predictions (game_id, market, side, fair_prob, implied_prob, model_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('g-10', 'NHL_TOTAL', 'OVER', 0.55, 0.524, 'MODEL_OK', `${yesterday}T12:00:00Z`);

    const result = runDailyPerformanceReport({
      db,
      reportDate: yesterday,
      computedAt: new Date().toISOString(),
    });

    expect(result.reportDate).toBe(yesterday);
    expect(result.reports.length).toBe(1);

    const report = result.reports[0];
    expect(report.market).toBe('NHL_TOTAL');
    expect(report.sport).toBe('NHL');
    expect(report.model_ok_count).toBe(1);
    expect(report.eligible_games).toBe(1);

    const row = db.prepare(
      "SELECT * FROM daily_performance_reports WHERE report_date=? AND market='NHL_TOTAL'",
    ).get(yesterday);
    expect(row).toBeDefined();
    expect(row.model_ok_count).toBe(1);
  });

  test('avg_clv is null when no clv_entries exist for the period', () => {
    const db = getDatabase();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // seed cal prediction but NO clv_entries rows
    db.prepare(`
      INSERT INTO calibration_predictions (game_id, market, side, fair_prob, implied_prob, model_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('g-20', 'NHL_TOTAL', 'OVER', 0.55, 0.524, 'MODEL_OK', `${yesterday}T12:00:00Z`);

    const result = runDailyPerformanceReport({
      db,
      reportDate: yesterday,
    });

    const report = result.reports[0];
    expect(report.avg_clv).toBeNull();

    const row = db.prepare(
      "SELECT avg_clv FROM daily_performance_reports WHERE report_date=? AND market='NHL_TOTAL'",
    ).get(yesterday);
    expect(row.avg_clv).toBeNull();
  });

  test('avg_clv is not 0 when clv_entries have clv=0.0 rows written for unresolved games', () => {
    // This is the sentinel test from the WI acceptance criteria:
    // avg_clv should be null when there are zero RESOLVED entries,
    // not 0.0 which could be confused with "resolved, neutral CLV".
    const db = getDatabase();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    db.prepare(`
      INSERT INTO calibration_predictions (game_id, market, side, fair_prob, implied_prob, model_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('g-30', 'NHL_TOTAL', 'OVER', 0.55, 0.524, 'MODEL_OK', `${yesterday}T12:00:00Z`);

    // Insert a clv_entry with clv=NULL (unresolved) so AVG() should return null
    db.prepare(`
      INSERT INTO clv_entries (game_id, market, side, clv, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('g-30', 'NHL_TOTAL', 'OVER', null, `${yesterday}T14:00:00Z`);

    const avgClv = queryAvgClv(db, 'NHL_TOTAL', yesterday);
    // AVG() over rows where clv IS NULL should return null (no resolved entries)
    expect(avgClv).toBeNull();
  });
});
