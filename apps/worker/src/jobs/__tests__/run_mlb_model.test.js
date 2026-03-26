'use strict';

/**
 * Tests — Sharp Cheddar K pitcher strikeout decision engine (WI-0595)
 *            + data freshness / fail-closed gates (WI-0596)
 *
 * Covers:
 * 1. Positive emit: full-data pitcher emits PROJECTION_ONLY card with expected fields
 * 2. Blocked: INSUFFICIENT_STARTS halts projection at Step 1
 * 3. Blocked: SHORT_LEASH (via IP proxy) halts over at Step 2
 * 4. Blocked: IL_RETURN flag halts over at Step 2
 * 5. (WI-0596) checkPitcherFreshness: MISSING / STALE / FRESH
 * 6. (WI-0596) validatePitcherKInputs: required field gates
 * 7. (WI-0596) buildPitcherKObject: full field mapping from DB row
 *
 * Tests run without DB, network, or job runner.
 */

const { scorePitcherK } = require('../../models/mlb-model');
const {
  checkPitcherFreshness,
  validatePitcherKInputs,
  buildPitcherKObject,
} = require('../run_mlb_model');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A healthy, full-data pitcher ready to emit. */
const fullPitcher = {
  k_per_9: 10.2,
  recent_k_per_9: 11.4,
  season_starts: 8,
  starts: 8,
  recent_ip: 6.1,
  last_three_pitch_counts: [95, 92, 88], // Full leash: 2 of 3 >= 90
  il_return: false,
  days_since_last_start: 5,
  role: 'starter',
  // Trend: 4 starts available each window
  k_pct_last_4_starts: 0.32,
  k_pct_prior_4_starts: 0.27,  // delta +5pp → trend qualifies
  current_season_swstr_pct: 0.13,
  bvp_pa: 0,
  bvp_k: 0,
};

/** Neutral matchup — no opp K% data available (thin sample → neutral multiplier). */
const neutralMatchup = {
  opp_k_pct_vs_handedness_l30_pa: 0,
  opp_k_pct_vs_handedness_season_pa: 0,
  park_k_factor: 1.0,
  confirmed_lineup: null,
  has_role_signal: false,
};

const PROJECTION_ONLY_OPTS = { mode: 'PROJECTION_ONLY', side: 'over' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scorePitcherK — projection-only mode', () => {

  test('1. Positive emit: full pitcher emits COMPLETE result with projection and reason_codes', () => {
    const result = scorePitcherK(fullPitcher, neutralMatchup, {}, null, {}, PROJECTION_ONLY_OPTS);

    expect(result.status).toBe('COMPLETE');
    expect(result.basis).toBe('PROJECTION_ONLY');
    expect(result.projection_only).toBe(true);
    expect(typeof result.projection).toBe('number');
    expect(result.projection).toBeGreaterThan(0);

    // Leash
    expect(result.leash_tier).toBe('Full');

    // Overlays present
    expect(result.overlays).toMatchObject({
      trend: expect.objectContaining({ score: expect.any(Number) }),
      ump:   expect.objectContaining({ score: expect.any(Number) }),
      bvp:   expect.objectContaining({ score: expect.any(Number) }),
    });

    // Blocks present
    expect(result.blocks).toMatchObject({
      b1: 0, // skipped in PROJECTION_ONLY
      b2: expect.any(Number),
      b3: expect.any(Number),
      b4: 0, // skipped in PROJECTION_ONLY
      b5: expect.any(Number),
    });

    // Reason codes document the bypassed steps
    expect(result.reason_codes).toContain('BLOCK_1_SKIPPED:PROJECTION_ONLY');
    expect(result.reason_codes).toContain('BLOCK_4_SKIPPED:PROJECTION_ONLY');

    // Net score is non-negative
    expect(result.net_score).toBeGreaterThanOrEqual(0);

    // Verdict is a known value
    expect(['Play', 'Conditional', 'Pass']).toContain(result.verdict);
  });

  test('2. Blocked: INSUFFICIENT_STARTS halts at Step 1', () => {
    const greenPitcher = { ...fullPitcher, season_starts: 2, starts: 2 };
    const result = scorePitcherK(greenPitcher, neutralMatchup, {}, null, {}, PROJECTION_ONLY_OPTS);

    expect(result.status).toBe('HALTED');
    expect(result.halted_at).toBe('STEP_1');
    expect(result.reason_code).toBe('INSUFFICIENT_STARTS');
    expect(result.verdict).toBe('PASS');
  });

  test('3. Blocked: SHORT_LEASH kills over at Step 2', () => {
    // IP proxy < 4.5 → Short leash
    const shortLeasher = {
      ...fullPitcher,
      recent_ip: 3.8,
      last_three_pitch_counts: null, // force IP proxy path
    };
    const result = scorePitcherK(shortLeasher, neutralMatchup, {}, null, {}, PROJECTION_ONLY_OPTS);

    expect(result.status).toBe('HALTED');
    expect(result.halted_at).toBe('STEP_2');
    // reason_code should be a leash-kill reason (IP_PROXY maps to Short tier, not over-eligible)
    expect(result.verdict).toBe('PASS');
    expect(result.projection).toBeGreaterThan(0); // projection ran before leash gate
  });

  test('4. Blocked: IL_RETURN kills over at Step 2', () => {
    const ilPitcher = { ...fullPitcher, il_return: true };
    const result = scorePitcherK(ilPitcher, neutralMatchup, {}, null, {}, PROJECTION_ONLY_OPTS);

    expect(result.status).toBe('HALTED');
    expect(result.halted_at).toBe('STEP_2');
    expect(result.reason_code).toBe('IL_RETURN');
    expect(result.verdict).toBe('PASS');
  });
});

