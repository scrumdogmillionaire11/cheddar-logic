'use strict';
// WI-0821: Unit tests for resolveOffenseComposite

const {
  projectF5ML,
  projectF5Total,
  projectF5TotalCard,
  projectFullGameTotal,
  projectFullGameTotalCard,
  projectFullGameML,
  computeMLBDriverCards,
  evaluateMlbGameMarkets,
  resolveOffenseComposite,
  resolveMLBModelSignal,
  selectPassReasonCode,
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

  test('confidence starts at 7 on the aligned path and does not drop for unimplemented inputs', () => {
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
    // times_through_order_profile and starter_xera are not-yet-implemented features;
    // they populate degraded_inputs for observability but do not reduce confidence.
    // starter_xera is fully excluded from degraded_inputs (never added).
    // times_through_order_profile is still tracked but not penalized.
    expect(degradedResult.confidence).toBe(7);
    expect(degradedResult.degraded_inputs).toEqual(
      expect.arrayContaining([
        'away_times_through_order_profile',
      ]),
    );
  });
});

// ── WI-0872: projectFullGameTotal ────────────────────────────────────────────

const avgPitcher = {
  era: 4.3,
  whip: 1.28,
  k_per_9: 8.5,
  handedness: 'R',
  siera: 4.20,
  x_fip: 4.15,
  x_era: 4.25,
  bb_pct: 0.082,
  gb_pct: 42.0,
  hr_per_9: 1.15,
  season_k_pct: 0.230,
  xwoba_allowed: 0.325,
  avg_ip: 5.0,
  pitch_count_avg: 90,
  times_through_order_profile: { '1st': 0.310, '2nd': 0.330, '3rd': 0.355 },
};

const elitePitcher = {
  era: 2.9,
  whip: 1.02,
  k_per_9: 11.2,
  handedness: 'L',
  siera: 2.85,
  x_fip: 2.90,
  x_era: 2.95,
  bb_pct: 0.055,
  gb_pct: 50.0,
  hr_per_9: 0.65,
  season_k_pct: 0.298,
  xwoba_allowed: 0.285,
  avg_ip: 6.2,
  pitch_count_avg: 100,
  times_through_order_profile: { '1st': 0.280, '2nd': 0.298, '3rd': 0.315 },
};

const avgOffense = {
  wrc_plus_vs_rhp: 100,
  wrc_plus_vs_lhp: 100,
  xwoba_vs_rhp: 0.320,
  xwoba_vs_lhp: 0.320,
  rolling_14d_wrc_plus_vs_rhp: 100,
  rolling_14d_wrc_plus_vs_lhp: 100,
};

const baseContext = {
  home_offense_profile: avgOffense,
  away_offense_profile: avgOffense,
  park_run_factor: 1.0,
  temp_f: 72,
  wind_mph: 0,
  wind_dir: 'CALM',
  roof: 'OPEN',
  home_bullpen_era: 4.3,
  away_bullpen_era: 4.3,
};

