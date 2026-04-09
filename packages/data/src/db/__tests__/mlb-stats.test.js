'use strict';

const { computeMLBLeagueAverages } = require('../mlb-stats');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal mock DB that returns the given row for .get() */
function makeDb(row) {
  return {
    prepare: () => ({
      get: () => row,
    }),
  };
}

/** Build a mock DB that throws on .prepare() (simulates missing table) */
function makeBrokenDb() {
  return {
    prepare: () => {
      throw new Error('no such table: mlb_pitcher_stats');
    },
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('computeMLBLeagueAverages', () => {
  it('returns static_2024 when row count is 0 (empty table)', () => {
    const db = makeDb({ n: 0, avg_k_pct: null, avg_xfip: null, avg_bb_pct: null });
    const result = computeMLBLeagueAverages(db);
    expect(result.source).toBe('static_2024');
    expect(result.kPct).toBe(0.225);
    expect(result.xfip).toBe(4.3);
    expect(result.bbPct).toBe(0.085);
    expect(result.n).toBe(0);
  });

  it('returns static_2024 when row count is below 50 (thin sample)', () => {
    const db = makeDb({ n: 30, avg_k_pct: 0.24, avg_xfip: 4.1, avg_bb_pct: 0.08 });
    const result = computeMLBLeagueAverages(db);
    expect(result.source).toBe('static_2024');
    expect(result.n).toBe(30);
    expect(result.kPct).toBe(0.225);
  });

  it('returns computed values when row count >= 50', () => {
    const db = makeDb({
      n: 60,
      avg_k_pct: 0.234,
      avg_xfip: 4.15,
      avg_bb_pct: 0.079,
    });
    const result = computeMLBLeagueAverages(db);
    expect(result.source).toBe('computed');
    expect(result.n).toBe(60);
    expect(result.kPct).toBeCloseTo(0.234, 6);
    expect(result.xfip).toBeCloseTo(4.15, 6);
    expect(result.bbPct).toBeCloseTo(0.079, 6);
  });

  it('uses static fallback for null columns even when n >= 50', () => {
    const db = makeDb({ n: 55, avg_k_pct: null, avg_xfip: null, avg_bb_pct: null });
    const result = computeMLBLeagueAverages(db);
    expect(result.source).toBe('computed');
    expect(result.kPct).toBe(0.225);
    expect(result.xfip).toBe(4.3);
    expect(result.bbPct).toBe(0.085);
  });

  it('returns static_2024 when the table does not exist (bootstrap env)', () => {
    const result = computeMLBLeagueAverages(makeBrokenDb());
    expect(result.source).toBe('static_2024');
    expect(result.n).toBe(0);
    expect(result.kPct).toBe(0.225);
  });

  it('kPct equals AVG(season_k_pct) across 60 mock rows', () => {
    // Simulate 60 rows with season_k_pct values averaging to 0.2317
    const avg = 0.2317;
    const db = makeDb({ n: 60, avg_k_pct: avg, avg_xfip: 4.22, avg_bb_pct: 0.082 });
    const result = computeMLBLeagueAverages(db);
    expect(result.source).toBe('computed');
    expect(result.kPct).toBeCloseTo(avg, 6);
  });
});