describe('scorePitcherK — leash classification edge cases', () => {

  test('Full leash: 2 of last 3 starts >= 90 pitches', () => {
    const p = { ...fullPitcher, last_three_pitch_counts: [92, 95, 78] };
    const result = scorePitcherK(p, neutralMatchup, {}, null, {}, PROJECTION_ONLY_OPTS);
    expect(result.leash_tier).toBe('Full');
    expect(result.blocks.b2).toBe(2.0);
  });

  test('Mod leash: avg pitch count 75-84', () => {
    const p = { ...fullPitcher, last_three_pitch_counts: [80, 78, 76] }; // avg 78
    const result = scorePitcherK(p, neutralMatchup, {}, null, {}, PROJECTION_ONLY_OPTS);
    expect(result.leash_tier).toBe('Mod');
    expect(result.blocks.b2).toBe(1.0);
  });

  test('EXTENDED_REST kills over at Step 2', () => {
    const p = { ...fullPitcher, days_since_last_start: 12, il_return: false };
    const result = scorePitcherK(p, neutralMatchup, {}, null, {}, PROJECTION_ONLY_OPTS);
    expect(result.status).toBe('HALTED');
    expect(result.reason_code).toBe('EXTENDED_REST');
    expect(result.verdict).toBe('PASS');
  });
});

describe('scorePitcherK — trap scan', () => {

  test('ENVIRONMENT_COMPROMISED: 2+ trap flags suspend verdict', () => {
    // Trigger: has_role_signal + hidden weather condition
    const suspectMatchup = {
      ...neutralMatchup,
      has_role_signal: true, // HIDDEN_ROLE_RISK
    };
    const suspectWeather = {
      wind_in_mph: 18,
      wind_direction: 'IN',  // WIND_SUPPRESSION
    };
    const result = scorePitcherK(fullPitcher, suspectMatchup, {}, null, suspectWeather, PROJECTION_ONLY_OPTS);

    expect(result.status).toBe('SUSPENDED');
    expect(result.reason_code).toBe('ENVIRONMENT_COMPROMISED');
    expect(result.trap_flags.length).toBeGreaterThanOrEqual(2);
    expect(result.verdict).toBe('PASS');
  });
});

// ---------------------------------------------------------------------------
// WI-0596: Data freshness gates
// ---------------------------------------------------------------------------

describe('checkPitcherFreshness — freshness gate (WI-0596)', () => {
  const TODAY = '2026-03-26';

  test('MISSING: null row returns MISSING', () => {
    expect(checkPitcherFreshness(null, TODAY)).toBe('MISSING');
  });

  test('MISSING: undefined row returns MISSING', () => {
    expect(checkPitcherFreshness(undefined, TODAY)).toBe('MISSING');
  });

  test('FRESH: row updated today returns FRESH', () => {
    const row = { updated_at: '2026-03-26T14:30:00Z' };
    expect(checkPitcherFreshness(row, TODAY)).toBe('FRESH');
  });

  test('STALE: row updated yesterday returns STALE', () => {
    const row = { updated_at: '2026-03-25T22:00:00Z' };
    expect(checkPitcherFreshness(row, TODAY)).toBe('STALE');
  });

  test('STALE: row with empty updated_at returns STALE', () => {
    const row = { updated_at: '' };
    expect(checkPitcherFreshness(row, TODAY)).toBe('STALE');
  });
});

// ---------------------------------------------------------------------------
// WI-0596: Required field validation
// ---------------------------------------------------------------------------