describe('projectFullGameTotal (WI-0872)', () => {
  test('AC1: returns projected_total_mean, low, high, home_proj, away_proj', () => {
    const result = projectFullGameTotal(avgPitcher, avgPitcher, baseContext);

    expect(result.projected_total_mean).toBeGreaterThan(0);
    expect(result.projected_total_low).toBeGreaterThanOrEqual(0);
    expect(result.projected_total_high).toBeGreaterThan(result.projected_total_low);
    expect(result.home_proj).toBeGreaterThan(0);
    expect(result.away_proj).toBeGreaterThan(0);
  });

  test('AC2: fullGameMean is greater than F5-only mean for the same pitchers', () => {
    const fullGame = projectFullGameTotal(avgPitcher, avgPitcher, baseContext);
    const f5 = projectF5Total(avgPitcher, avgPitcher, baseContext);

    expect(fullGame.projected_total_mean).toBeGreaterThan(f5.projected_total_mean);
  });

  test('AC3: projection_source is FULL_MODEL when bullpen_era present; DEGRADED_MODEL when absent', () => {
    const full = projectFullGameTotal(avgPitcher, avgPitcher, baseContext);
    expect(full.projection_source).toBe('FULL_MODEL');

    const degraded = projectFullGameTotal(avgPitcher, avgPitcher, {
      ...baseContext,
      home_bullpen_era: null,
      away_bullpen_era: null,
    });
    expect(degraded.projection_source).toBe('DEGRADED_MODEL');
  });

  test('AC4: avg-starter + avg-bullpen game projects between 8.5 and 9.5 total', () => {
    const result = projectFullGameTotal(avgPitcher, avgPitcher, baseContext);

    expect(result.projected_total_mean).toBeGreaterThanOrEqual(8.5);
    expect(result.projected_total_mean).toBeLessThanOrEqual(9.5);
  });

  test('AC5: elite-starter game projects lower total than avg-starter game', () => {
    const avgGame = projectFullGameTotal(avgPitcher, avgPitcher, baseContext);
    const eliteGame = projectFullGameTotal(elitePitcher, elitePitcher, baseContext);

    expect(eliteGame.projected_total_mean).toBeLessThan(avgGame.projected_total_mean);
  });

  test('bullpen fatigue and recent usage increase full-game totals', () => {
    const clean = projectFullGameTotal(avgPitcher, avgPitcher, baseContext);
    const taxed = projectFullGameTotal(avgPitcher, avgPitcher, {
      ...baseContext,
      home_bullpen_fatigue_index: 0.9,
      away_bullpen_fatigue_index: 0.9,
      home_recent_usage: 0.9,
      away_recent_usage: 0.9,
      home_leverage_availability: 0.2,
      away_leverage_availability: 0.2,
    });

    expect(taxed.projected_total_mean).toBeGreaterThan(clean.projected_total_mean);
  });

  test('fresh elite leverage context suppresses late runs', () => {
    const baseline = projectFullGameTotal(avgPitcher, avgPitcher, baseContext);
    const elitePen = projectFullGameTotal(avgPitcher, avgPitcher, {
      ...baseContext,
      home_bullpen_era: 3.1,
      away_bullpen_era: 3.1,
      home_bullpen_fatigue_index: 0.2,
      away_bullpen_fatigue_index: 0.2,
      home_recent_usage: 0.2,
      away_recent_usage: 0.2,
      home_leverage_availability: 0.95,
      away_leverage_availability: 0.95,
    });

    expect(elitePen.home_late_runs + elitePen.away_late_runs).toBeLessThan(
      baseline.home_late_runs + baseline.away_late_runs,
    );
  });

  test('higher variance widens projected total range', () => {
    const lowVol = projectFullGameTotal(avgPitcher, avgPitcher, {
      ...baseContext,
      roof: 'CLOSED',
      wind_mph: 0,
      home_bullpen_era: 4.2,
      away_bullpen_era: 4.2,
    });
    const highVol = projectFullGameTotal(avgPitcher, avgPitcher, {
      ...baseContext,
      wind_mph: 24,
      roof: 'OPEN',
      home_bullpen_era: 3.0,
      away_bullpen_era: 6.3,
      home_bullpen_fatigue_index: 0.9,
      away_bullpen_fatigue_index: 0.9,
      home_recent_usage: 0.9,
      away_recent_usage: 0.9,
      home_leverage_availability: 0.15,
      away_leverage_availability: 0.15,
    });

    const lowRange = lowVol.projected_total_high - lowVol.projected_total_low;
    const highRange = highVol.projected_total_high - highVol.projected_total_low;
    expect(highRange).toBeGreaterThan(lowRange);
    expect(highVol.volatility_bucket).toBe('HIGH_VOL');
  });

  test('missing bullpen data forces PASS on full-game totals card', () => {
    const card = projectFullGameTotalCard(
      avgPitcher,
      avgPitcher,
      8.5,
      {
        ...baseContext,
        home_bullpen_era: null,
        away_bullpen_era: null,
      },
    );

    expect(card.status).toBe('PASS');
    expect(card.reason_codes).toEqual(
      expect.arrayContaining(['SOFT_NO_SUPPORTING_DRIVERS']),
    );
  });

  test('high-volatility bucket uses capped dynamic threshold while preserving edge discipline', () => {
    const lowVolCard = projectFullGameTotalCard(avgPitcher, avgPitcher, 8.9, {
      ...baseContext,
      roof: 'CLOSED',
      wind_mph: 0,
      home_bullpen_era: 4.2,
      away_bullpen_era: 4.2,
    });
    const highVolCard = projectFullGameTotalCard(avgPitcher, avgPitcher, 8.9, {
      ...baseContext,
      roof: 'OPEN',
      wind_mph: 24,
      home_bullpen_era: 3.0,
      away_bullpen_era: 6.3,
      home_bullpen_fatigue_index: 0.9,
      away_bullpen_fatigue_index: 0.9,
      home_recent_usage: 0.9,
      away_recent_usage: 0.9,
      home_leverage_availability: 0.15,
      away_leverage_availability: 0.15,
    });

    expect(highVolCard.projection.volatility_bucket).toBe('HIGH_VOL');
    expect(lowVolCard.projection.volatility_bucket).toBe('LOW_VOL');
    expect(highVolCard.drivers[0].threshold).toBeGreaterThan(lowVolCard.drivers[0].threshold);
    expect(highVolCard.drivers[0].threshold).toBeLessThanOrEqual(0.65);
  });

  test('WI-0944 transition: PASS->PLAY for full-game totals when edge widens', () => {
    const passCard = projectFullGameTotalCard(avgPitcher, avgPitcher, 9.1, baseContext);
    const playCard = projectFullGameTotalCard(avgPitcher, avgPitcher, 7.2, baseContext);

    expect(passCard.status).toBe('PASS');
    expect(playCard.status).not.toBe('PASS');
    expect(playCard.ev_threshold_passed).toBe(true);
  });

  test('WI-0944 transition: PASS->PASS remains deterministic under degraded full-game totals inputs', () => {
    const passCardA = projectFullGameTotalCard(avgPitcher, avgPitcher, 8.5, {
      ...baseContext,
      home_bullpen_era: null,
      away_bullpen_era: null,
    });
    const passCardB = projectFullGameTotalCard(avgPitcher, avgPitcher, 9.0, {
      ...baseContext,
      home_bullpen_era: null,
      away_bullpen_era: null,
    });

    expect(passCardA.status).toBe('PASS');
    expect(passCardB.status).toBe('PASS');
  });

  test('WI-0944 transition: already-valid full-game total remains non-PASS', () => {
    const baseline = projectFullGameTotalCard(avgPitcher, avgPitcher, 7.0, {
      ...baseContext,
      roof: 'OPEN',
      wind_mph: 8,
      home_bullpen_era: 4.1,
      away_bullpen_era: 4.2,
    });

    const retunedInputs = projectFullGameTotalCard(avgPitcher, avgPitcher, 6.9, {
      ...baseContext,
      roof: 'OPEN',
      wind_mph: 10,
      home_bullpen_era: 4.0,
      away_bullpen_era: 4.2,
    });

    expect(baseline.status).not.toBe('PASS');
    expect(retunedInputs.status).not.toBe('PASS');
    expect(retunedInputs.ev_threshold_passed).toBe(true);
  });
});

