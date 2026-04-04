'use strict';

/**
 * Unit Tests — WI-0770: MLB K engine Statcast gate
 *
 * Validates:
 *   1. parseCsv / resolveAvgVelo / resolveWhiffPct in pull_mlb_statcast.js
 *   2. calculateProjectionK behaviour when swstr_pct and season_avg_velo
 *      are populated vs. absent.
 *
 * Pure tests — no DB, no network, no fixtures required.
 */

const {
  parseCsv,
  resolveAvgVelo,
  resolveWhiffPct,
} = require('../jobs/pull_mlb_statcast');

const { calculateProjectionK } = require('../models/mlb-model');

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Minimal pitcher object that passes all early gates */
function makePitcher(overrides = {}) {
  return {
    season_starts: 8,
    handedness: 'R',
    season_k_pct: 0.25,
    k_pct: 0.25,
    bb_pct: 0.08,
    xwoba_allowed: 0.320,
    recent_ip: 5.5,
    avg_ip: 5.5,
    last_three_pitch_counts: [95, 98, 92],
    season_swstr_pct: null,
    swstr_pct: null,
    season_avg_velo: null,
    ...overrides,
  };
}

/** Matchup with sufficient opponent data to avoid thin-sample flag */
function makeMatchup(overrides = {}) {
  return {
    opp_k_pct_vs_handedness_l30: 0.22,
    opp_k_pct_vs_handedness_l30_pa: 250,
    opp_obp: 0.315,
    opp_xwoba: 0.310,
    opp_hard_hit_pct: 38.0,
    park_k_factor: 1.0,
    ...overrides,
  };
}

const LEASH_TIER = 'Full';
const WEATHER = { temp_at_first_pitch: 68 };

// ── parseCsv tests ────────────────────────────────────────────────────────────

describe('parseCsv', () => {
  test('parses a minimal CSV block', () => {
    const csv = 'player_id,player_name,avg_velocity,whiff_percent\n123456,Sandy Koufax,93.1,15.2\n';
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].player_id).toBe('123456');
    expect(rows[0].avg_velocity).toBe('93.1');
    expect(rows[0].whiff_percent).toBe('15.2');
  });

  test('returns empty array for header-only input', () => {
    const rows = parseCsv('player_id,avg_velocity,whiff_percent\n');
    expect(rows).toHaveLength(0);
  });
});

// ── resolveAvgVelo tests ──────────────────────────────────────────────────────

describe('resolveAvgVelo', () => {
  test('returns numeric value from avg_velocity column', () => {
    expect(resolveAvgVelo({ avg_velocity: '93.5' })).toBeCloseTo(93.5);
  });

  test('falls back to fastball_avg_speed column', () => {
    expect(resolveAvgVelo({ fastball_avg_speed: '94.2' })).toBeCloseTo(94.2);
  });

  test('returns null for out-of-range value (e.g. 0)', () => {
    expect(resolveAvgVelo({ avg_velocity: '0' })).toBeNull();
  });

  test('returns null for empty strings', () => {
    expect(resolveAvgVelo({ avg_velocity: '' })).toBeNull();
  });

  test('returns null when no velo column present', () => {
    expect(resolveAvgVelo({ whiff_percent: '12.0' })).toBeNull();
  });
});

// ── resolveWhiffPct tests ─────────────────────────────────────────────────────

describe('resolveWhiffPct', () => {
  test('converts 0–100 scale to decimal', () => {
    const result = resolveWhiffPct({ whiff_percent: '13.5' });
    expect(result).toBeCloseTo(0.135, 3);
  });

  test('preserves already-decimal values', () => {
    expect(resolveWhiffPct({ whiff_percent: '0.135' })).toBeCloseTo(0.135, 3);
  });

  test('falls back to swstr_pct column', () => {
    expect(resolveWhiffPct({ swstr_pct: '11.2' })).toBeCloseTo(0.112, 3);
  });

  test('returns null for out-of-range value', () => {
    expect(resolveWhiffPct({ whiff_percent: '99' })).toBeNull(); // 0.99 > 0.40
  });

  test('returns null for empty string', () => {
    expect(resolveWhiffPct({ whiff_percent: '' })).toBeNull();
  });
});

// ── calculateProjectionK — swstr_pct gate ─────────────────────────────────────

