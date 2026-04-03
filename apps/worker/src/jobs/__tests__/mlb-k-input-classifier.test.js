'use strict';

/**
 * Unit Tests — mlb-k-input-classifier.js
 *
 * Tests are intentionally dependency-free (pure function).
 * No DB, no model code, no fixtures needed.
 *
 * WI: WORK_QUEUE/WI-0747.md
 */

const {
  classifyMlbPitcherKQuality,
  buildCompletenessMatrix,
  dedupeFlags,
} = require('../mlb-k-input-classifier');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Full set of core inputs — all real values, no proxies, chase present */
function allCorePresent() {
  return {
    starter: {
      k_pct:    0.28,
      swstr_pct: 0.13,
    },
    opponent: {
      k_pct_vs_hand:           0.22,
      contact_pct_vs_hand:     0.76,
      chase_pct_vs_hand:       0.31,
      projected_lineup_status: 'CONFIRMED',
    },
    leash: {
      pitch_count_avg: 93,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('classifyMlbPitcherKQuality', () => {
  // Test 1 — FULL_MODEL when all core fields present
  it('returns FULL_MODEL when all core fields are present with real values', () => {
    const result = classifyMlbPitcherKQuality(allCorePresent());

    expect(result.model_quality).toBe('FULL_MODEL');
    expect(result.hardMissing).toHaveLength(0);
    expect(result.proxies).toHaveLength(0);
    // degraded may be non-empty (e.g. missing chase_pct) but that is fine
  });

  // Test 2 — FALLBACK when whiff proxy used
  it('returns FALLBACK (not FULL_MODEL) when whiff proxy substitutes real swstr_pct/csw_pct', () => {
    const inputs = allCorePresent();
    // Remove real whiff metrics, add proxy signal
    delete inputs.starter.swstr_pct;
    inputs.starter.csw_pct     = null;
    inputs.starter.whiff_proxy = 0.18;

    const result = classifyMlbPitcherKQuality(inputs);

    expect(result.model_quality).toBe('FALLBACK');
    expect(result.proxies).toContain('starter_whiff_proxy');
    // Explicit guard — must NEVER be FULL_MODEL when proxy used
    expect(result.model_quality).not.toBe('FULL_MODEL');
  });

  // Test 3 — FALLBACK when opponent contact profile missing
  it('returns FALLBACK (not FULL_MODEL) when contact_pct_vs_hand is absent', () => {
    const inputs = allCorePresent();
    inputs.opponent.contact_pct_vs_hand = null;

    const result = classifyMlbPitcherKQuality(inputs);

    expect(result.model_quality).toBe('FALLBACK');
    expect(result.hardMissing).toContain('opp_contact_profile');
    // Explicit guard
    expect(result.model_quality).not.toBe('FULL_MODEL');
  });

  // Test 4 — FALLBACK when IP proxy substitutes real leash metric
  it('returns FALLBACK (not FULL_MODEL) when ip_proxy substitutes real pitch_count_avg / ip_avg', () => {
    const inputs = allCorePresent();
    // Remove real leash metrics, add proxy signal
    inputs.leash = { ip_proxy: 5.5 };

    const result = classifyMlbPitcherKQuality(inputs);

    expect(result.model_quality).toBe('FALLBACK');
    expect(result.proxies).toContain('ip_proxy');
    // Explicit guard
    expect(result.model_quality).not.toBe('FULL_MODEL');
  });

  it('returns DEGRADED_MODEL (not FULL_MODEL) when only secondary fields are missing', () => {
    const inputs = allCorePresent();
    // Secondary gap: chase_pct missing + lineup only PROJECTED
    inputs.opponent.chase_pct_vs_hand       = undefined;
    inputs.opponent.projected_lineup_status = 'PROJECTED';

    const result = classifyMlbPitcherKQuality(inputs);

    expect(result.model_quality).toBe('DEGRADED_MODEL');
    expect(result.hardMissing).toHaveLength(0);
    expect(result.proxies).toHaveLength(0);
    expect(result.degraded.length).toBeGreaterThan(0);
  });
});

describe('dedupeFlags', () => {
  // Test 5 — Duplicate flags deduplicated
  it('removes duplicate flag strings and preserves first-occurrence order', () => {
    const flags = [
      'DEGRADED_INPUT:starter_whiff_proxy',
      'FLAG_A',
      'DEGRADED_INPUT:starter_whiff_proxy',
      'FLAG_A',
      'FLAG_B',
    ];

    const result = dedupeFlags(flags);

    expect(result).toHaveLength(3);
    expect(new Set(result).size).toBe(result.length);
    expect(result[0]).toBe('DEGRADED_INPUT:starter_whiff_proxy');
    expect(result[1]).toBe('FLAG_A');
    expect(result[2]).toBe('FLAG_B');
  });

  it('returns empty array for non-array input', () => {
    expect(dedupeFlags(null)).toEqual([]);
    expect(dedupeFlags(undefined)).toEqual([]);
    expect(dedupeFlags('string')).toEqual([]);
  });

  it('returns same array when no duplicates exist', () => {
    const flags = ['A', 'B', 'C'];
    expect(dedupeFlags(flags)).toEqual(['A', 'B', 'C']);
  });
});

describe('buildCompletenessMatrix', () => {
  it('marks fields as true when finite numbers are provided', () => {
    const matrix = buildCompletenessMatrix(
      { k_pct: 0.28, swstr_pct: 0.13, csw_pct: 0.29 },
      { k_pct_vs_hand: 0.22, contact_pct_vs_hand: 0.76, projected_lineup_status: 'CONFIRMED' },
      { pitch_count_avg: 93 }
    );

    expect(matrix.starter_profile.k_pct).toBe(true);
    expect(matrix.starter_profile.swstr_pct).toBe(true);
    expect(matrix.opponent_profile.k_pct_vs_hand).toBe(true);
    expect(matrix.opponent_profile.contact_pct_vs_hand).toBe(true);
    expect(matrix.opponent_profile.projected_lineup).toBe(true);
  });

  it('marks fields as false when null/undefined/NaN', () => {
    const matrix = buildCompletenessMatrix(
      { k_pct: null, swstr_pct: undefined },
      { k_pct_vs_hand: NaN, contact_pct_vs_hand: null },
      {}
    );

    expect(matrix.starter_profile.k_pct).toBe(false);
    expect(matrix.starter_profile.swstr_pct).toBe(false);
    expect(matrix.opponent_profile.k_pct_vs_hand).toBe(false);
    expect(matrix.opponent_profile.contact_pct_vs_hand).toBe(false);
  });
});