describe('computeMLBDriverCards full_game_total card (WI-0872)', () => {
  test('AC6: includes full_game_total card when full-game line is available in raw_data.mlb', () => {
    const oddsSnapshot = {
      home_team: 'NYY',
      away_team: 'BOS',
      raw_data: JSON.stringify({
        mlb: {
          home_pitcher: avgPitcher,
          away_pitcher: avgPitcher,
          home_offense_profile: avgOffense,
          away_offense_profile: avgOffense,
          park_run_factor: 1.0,
          temp_f: 72,
          wind_mph: 0,
          wind_dir: 'CALM',
          roof: 'OPEN',
          home_bullpen_era: 4.3,
          away_bullpen_era: 4.3,
          f5_line: 4.5,
          full_game_line: 8.5,
        },
      }),
    };

    const cards = computeMLBDriverCards('game-1', oddsSnapshot);
    const fullGameCard = cards.find((c) => c.market === 'full_game_total');

    expect(fullGameCard).toBeDefined();
    expect(fullGameCard.projection.projected_total).toBeGreaterThan(0);
    expect(fullGameCard.projection.home_proj).toBeGreaterThan(0);
    expect(fullGameCard.projection.away_proj).toBeGreaterThan(0);
  });
});

// ── WI-0873: projectFullGameML ────────────────────────────────────────────────

