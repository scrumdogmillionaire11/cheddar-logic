'use strict';
// WI-0821: Unit tests for resolveOffenseComposite

const { resolveOffenseComposite } = require('../mlb-model');

describe('resolveOffenseComposite', () => {
  test('average offense (wRC+ 100, xwOBA .320) → multiplier exactly 1.0', () => {
    const result = resolveOffenseComposite({ wrc_plus: 100, xwoba: 0.320 });
    expect(result).toBeCloseTo(1.0, 5);
  });

  test('elite offense (wRC+ 125, xwOBA .360) → multiplier ≤ 1.14', () => {
    const result = resolveOffenseComposite({ wrc_plus: 125, xwoba: 0.360 });
    expect(result).toBeLessThanOrEqual(1.14);
    expect(result).toBeGreaterThan(1.0);
  });

  test('weak offense (wRC+ 80, xwOBA .290) → multiplier ≥ 0.88', () => {
    const result = resolveOffenseComposite({ wrc_plus: 80, xwoba: 0.290 });
    expect(result).toBeGreaterThanOrEqual(0.88);
    expect(result).toBeLessThan(1.0);
  });

  test('multiplier is always clamped within [0.88, 1.14]', () => {
    // Extreme high
    const high = resolveOffenseComposite({ wrc_plus: 200, xwoba: 0.450 });
    expect(high).toBeLessThanOrEqual(1.14);
    expect(high).toBeGreaterThanOrEqual(0.88);

    // Extreme low
    const low = resolveOffenseComposite({ wrc_plus: 40, xwoba: 0.200 });
    expect(low).toBeLessThanOrEqual(1.14);
    expect(low).toBeGreaterThanOrEqual(0.88);
  });

  test('missing xwoba falls back to league default (0.320) → same as average xwOBA', () => {
    const withXwoba = resolveOffenseComposite({ wrc_plus: 100, xwoba: 0.320 });
    const withoutXwoba = resolveOffenseComposite({ wrc_plus: 100, xwoba: null });
    expect(withoutXwoba).toBeCloseTo(withXwoba, 5);
  });

  test('elite offense produces strictly lower multiplier than old four-term chain for same inputs', () => {
    // Old chain: wRC+ 130 → *1.30, ISO 0.220 → *(1+(0.055*0.35))≈1.019,
    //            k_pct 0.18 → *(1-(−0.045*0.45))≈1.020, bb_pct 0.10 → *(1+(0.015*0.8))≈1.012
    //            contactMult at xwOBA 0.360 → *(1+(0.04*0.9))≈1.036
    // Combined old: 1.30 * 1.019 * 1.020 * 1.012 * 1.036 ≈ 1.42+ (on top of starterSkillRa9)
    //
    // New: resolveOffenseComposite (wRC+ 130, xwOBA .360) → clamped ≤ 1.14
    // Both return multipliers to be applied once to starterSkillRa9.
    // Old first term alone: starterSkillRa9 * (130/100) = *1.30
    // New single multiplier must be ≤ 1.14
    const newMult = resolveOffenseComposite({ wrc_plus: 130, xwoba: 0.360 });
    const oldFirstTermOnly = 130 / 100; // 1.30 — just the first of 5 old multipliers
    expect(newMult).toBeLessThanOrEqual(oldFirstTermOnly);
    expect(newMult).toBeLessThanOrEqual(1.14);
  });
});