describe('validatePitcherKInputs — required field gates (WI-0596)', () => {

  /** Minimal valid pitcher: all PITCHER_K_REQUIRED_FIELDS present */
  const validPitcher = {
    k_per_9: 10.2,
    season_starts: 8,
    handedness: 'R',
    days_since_last_start: 5,
  };

  test('valid pitcher: all required fields present → returns null', () => {
    expect(validatePitcherKInputs(validPitcher)).toBeNull();
  });

  test('missing k_per_9 → PITCHER_REQUIRED_FIELD_NULL with k_per_9 in missing_fields', () => {
    const result = validatePitcherKInputs({ ...validPitcher, k_per_9: null });
    expect(result).not.toBeNull();
    expect(result.code).toBe('PITCHER_REQUIRED_FIELD_NULL');
    expect(result.missing_fields).toContain('k_per_9');
  });

  test('missing handedness → PITCHER_REQUIRED_FIELD_NULL with handedness in missing_fields', () => {
    const result = validatePitcherKInputs({ ...validPitcher, handedness: null });
    expect(result).not.toBeNull();
    expect(result.missing_fields).toContain('handedness');
  });

  test('missing days_since_last_start → included in missing_fields', () => {
    const result = validatePitcherKInputs({ ...validPitcher, days_since_last_start: null });
    expect(result.missing_fields).toContain('days_since_last_start');
  });

  test('all required fields null → all four appear in missing_fields', () => {
    const result = validatePitcherKInputs({});
    expect(result.code).toBe('PITCHER_REQUIRED_FIELD_NULL');
    expect(result.missing_fields).toEqual(
      expect.arrayContaining(['k_per_9', 'season_starts', 'handedness', 'days_since_last_start']),
    );
  });
});

// ---------------------------------------------------------------------------
// WI-0596: buildPitcherKObject field mapping
// ---------------------------------------------------------------------------

describe('buildPitcherKObject — DB row → K engine shape (WI-0596)', () => {

  const baseRow = {
    era: 3.45,
    whip: 1.12,
    k_per_9: 10.2,
    recent_k_per_9: 11.4,
    recent_ip: 6.1,
    season_starts: 8,
    handedness: 'R',
    season_k_pct: 0.28,
    k_pct_last_4_starts: 0.31,
    k_pct_prior_4_starts: 0.27,
    last_three_pitch_counts: JSON.stringify([95, 92, 88]),
    last_three_ip: JSON.stringify([6.2, 6.0, 6.1]),
    days_since_last_start: 5,
    il_status: 0,
    il_return: 0,
    role: 'starter',
    season_swstr_pct: 0.13,
    season_avg_velo: 95.1,
  };

  test('pass path: maps all K engine fields correctly from DB row', () => {
    const obj = buildPitcherKObject(baseRow);
    expect(obj.k_per_9).toBe(10.2);
    expect(obj.season_starts).toBe(8);
    expect(obj.handedness).toBe('R');
    expect(obj.days_since_last_start).toBe(5);
    expect(obj.il_status).toBe(false);   // 0 → boolean false
    expect(obj.il_return).toBe(false);
    expect(obj.role).toBe('starter');
    expect(obj.swstr_pct).toBe(0.13);
    expect(obj.season_avg_velo).toBe(95.1);
  });

  test('parses last_three_pitch_counts JSON string to array', () => {
    const obj = buildPitcherKObject(baseRow);
    expect(Array.isArray(obj.last_three_pitch_counts)).toBe(true);
    expect(obj.last_three_pitch_counts).toEqual([95, 92, 88]);
  });

  test('parses last_three_ip JSON string to array', () => {
    const obj = buildPitcherKObject(baseRow);
    expect(Array.isArray(obj.last_three_ip)).toBe(true);
    expect(obj.last_three_ip).toEqual([6.2, 6.0, 6.1]);
  });

  test('null last_three_pitch_counts stays null (< 3 entries)', () => {
    const row = { ...baseRow, last_three_pitch_counts: JSON.stringify([95, 92]) };
    const obj = buildPitcherKObject(row);
    expect(obj.last_three_pitch_counts).toBeNull();
  });

  test('invalid JSON last_three_pitch_counts → null (does not throw)', () => {
    const row = { ...baseRow, last_three_pitch_counts: 'not-json' };
    expect(() => buildPitcherKObject(row)).not.toThrow();
    expect(buildPitcherKObject(row).last_three_pitch_counts).toBeNull();
  });

  test('null DB fields remain null (Statcast not yet populated)', () => {
    const row = { ...baseRow, season_swstr_pct: null, season_avg_velo: null };
    const obj = buildPitcherKObject(row);
    expect(obj.swstr_pct).toBeNull();
    expect(obj.season_avg_velo).toBeNull();
  });
});