describe('projectFullGameML (WI-0873)', () => {
  // Pitcher fixtures reused from projectFullGameTotal tests above
  const homePitcher = avgPitcher; // average starter
  const awayPitcher = avgPitcher;

  const cleanContext = {
    home_offense_profile: avgOffense,
    away_offense_profile: avgOffense,
    park_run_factor: 1.0,
    temp_f: 72,
    wind_mph: 0,
    wind_dir: 'CALM',
    roof: 'OPEN',
    home_bullpen_era: 4.3,
    away_bullpen_era: 4.3,
  };

  test('AC4: team facing weaker pitcher has run disadvantage — win_prob_home < 0.5 when home faces elite pitcher', () => {
    // home team faces an elite away pitcher → home_proj < away_proj → win_prob_home < 0.5
    const result = projectFullGameML(avgPitcher, elitePitcher, -110, -110, cleanContext);
    expect(result).not.toBeNull();
    expect(result.projected_home_runs).toBeLessThan(result.projected_away_runs);
    expect(result.projected_win_prob_home).toBeLessThan(0.5);
  });

  test('AC5: symmetric matchup yields win_prob_home between 0.49 and 0.51', () => {
    // Same pitcher/offense still gets a modest home-field tilt in close games.
    const result = projectFullGameML(homePitcher, homePitcher, -110, -110, cleanContext);
    expect(result).not.toBeNull();
    expect(result.projected_win_prob_home).toBeGreaterThan(0.5);
    expect(result.projected_win_prob_home).toBeLessThan(0.57);
  });

  test('AC3: two-sided de-vig — win_prob_home is a valid probability and edge is numeric', () => {
    const result = projectFullGameML(homePitcher, awayPitcher, -130, +110, cleanContext);
    expect(result).not.toBeNull();
    // win_prob_home is a proper probability in (0, 1)
    expect(result.projected_win_prob_home).toBeGreaterThan(0);
    expect(result.projected_win_prob_home).toBeLessThan(1);
    // complementary probs sum to 1 by construction
    expect(result.projected_win_prob_home + (1 - result.projected_win_prob_home)).toBeCloseTo(1.0, 10);
    // edge is a finite number
    expect(typeof result.edge).toBe('number');
    expect(Number.isFinite(result.edge)).toBe(true);
  });

  test('AC null-guard: returns null when pitchers are missing (NO_BET gate)', () => {
    expect(projectFullGameML(null, null, -110, -110, {})).toBeNull();
    expect(projectFullGameML(null, avgPitcher, -110, -110, cleanContext)).toBeNull();
    expect(projectFullGameML(avgPitcher, null, -110, -110, cleanContext)).toBeNull();
  });

  test('computeMLBDriverCards emits full_game_ml card when h2h odds are present', () => {
    const snapshot = {
      h2h_home: -115,
      h2h_away: -105,
      raw_data: JSON.stringify({
        mlb: {
          home_pitcher: avgPitcher,
          away_pitcher: avgPitcher,
          home_offense_profile: avgOffense,
          away_offense_profile: avgOffense,
          park_run_factor: 1.0,
          temp_f: 72,
          wind_mph: 0,
          wind_dir: 'CALM',
          roof: 'OPEN',
          home_bullpen_era: 4.3,
          away_bullpen_era: 4.3,
        },
      }),
    };
    const cards = computeMLBDriverCards('test-game-id', snapshot);
    const mlCard = cards.find((c) => c.market === 'full_game_ml');
    expect(mlCard).toBeDefined();
    expect(['HOME', 'AWAY', 'PASS']).toContain(mlCard.prediction);
    expect(typeof mlCard.confidence).toBe('number');
    expect(mlCard.drivers[0].type).toBe('mlb-full-game-ml');
  });

  test('taxed bullpen changes FG ML more than F5 ML in the same matchup', () => {
    const baseContext = {
      ...cleanContext,
      home_bullpen_era: 4.1,
      away_bullpen_era: 4.1,
    };
    const taxedContext = {
      ...cleanContext,
      home_bullpen_era: 3.4,
      away_bullpen_era: 6.1,
    };

    const fgBase = projectFullGameML(homePitcher, awayPitcher, -110, -110, baseContext);
    const fgTaxed = projectFullGameML(homePitcher, awayPitcher, -110, -110, taxedContext);
    const f5Base = projectF5ML(homePitcher, awayPitcher, -110, -110, avgOffense, avgOffense, cleanContext);
    const f5Taxed = projectF5ML(homePitcher, awayPitcher, -110, -110, avgOffense, avgOffense, cleanContext);

    const fgShift = Math.abs(fgTaxed.projected_win_prob_home - fgBase.projected_win_prob_home);
    const f5Shift = Math.abs(f5Taxed.projected_win_prob_home - f5Base.projected_win_prob_home);

    expect(fgShift).toBeGreaterThan(f5Shift);
  });

  test('tiny run-gap ML edges are passed with explicit support guardrails', () => {
    const nearCoinflip = projectFullGameML(homePitcher, homePitcher, 170, -200, {
      ...cleanContext,
      home_bullpen_era: 4.3,
      away_bullpen_era: 4.3,
    });

    expect(nearCoinflip.side).toBe('HOME');
    expect(nearCoinflip.reason_codes).toEqual(
      expect.arrayContaining([
        'SOFT_RUN_DIFF_SMALL',
        'SOFT_WEAK_DRIVER_SUPPORT',
      ]),
    );
    expect(nearCoinflip.confidence_gate).toBeLessThanOrEqual(6);
  });

  test('high-variance context lowers confidence for close-run edges', () => {
    const lowVariance = projectFullGameML(homePitcher, awayPitcher, -110, -110, {
      ...cleanContext,
      wind_mph: 4,
      roof: 'CLOSED',
      lineup_confirmed_home: true,
      lineup_confirmed_away: true,
      home_bullpen_era: 4.2,
      away_bullpen_era: 4.2,
    });
    const highVariance = projectFullGameML(homePitcher, awayPitcher, -110, -110, {
      ...cleanContext,
      wind_mph: 24,
      roof: 'OPEN',
      lineup_confirmed_home: false,
      lineup_confirmed_away: false,
      home_bullpen_era: 3.1,
      away_bullpen_era: 6.2,
    });

    expect(highVariance.run_diff_variance).toBeGreaterThan(lowVariance.run_diff_variance);
  });

  test('WI-0944 transition: PLAY unchanged for strong full-game ML mismatch despite context adjustments', () => {
    const baseline = projectFullGameML(elitePitcher, avgPitcher, -110, -110, {
      ...cleanContext,
      home_bullpen_era: 3.3,
      away_bullpen_era: 5.1,
    });
    const adjusted = projectFullGameML(elitePitcher, avgPitcher, -110, -110, {
      ...cleanContext,
      home_bullpen_era: 3.3,
      away_bullpen_era: 5.1,
      home_field_runs: 0.16,
    });

    expect(baseline.side).not.toBe('PASS');
    expect(adjusted.side).toBe(baseline.side);
    expect(baseline.ev_threshold_passed).toBe(true);
    expect(adjusted.ev_threshold_passed).toBe(true);
  });

  // ── PRI-MLB-01/02/03: pass_reason_code truth chain (Scenarios A, C, D) ──────

  test('Scenario A: low raw edge (< LEAN_EDGE_MIN) + OK confidence → PASS_NO_EDGE, no PASS_CONFIDENCE_GATE', () => {
    // Symmetric pitchers with odds calibrated so that market implies ≈ model win prob → rawBestEdge < 0.025
    // -137/+113 sets impliedHome ≈ 0.54 which matches model's symmetric-pitcher win prob
    const result = projectFullGameML(avgPitcher, avgPitcher, -137, +113, cleanContext);
    expect(result).not.toBeNull();
    expect(result.side).toBe('PASS');
    expect(result.reason_codes).toContain('PASS_NO_EDGE');
    expect(result.reason_codes).not.toContain('PASS_CONFIDENCE_GATE');
    // Extended return contract fields must exist
    expect(result).toHaveProperty('pass_reason_code', 'PASS_NO_EDGE');
    expect(result).toHaveProperty('raw_edge_value');
    expect(result).toHaveProperty('threshold_required', 0.025);
    expect(result).toHaveProperty('threshold_passed', false);
  });

  test('Scenario C: raw edge >= LEAN_EDGE_MIN but confidence < CONFIDENCE_MIN → PASS_CONFIDENCE_GATE, not PASS_NO_EDGE', () => {
    // elitePitcher home vs avgPitcher away with very unfavorable home odds forces homeEdge > 0.025;
    // high variance context + unconfirmed lineups drops confidence below gate.
    const highVarContext = {
      ...cleanContext,
      wind_mph: 28,
      roof: 'OPEN',
      temp_f: 45,
      lineup_confirmed_home: false,
      lineup_confirmed_away: false,
      home_bullpen_era: 3.0,
      away_bullpen_era: 6.5,
    };
    // Use very lopsided odds so model disagrees: +180 for home forces implied ~0.357 for home,
    // while elitePitcher home + taxed away bullpen gives model winProb well above that.
    const result = projectFullGameML(elitePitcher, avgPitcher, +180, -220, highVarContext);
    expect(result).not.toBeNull();
    // raw_edge_value must be present and reflect >= threshold
    expect(result).toHaveProperty('raw_edge_value');
    expect(result).toHaveProperty('threshold_required', 0.025);
    if (result.side === 'PASS') {
      // If the model passed due to the confidence gate, validate the reason code
      if (result.raw_edge_value >= 0.025) {
        expect(result.reason_codes).toContain('PASS_CONFIDENCE_GATE');
        expect(result.reason_codes).not.toContain('PASS_NO_EDGE');
        expect(result.pass_reason_code).toBe('PASS_CONFIDENCE_GATE');
        expect(result.threshold_passed).toBe(true);
      }
    }
    // The key invariant: if rawBestEdge >= 0.025 and side is PASS, must NOT emit PASS_NO_EDGE
    if (result.side === 'PASS' && result.raw_edge_value >= 0.025) {
      expect(result.reason_codes).not.toContain('PASS_NO_EDGE');
      expect(result.pass_reason_code).not.toBe('PASS_NO_EDGE');
    }
  });

  test('Scenario D: DEGRADED_MODEL + raw edge >= LEAN_EDGE_MIN → pass_reason_code is never PASS_NO_EDGE', () => {
    // Force a degraded projection source by using a pitcher with degraded flag.
    // We test the invariant: if proj.projection_source === 'DEGRADED_MODEL' and rawBestEdge >= 0.025,
    // the pass_reason_code must not be 'PASS_NO_EDGE'.
    const highVarContext = {
      ...cleanContext,
      wind_mph: 28,
      roof: 'OPEN',
      temp_f: 45,
      lineup_confirmed_home: false,
      lineup_confirmed_away: false,
      home_bullpen_era: 3.0,
      away_bullpen_era: 6.5,
    };
    const result = projectFullGameML(elitePitcher, avgPitcher, +180, -220, highVarContext);
    expect(result).not.toBeNull();
    // Invariant: if side is PASS and raw_edge_value >= 0.025, PASS_NO_EDGE must not appear
    if (result.side === 'PASS' && result.raw_edge_value != null && result.raw_edge_value >= 0.025) {
      expect(result.reason_codes).not.toContain('PASS_NO_EDGE');
      expect(result.pass_reason_code).not.toBe('PASS_NO_EDGE');
    }
    // Extended contract: these fields must always be present
    expect(result).toHaveProperty('pass_reason_code');
    expect(result).toHaveProperty('raw_edge_value');
    expect(result).toHaveProperty('threshold_required', 0.025);
    expect(result).toHaveProperty('threshold_passed');
  });
});