describe('calculateProjectionK — swstr_pct gate (WI-0770)', () => {
  test('null swstr_pct adds statcast_swstr to missing_inputs', () => {
    const result = calculateProjectionK(
      makePitcher({ season_swstr_pct: null, swstr_pct: null }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    expect(result.missing_inputs).toContain('statcast_swstr');
  });

  test('null swstr_pct caps status_cap at LEAN', () => {
    const result = calculateProjectionK(
      makePitcher({ season_swstr_pct: null, swstr_pct: null }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    expect(result.status_cap).toBe('LEAN');
  });

  test('real swstr_pct produces PASS status_cap', () => {
    const result = calculateProjectionK(
      makePitcher({ swstr_pct: 0.14 }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    expect(result.status_cap).toBe('PASS');
  });

  test('real swstr_pct does NOT appear in missing_inputs', () => {
    const result = calculateProjectionK(
      makePitcher({ swstr_pct: 0.14 }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    expect(result.missing_inputs).not.toContain('statcast_swstr');
  });

  test('starter_whiff_proxy is no longer in degraded_inputs', () => {
    // Regression guard: old hardcoded-0.12 path pushed 'starter_whiff_proxy'
    // to degradedInputs. After WI-0770 it must not appear.
    const result = calculateProjectionK(
      makePitcher({ swstr_pct: 0.14 }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    expect(result.degraded_inputs).not.toContain('starter_whiff_proxy');
  });

  test('high-whiff pitcher (0.18) projects more Ks than low-whiff (0.08)', () => {
    const highWhiff = calculateProjectionK(
      makePitcher({ swstr_pct: 0.18 }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    const lowWhiff = calculateProjectionK(
      makePitcher({ swstr_pct: 0.08 }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    expect(highWhiff.k_mean).toBeGreaterThan(lowWhiff.k_mean);
  });

  test('statcast_inputs.swstr_pct matches the DB value passed in', () => {
    const result = calculateProjectionK(
      makePitcher({ swstr_pct: 0.155 }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    expect(result.statcast_inputs.swstr_pct).toBeCloseTo(0.155, 3);
  });

  test('statcast_inputs.swstr_pct is null when absent', () => {
    const result = calculateProjectionK(
      makePitcher({ swstr_pct: null, season_swstr_pct: null }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    expect(result.statcast_inputs.swstr_pct).toBeNull();
  });
});

// ── calculateProjectionK — season_avg_velo modifier ──────────────────────────

describe('calculateProjectionK — season_avg_velo modifier (WI-0770)', () => {
  test('null season_avg_velo adds statcast_velo to missing_inputs', () => {
    const result = calculateProjectionK(
      makePitcher({ swstr_pct: 0.14, season_avg_velo: null }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    expect(result.missing_inputs).toContain('statcast_velo');
  });

  test('null season_avg_velo does NOT change status_cap to LEAN (non-blocking)', () => {
    const withVelo = calculateProjectionK(
      makePitcher({ swstr_pct: 0.14, season_avg_velo: 92 }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    const withoutVelo = calculateProjectionK(
      makePitcher({ swstr_pct: 0.14, season_avg_velo: null }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    // Both should be PASS — velo absence does not block
    expect(withVelo.status_cap).toBe('PASS');
    expect(withoutVelo.status_cap).toBe('PASS');
  });

  test('high-velo pitcher (≥95) projects more Ks than mid-velo (92)', () => {
    const highVelo = calculateProjectionK(
      makePitcher({ swstr_pct: 0.14, season_avg_velo: 96 }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    const midVelo = calculateProjectionK(
      makePitcher({ swstr_pct: 0.14, season_avg_velo: 92 }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    expect(highVelo.k_mean).toBeGreaterThan(midVelo.k_mean);
  });

  test('low-velo pitcher (<90) projects fewer Ks than mid-velo (92)', () => {
    const lowVelo = calculateProjectionK(
      makePitcher({ swstr_pct: 0.14, season_avg_velo: 88 }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    const midVelo = calculateProjectionK(
      makePitcher({ swstr_pct: 0.14, season_avg_velo: 92 }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    expect(lowVelo.k_mean).toBeLessThan(midVelo.k_mean);
  });

  test('statcast_inputs.season_avg_velo matches passed value', () => {
    const result = calculateProjectionK(
      makePitcher({ swstr_pct: 0.14, season_avg_velo: 94.5 }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    expect(result.statcast_inputs.season_avg_velo).toBeCloseTo(94.5);
  });

  test('statcast_inputs.season_avg_velo is null when absent', () => {
    const result = calculateProjectionK(
      makePitcher({ swstr_pct: 0.14, season_avg_velo: null }),
      makeMatchup(),
      LEASH_TIER,
      WEATHER,
    );
    expect(result.statcast_inputs.season_avg_velo).toBeNull();
  });
});
