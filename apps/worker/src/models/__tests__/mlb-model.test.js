'use strict';
// WI-0821: Unit tests for resolveOffenseComposite

const {
  projectF5ML,
  projectF5Total,
  resolveOffenseComposite,
} = require('../mlb-model');

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

describe('projectF5ML alignment (WI-0871)', () => {
  const homePitcher = {
    era: 3.5,
    whip: 1.12,
    k_per_9: 9.4,
    handedness: 'R',
    siera: 3.48,
    x_fip: 3.42,
    x_era: 3.51,
    bb_pct: 0.071,
    gb_pct: 45.2,
    hr_per_9: 0.98,
    season_k_pct: 0.272,
    xwoba_allowed: 0.302,
    avg_ip: 5.8,
    pitch_count_avg: 96,
    times_through_order_profile: {
      '1st': 0.296,
      '2nd': 0.312,
      '3rd': 0.337,
    },
  };
  const awayPitcher = {
    era: 4.1,
    whip: 1.28,
    k_per_9: 8.6,
    handedness: 'L',
    siera: 3.98,
    x_fip: 3.95,
    x_era: 4.02,
    bb_pct: 0.081,
    gb_pct: 41.0,
    hr_per_9: 1.18,
    season_k_pct: 0.236,
    xwoba_allowed: 0.327,
    avg_ip: 5.2,
    pitch_count_avg: 92,
    times_through_order_profile: {
      '1st': 0.309,
      '2nd': 0.326,
      '3rd': 0.356,
    },
  };
  const averageOffense = {
    wrc_plus_vs_rhp: 100,
    wrc_plus_vs_lhp: 100,
    xwoba_vs_rhp: 0.320,
    xwoba_vs_lhp: 0.320,
    rolling_14d_wrc_plus_vs_rhp: 100,
    rolling_14d_wrc_plus_vs_lhp: 100,
  };
  const eliteOffense = {
    wrc_plus_vs_rhp: 126,
    wrc_plus_vs_lhp: 132,
    xwoba_vs_rhp: 0.352,
    xwoba_vs_lhp: 0.361,
    rolling_14d_wrc_plus_vs_rhp: 118,
    rolling_14d_wrc_plus_vs_lhp: 121,
  };
  const cleanContext = {
    park_run_factor: 1.02,
    temp_f: 72,
    wind_mph: 7,
    wind_dir: 'OUT',
    roof: 'OPEN',
  };

  test('uses the shared per-team F5 run means when offense/context inputs are provided', () => {
    const totalProjection = projectF5Total(homePitcher, awayPitcher, {
      home_offense_profile: averageOffense,
      away_offense_profile: averageOffense,
      ...cleanContext,
    });
    const mlProjection = projectF5ML(
      homePitcher,
      awayPitcher,
      -110,
      -110,
      averageOffense,
      averageOffense,
      cleanContext,
    );

    expect(mlProjection.projection_source).toBe('FULL_MODEL');
    expect(mlProjection.reason_codes).toEqual([]);
    expect(mlProjection.projected_home_f5_runs).toBeCloseTo(
      totalProjection.projected_home_f5_runs,
      6,
    );
    expect(mlProjection.projected_away_f5_runs).toBeCloseTo(
      totalProjection.projected_away_f5_runs,
      6,
    );
  });

  test('elite offense against a weaker starter raises home F5 runs and win probability', () => {
    const baseline = projectF5ML(
      homePitcher,
      awayPitcher,
      -110,
      -110,
      averageOffense,
      averageOffense,
      cleanContext,
    );
    const boosted = projectF5ML(
      homePitcher,
      { ...awayPitcher, era: 5.2, siera: 4.85, x_fip: 4.78, x_era: 4.92, whip: 1.42 },
      -110,
      -110,
      eliteOffense,
      averageOffense,
      cleanContext,
    );

    expect(boosted.projected_home_f5_runs).toBeGreaterThan(
      baseline.projected_home_f5_runs,
    );
    expect(boosted.projected_win_prob_home).toBeGreaterThan(
      baseline.projected_win_prob_home,
    );
  });

  test('falls back to legacy ERA math when offense inputs are missing', () => {
    const result = projectF5ML(
      homePitcher,
      awayPitcher,
      -110,
      -110,
      null,
      averageOffense,
      cleanContext,
    );

    expect(result.projection_source).toBe('F5_ML_FALLBACK_ERA');
    expect(result.reason_codes).toContain('F5_ML_FALLBACK_ERA');
    expect(result.projected_home_f5_runs).toBeCloseTo(
      ((awayPitcher.era + 4.5) / 2) * (5 / 9),
      6,
    );
    expect(result.projected_away_f5_runs).toBeCloseTo(
      ((homePitcher.era + 4.5) / 2) * (5 / 9),
      6,
    );
  });

  test('confidence starts at 7 on the aligned path and drops for degraded inputs', () => {
    const cleanResult = projectF5ML(
      homePitcher,
      awayPitcher,
      -110,
      -110,
      averageOffense,
      averageOffense,
      cleanContext,
    );
    const degradedResult = projectF5ML(
      { ...homePitcher, times_through_order_profile: null },
      { ...awayPitcher, x_era: null },
      -110,
      -110,
      averageOffense,
      averageOffense,
      cleanContext,
    );

    expect(cleanResult.confidence).toBe(7);
    expect(degradedResult.confidence).toBe(5);
    expect(degradedResult.degraded_inputs).toEqual(
      expect.arrayContaining([
        'home_starter_xera',
        'away_times_through_order_profile',
      ]),
    );
  });
});