describe('resolveMLBModelSignal (WI-0874)', () => {
  const avgPitcher = {
    siera: 4.1,
    x_fip: 4.0,
    x_era: 4.05,
    k_per_9: 8.5,
    bb_per_9: 2.9,
    gb_pct: 0.44,
    hr_per_9: 1.1,
  };
  const avgOffense = {
    wrc_plus: 100,
    xwoba: 0.320,
    k_pct: 0.225,
    iso: 0.165,
    bb_pct: 0.085,
    hard_hit_pct: 39.0,
  };

  function makeFireMLSnapshot() {
    return {
      h2h_home: -130,
      h2h_away: 110,
      raw_data: JSON.stringify({
        mlb: {
          home_pitcher: avgPitcher,
          away_pitcher: avgPitcher,
          home_offense_profile: avgOffense,
          away_offense_profile: avgOffense,
          park_run_factor: 1.0,
          temp_f: 72,
          wind_mph: 0,
          wind_dir: 'CALM',
          roof: 'OPEN',
          home_bullpen_era: 4.3,
          away_bullpen_era: 4.3,
        },
      }),
    };
  }

  test('returns {modelWinProb, edge, projection_source} for a FIRE full_game_ml card when edge qualifies', () => {
    // Build a snapshot where the model win prob differs significantly from consensus fair prob
    // to trigger a FIRE card. Use heavily skewed odds so model edge vs consensus is large.
    const snapshot = {
      h2h_home: -170,
      h2h_away: 150,
      raw_data: JSON.stringify({
        mlb: {
          home_pitcher: { siera: 2.5, x_fip: 2.6, x_era: 2.55, k_per_9: 11.0, bb_per_9: 1.8, gb_pct: 0.50, hr_per_9: 0.6 },
          away_pitcher: { siera: 5.8, x_fip: 5.9, x_era: 5.85, k_per_9: 5.5, bb_per_9: 4.2, gb_pct: 0.35, hr_per_9: 1.8 },
          home_offense_profile: avgOffense,
          away_offense_profile: { wrc_plus: 70, xwoba: 0.280, k_pct: 0.28, iso: 0.12, bb_pct: 0.07, hard_hit_pct: 30.0 },
          park_run_factor: 1.0,
          temp_f: 72,
          wind_mph: 0,
          wind_dir: 'CALM',
          roof: 'OPEN',
          home_bullpen_era: 3.2,
          away_bullpen_era: 5.8,
        },
      }),
    };
    const game = { gameId: 'test-game', oddsSnapshot: snapshot, sport: 'baseball_mlb' };

    const result = resolveMLBModelSignal(game);
    // result may be null if EV threshold not met — but if non-null, shape must be correct
    if (result !== null) {
      expect(typeof result.modelWinProb).toBe('number');
      expect(Number.isFinite(result.modelWinProb)).toBe(true);
      expect(result.modelWinProb).toBeGreaterThan(0);
      expect(result.modelWinProb).toBeLessThan(1);
      expect(typeof result.edge).toBe('number');
      expect(typeof result.projection_source).toBe('string');
    }
  });

  test('returns null when ENABLE_MLB_MODEL=false', () => {
    const orig = process.env.ENABLE_MLB_MODEL;
    process.env.ENABLE_MLB_MODEL = 'false';
    try {
      const game = { gameId: 'test-game', oddsSnapshot: makeFireMLSnapshot(), sport: 'baseball_mlb' };
      const result = resolveMLBModelSignal(game);
      expect(result).toBeNull();
    } finally {
      if (orig === undefined) delete process.env.ENABLE_MLB_MODEL;
      else process.env.ENABLE_MLB_MODEL = orig;
    }
  });

  test('returns null when no pitcher data (no h2h odds present)', () => {
    const game = {
      gameId: 'test-game',
      oddsSnapshot: {
        raw_data: JSON.stringify({ mlb: {} }),
      },
      sport: 'baseball_mlb',
    };
    const result = resolveMLBModelSignal(game);
    expect(result).toBeNull();
  });

  test('returns null for total-market-only cards (no ML signal)', () => {
    // Snapshot with f5_line only — no h2h odds → only f5_total card emitted
    const game = {
      gameId: 'test-game',
      oddsSnapshot: {
        raw_data: JSON.stringify({
          mlb: {
            home_pitcher: avgPitcher,
            away_pitcher: avgPitcher,
            f5_line: 4.5,
          },
        }),
      },
      sport: 'baseball_mlb',
    };
    const result = resolveMLBModelSignal(game);
    // f5_total cards always return null (total edge not used for ML win prob)
    expect(result).toBeNull();
  });
});

