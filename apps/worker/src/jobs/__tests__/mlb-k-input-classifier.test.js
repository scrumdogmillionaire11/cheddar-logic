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
  buildLeashConfidence,
  dedupeFlags,
} = require('../mlb-k-input-classifier');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Full set of core inputs — all real values, no proxies, chase present */
function allCorePresent() {
  return {
    starter: {
      k_pct: 0.28,
      swstr_pct: 0.13,
      pitch_count_avg: 93,
    },
    opponent: {
      k_pct_vs_hand: 0.22,
      contact_pct_vs_hand: 0.78,
      projected_lineup_status: 'CONFIRMED',
    },
    leash: {
      pitch_count_avg: 93,
      expected_ip: 6.0,
      last_three_pitch_counts: [95, 92, 92],
    },
    projection_diagnostics: {
      projection_source: 'FULL_MODEL',
      missing_inputs: [],
      degraded_inputs: [],
      status_cap: null,
      placeholder_fields: [],
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('classifyMlbPitcherKQuality', () => {
  it('returns FULL_MODEL when all core fields are present with real values', () => {
    const result = classifyMlbPitcherKQuality(allCorePresent());

    expect(result.model_quality).toBe('FULL_MODEL');
    expect(result.hardMissing).toHaveLength(0);
    expect(result.proxies).toHaveLength(0);
    expect(result.degraded).toHaveLength(0);
    expect(result.reasonCodes).toEqual([]);
  });

  it('returns FALLBACK when the scoring path had to use a whiff proxy', () => {
    const inputs = allCorePresent();
    delete inputs.starter.swstr_pct;
    inputs.starter.csw_pct = null;
    inputs.projection_diagnostics.degraded_inputs = ['starter_whiff_proxy'];
    inputs.projection_diagnostics.missing_inputs = ['statcast_swstr'];

    const result = classifyMlbPitcherKQuality(inputs);

    expect(result.model_quality).toBe('FALLBACK');
    expect(result.proxies).toContain('starter_whiff_proxy');
    expect(result.reasonCodes).toContain(
      'QUALITY_PROXY_SUBSTITUTED:starter_whiff_proxy',
    );
    expect(result.model_quality).not.toBe('FULL_MODEL');
  });

  it('returns FALLBACK when leash quality comes from IP-only proxy data', () => {
    const inputs = allCorePresent();
    delete inputs.starter.pitch_count_avg;
    inputs.leash.pitch_count_avg = null;
    inputs.leash.last_three_pitch_counts = [];
    inputs.leash.ip_avg = 5.4;
    inputs.leash.leash_flag = 'IP_PROXY';

    const result = classifyMlbPitcherKQuality(inputs);

    expect(result.model_quality).toBe('FALLBACK');
    expect(result.proxies).toContain('leash_ip_avg_proxy');
    expect(result.leash_confidence.source).toBe('IP_AVG_PROXY');
    expect(result.model_quality).not.toBe('FULL_MODEL');
  });

  it('returns FALLBACK when placeholder fields are explicitly flagged', () => {
    const inputs = allCorePresent();
    inputs.projection_diagnostics.placeholder_fields = [
      'starter.k_pct',
      'opponent.contact_pct_vs_hand',
    ];

    const result = classifyMlbPitcherKQuality(inputs);

    expect(result.model_quality).toBe('FALLBACK');
    expect(result.proxies).toContain('placeholder_input:starter.k_pct');
    expect(result.reasonCodes).toContain(
      'QUALITY_PROXY_SUBSTITUTED:placeholder_input:starter.k_pct',
    );
    expect(result.model_quality).not.toBe('FULL_MODEL');
  });

  it('returns DEGRADED_MODEL when lineup confirmation is missing', () => {
    const inputs = allCorePresent();
    inputs.opponent.projected_lineup_status = 'MISSING';
    inputs.projection_diagnostics.projection_source = 'DEGRADED_MODEL';

    const result = classifyMlbPitcherKQuality(inputs);

    expect(result.model_quality).toBe('DEGRADED_MODEL');
    expect(result.hardMissing).toHaveLength(0);
    expect(result.proxies).toHaveLength(0);
    expect(result.degraded).toEqual(
      expect.arrayContaining(['lineup_unconfirmed', 'projection_source_degraded']),
    );
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
  it('emits stable starter, opponent, and leash keys for complete inputs', () => {
    const matrix = buildCompletenessMatrix(
      { k_pct: 0.28, swstr_pct: 0.13, csw_pct: 0.29, pitch_count_avg: 93 },
      { k_pct_vs_hand: 0.22, contact_pct_vs_hand: 0.78, projected_lineup_status: 'CONFIRMED' },
      { pitch_count_avg: 93, expected_ip: 6.0, last_three_pitch_counts: [95, 92, 92] },
    );

    expect(Object.keys(matrix.starter_profile).sort()).toEqual([
      'csw_pct',
      'ip_avg',
      'k_pct',
      'pitch_count_avg',
      'swstr_pct',
    ]);
    expect(Object.keys(matrix.opponent_profile).sort()).toEqual([
      'contact_pct_vs_hand',
      'k_pct_vs_hand',
      'projected_lineup_status',
    ]);
    expect(Object.keys(matrix.leash_profile).sort()).toEqual([
      'direct_pitch_count_history',
      'expected_ip',
      'ip_avg',
      'pitch_count_avg',
    ]);
    expect(matrix.leash_profile.direct_pitch_count_history).toBe(true);
  });

  it('marks fields as false when null/undefined/NaN', () => {
    const matrix = buildCompletenessMatrix(
      { k_pct: null, swstr_pct: undefined },
      { k_pct_vs_hand: NaN, contact_pct_vs_hand: null },
      { pitch_count_avg: null, ip_avg: null, expected_ip: null },
    );

    expect(matrix.starter_profile.k_pct).toBe(false);
    expect(matrix.starter_profile.swstr_pct).toBe(false);
    expect(matrix.opponent_profile.k_pct_vs_hand).toBe(false);
    expect(matrix.opponent_profile.contact_pct_vs_hand).toBe(false);
    expect(matrix.opponent_profile.projected_lineup_status).toBe(false);
    expect(matrix.leash_profile.pitch_count_avg).toBe(false);
    expect(matrix.leash_profile.ip_avg).toBe(false);
  });
});

describe('buildLeashConfidence', () => {
  it('grades direct pitch-count history above proxy-only leash inputs', () => {
    expect(
      buildLeashConfidence({
        pitch_count_avg: 93,
        expected_ip: 6.0,
        last_three_pitch_counts: [95, 92, 92],
      }),
    ).toMatchObject({
      level: 'HIGH',
      source: 'PITCH_COUNT_HISTORY',
      proxy_in_use: false,
    });

    expect(
      buildLeashConfidence({
        ip_avg: 5.4,
        expected_ip: 5.0,
        leash_flag: 'IP_PROXY',
      }),
    ).toMatchObject({
      level: 'MEDIUM',
      source: 'IP_AVG_PROXY',
      proxy_in_use: true,
    });
  });
});
