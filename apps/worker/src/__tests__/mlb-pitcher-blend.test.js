'use strict';

/**
 * Unit Tests — WI-0764: Fix siera/x_era null in mlb_pitcher_stats
 *
 * Validates:
 *   1. estimatePitcherSiera returns a numeric value given valid K%/BB% inputs
 *   2. estimatePitcherSiera returns null when required inputs are absent
 *   3. estimatePitcherSiera uses an explicit gbRate when provided (overrides league average)
 *   4. estimatePitcherSiera clamps output to [2.0, 6.8]
 *   5. The normalized weighted blend pattern does NOT silently collapse when
 *      x_era is null — effective weight on each signal matches normalized share
 *   6. When only x_fip is non-null, blend returns x_fip exactly (weight = 1.0)
 *
 * Pure tests — no DB, no network, no fixtures required.
 */

const { estimatePitcherSiera } = require('../jobs/pull_mlb_pitcher_stats');

// ── Helper: mirrors the inline blend used in run_mlb_model.js ─────────────────

/**
 * Replicate the weight-normalization blend from getPitcherEraFromDb /
 * resolvePitcherSkill so we can assert its behaviour without importing
 * the non-exported private functions.
 *
 * @param {{ siera: number|null, x_fip: number|null, x_era: number|null }} signals
 * @returns {number|null}
 */
function blendPitcherSkill({ siera, x_fip, x_era }) {
  function toFiniteNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  // Guard: toFiniteNumber(null) === 0 (Number(null)===0), so check raw value first.
  const parts = [
    { value: siera != null ? toFiniteNumber(siera) : null, weight: 0.4 },
    { value: x_fip != null ? toFiniteNumber(x_fip) : null, weight: 0.35 },
    { value: x_era != null ? toFiniteNumber(x_era) : null, weight: 0.25 },
  ].filter((p) => p.value !== null);
  if (parts.length === 0) return null;
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  return parts.reduce((sum, p) => sum + p.value * p.weight, 0) / totalWeight;
}

// ── estimatePitcherSiera ─────────────────────────────────────────────────────

describe('estimatePitcherSiera', () => {
  test('returns a finite number for typical pitcher rates', () => {
    const result = estimatePitcherSiera({ kPct: 0.27, bbPct: 0.08 });
    expect(typeof result).toBe('number');
    expect(Number.isFinite(result)).toBe(true);
  });

  test('formula produces expected value for K%=0.15, BB%=0.10 (league-avg GB)', () => {
    // SIERA = 6.145 - 16.986*0.15 + 11.434*0.10 - 1.858*0.44
    //       = 6.145 - 2.5479 + 1.1434 - 0.81752 ≈ 3.92
    const result = estimatePitcherSiera({ kPct: 0.15, bbPct: 0.10 });
    expect(result).toBeCloseTo(3.92, 1);
  });

  test('explicit gbRate overrides league-average default', () => {
    // Use non-clamping rates (k=0.15, bb=0.10 → SIERA ~3.92 with default gb)
    const withDefault = estimatePitcherSiera({ kPct: 0.15, bbPct: 0.10 });
    const withHighGb  = estimatePitcherSiera({ kPct: 0.15, bbPct: 0.10, gbRate: 0.55 });
    // Higher GB rate → lower SIERA (ground balls suppress runs)
    expect(withHighGb).toBeLessThan(withDefault);
  });

  test('returns null when kPct is null', () => {
    expect(estimatePitcherSiera({ kPct: null, bbPct: 0.08 })).toBeNull();
  });

  test('returns null when bbPct is null', () => {
    expect(estimatePitcherSiera({ kPct: 0.27, bbPct: null })).toBeNull();
  });

  test('returns null when both inputs are null', () => {
    expect(estimatePitcherSiera({ kPct: null, bbPct: null })).toBeNull();
  });

  test('clamps result to minimum 2.0 for elite strikeout rates', () => {
    // K% = 0.38, BB% = 0.04 → very low SIERA, should clamp
    const result = estimatePitcherSiera({ kPct: 0.38, bbPct: 0.04 });
    expect(result).toBeGreaterThanOrEqual(2.0);
  });

  test('clamps result to maximum 6.8 for terrible peripherals', () => {
    // K% = 0.10, BB% = 0.20 → very high SIERA, should clamp
    const result = estimatePitcherSiera({ kPct: 0.10, bbPct: 0.20 });
    expect(result).toBeLessThanOrEqual(6.8);
  });
});

// ── Weighted blend — no silent null collapse ─────────────────────────────────

describe('pitcher skill blend (weight normalization)', () => {
  test('when only x_fip provided, blend returns x_fip exactly (effective weight = 1.0)', () => {
    const result = blendPitcherSkill({ siera: null, x_fip: 3.80, x_era: null });
    expect(result).toBeCloseTo(3.80, 4);
  });

  test('when siera and x_fip provided (no x_era), blend normalizes weights correctly', () => {
    // siera=3.60, x_fip=3.80; declared weights 0.4 and 0.35; normalised to 0.4/0.75 and 0.35/0.75
    const siera = 3.60;
    const x_fip = 3.80;
    const expected = (siera * 0.4 + x_fip * 0.35) / (0.4 + 0.35);
    const result = blendPitcherSkill({ siera, x_fip, x_era: null });
    expect(result).toBeCloseTo(expected, 4);
    // Must not equal x_fip alone (would indicate weight collapse)
    expect(result).not.toBeCloseTo(x_fip, 2);
  });

  test('all three signals present: result is weighted average of all', () => {
    const siera = 3.60;
    const x_fip = 3.80;
    const x_era = 4.00;
    const expected = (siera * 0.4 + x_fip * 0.35 + x_era * 0.25) / 1.0;
    const result = blendPitcherSkill({ siera, x_fip, x_era });
    expect(result).toBeCloseTo(expected, 4);
  });

  test('all signals null returns null', () => {
    expect(blendPitcherSkill({ siera: null, x_fip: null, x_era: null })).toBeNull();
  });
});