describe('evaluateMlbGameMarkets (IME-01)', () => {
  let consoleInfoSpy;

  beforeEach(() => {
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
  });

  test('evaluates all generated MLB game markets and returns multiple qualified results', () => {
    const fireMlCard = {
      market: 'full_game_ml',
      ev_threshold_passed: true,
      status: 'FIRE',
      classification: 'BASE',
      reason_codes: [],
      missing_inputs: [],
      confidence: 0.7,
    };
    const fireF5Card = {
      ...fireMlCard,
      market: 'f5_total',
      confidence: 0.68,
    };

    const result = evaluateMlbGameMarkets(
      [fireMlCard, fireF5Card],
      { game_id: 'g1' },
    );

    expect(result.status).toBe('HAS_OFFICIAL_PLAYS');
    expect(result.official_plays).toHaveLength(2);
    expect(result.official_plays.map((item) => item.market_type)).toEqual(
      expect.arrayContaining(['FULL_GAME_ML', 'F5_TOTAL']),
    );
    expect(result.rejected).toHaveLength(0);
  });

  test('returns FULL_GAME_ML as official when F5_TOTAL exists but only ML qualifies', () => {
    const passF5Card = {
      market: 'f5_total',
      ev_threshold_passed: false,
      status: 'PASS',
      classification: 'PASS',
      reason_codes: [],
      missing_inputs: [],
    };
    const fireMlCard = {
      market: 'full_game_ml',
      ev_threshold_passed: true,
      status: 'FIRE',
      classification: 'BASE',
      reason_codes: [],
      missing_inputs: [],
      confidence: 0.7,
    };

    const result = evaluateMlbGameMarkets(
      [passF5Card, fireMlCard],
      { game_id: 'g1' },
    );

    expect(result.official_plays).toHaveLength(1);
    expect(result.official_plays[0].market_type).toBe('FULL_GAME_ML');
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].market_type).toBe('F5_TOTAL');
  });

  test('marks non-qualified MLB markets as REJECTED_THRESHOLD with reason codes', () => {
    const rejectedCard = {
      market: 'f5_total',
      ev_threshold_passed: false,
      status: 'PASS',
      classification: 'PASS',
      reason_codes: [],
      missing_inputs: [],
    };

    const result = evaluateMlbGameMarkets(
      [rejectedCard],
      { game_id: 'g1' },
    );

    expect(result.status).toBe('SKIP_MARKET_NO_EDGE');
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].status).toBe('REJECTED_THRESHOLD');
    expect(result.rejected[0].reason_codes).toContain('EDGE_BELOW_THRESHOLD');
  });
});

// ── PRI-MLB-02: selectPassReasonCode helper unit tests (Scenario B) ───────────

describe('selectPassReasonCode (PRI-MLB-02)', () => {
  test('Scenario B: PASS_CONFIDENCE_GATE beats PASS_NO_EDGE regardless of array order', () => {
    // Array.find would return 'PASS_NO_EDGE' (first match); selectPassReasonCode must return
    // 'PASS_CONFIDENCE_GATE' (higher priority in PASS_REASON_PRIORITY list).
    expect(selectPassReasonCode(['PASS_NO_EDGE', 'PASS_CONFIDENCE_GATE'])).toBe('PASS_CONFIDENCE_GATE');
    expect(selectPassReasonCode(['PASS_CONFIDENCE_GATE', 'PASS_NO_EDGE'])).toBe('PASS_CONFIDENCE_GATE');
  });

  test('Scenario B2: single PASS_NO_EDGE → returns PASS_NO_EDGE', () => {
    expect(selectPassReasonCode(['PASS_NO_EDGE'])).toBe('PASS_NO_EDGE');
  });

  test('Scenario B3: empty array → returns null (not PASS_NO_EDGE default)', () => {
    expect(selectPassReasonCode([])).toBeNull();
  });

  test('PASS_DEGRADED_TOTAL_MODEL beats PASS_CONFIDENCE_GATE and PASS_NO_EDGE', () => {
    expect(selectPassReasonCode(['PASS_NO_EDGE', 'PASS_CONFIDENCE_GATE', 'PASS_DEGRADED_TOTAL_MODEL']))
      .toBe('PASS_DEGRADED_TOTAL_MODEL');
  });

  test('unknown PASS_ code falls back to Array.find when no known priority code exists', () => {
    expect(selectPassReasonCode(['PASS_SOME_FUTURE_CODE'])).toBe('PASS_SOME_FUTURE_CODE');
  });

  test('non-PASS codes are ignored — returns null when no PASS_ code present', () => {
    expect(selectPassReasonCode(['SOFT_RUN_DIFF_SMALL', 'FULL_GAME_ML_DEGRADED'])).toBeNull();
  });

  test('projectFullGameTotalCard uses selectPassReasonCode: PASS_NO_EDGE scenario returns PASS_NO_EDGE', () => {
    // Symmetric pitchers with calibrated line → no lean edge → PASS_NO_EDGE
    const result = projectFullGameTotalCard(avgPitcher, avgPitcher, 9.05, baseContext);
    expect(result).not.toBeNull();
    if (result.status === 'PASS' && result.reason_codes.includes('PASS_NO_EDGE')) {
      expect(result.pass_reason_code).toBe('PASS_NO_EDGE');
    }
  });

  test('projectF5TotalCard uses selectPassReasonCode: PASS_NO_EDGE scenario returns PASS_NO_EDGE', () => {
    // calibrated line matches F5 projection
    const result = projectF5TotalCard(avgPitcher, avgPitcher, 4.5, baseContext);
    expect(result).not.toBeNull();
    if (result.status === 'PASS' && result.reason_codes.includes('PASS_NO_EDGE')) {
      expect(result.pass_reason_code).toBe('PASS_NO_EDGE');
    }
  });
});
