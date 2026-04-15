'use strict';
// WI-0820: Input gate regression tests for mlb-model.js
// Verifies NO_BET / DEGRADED paths wired into projectF5Total and projectStrikeouts.

const {
  projectF5Total,
  projectStrikeouts,
  projectFullGameTotalCard,
} = require('../mlb-model');

// ---------------------------------------------------------------------------
// Fixtures — mirrors shapes from run_mlb_model.test.js
// ---------------------------------------------------------------------------
const validHome = {
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
  times_through_order_profile: { '1st': 0.296, '2nd': 0.312, '3rd': 0.337 },
};

const validAway = {
  era: 4.1,
  whip: 1.28,
  k_per_9: 8.6,
  handedness: 'L',
  siera: 3.98,
  x_fip: 3.95,
  x_era: 4.08,
  bb_pct: 0.083,
  gb_pct: 41.5,
  hr_per_9: 1.14,
  season_k_pct: 0.238,
  xwoba_allowed: 0.326,
  avg_ip: 5.4,
  pitch_count_avg: 91,
  times_through_order_profile: { '1st': 0.302, '2nd': 0.319, '3rd': 0.346 },
};

const validContext = {
  home_offense_profile: {
    wrc_plus_vs_lhp: 118,
    k_pct_vs_lhp: 0.208,
    iso_vs_lhp: 0.201,
    bb_pct_vs_lhp: 0.089,
    xwoba_vs_lhp: 0.341,
    hard_hit_pct: 42.1,
    rolling_14d_wrc_plus_vs_lhp: 112,
  },
  away_offense_profile: {
    wrc_plus_vs_rhp: 94,
    k_pct_vs_rhp: 0.247,
    iso_vs_rhp: 0.142,
    bb_pct_vs_rhp: 0.077,
    xwoba_vs_rhp: 0.308,
    hard_hit_pct: 36.8,
    rolling_14d_wrc_plus_vs_rhp: 91,
  },
  park_run_factor: 1.04,
  temp_f: 82,
  wind_mph: 12,
  wind_dir: 'OUT',
  roof: 'OPEN',
};

// ---------------------------------------------------------------------------
// projectF5Total gate tests
// ---------------------------------------------------------------------------
describe('projectF5Total — WI-0820 input gate', () => {
  test('null pitchers → NO_BET (gate intercepts, no SYNTHETIC_FALLBACK)', () => {
    const result = projectF5Total(null, null, {});
    expect(result.status).toBe('NO_BET');
    expect(result.projection_source).toBe('NO_BET');
    expect(result.missingCritical).toEqual(
      expect.arrayContaining(['starter_skill_ra9_home', 'starter_skill_ra9_away']),
    );
    expect(result.confidence).toBe(0);
  });

  test('missing park_run_factor → NO_BET', () => {
    const result = projectF5Total(validHome, validAway, {
      home_offense_profile: validContext.home_offense_profile,
      away_offense_profile: validContext.away_offense_profile,
      park_run_factor: null,
    });
    expect(result.status).toBe('NO_BET');
    expect(result.projection_source).toBe('NO_BET');
    expect(result.missingCritical).toContain('park_run_factor');
  });

  test('missing offense profiles → NO_BET (wrc_plus_vs_hand required)', () => {
    const result = projectF5Total(validHome, validAway, {
      park_run_factor: 1.04,
      home_offense_profile: null,
      away_offense_profile: null,
    });
    expect(result.status).toBe('NO_BET');
    expect(result.projection_source).toBe('NO_BET');
    expect(result.missingCritical).toEqual(
      expect.arrayContaining(['wrc_plus_vs_hand_home', 'wrc_plus_vs_hand_away']),
    );
  });

  test('full valid inputs → not NO_BET (no SYNTHETIC_FALLBACK in projection_source)', () => {
    const result = projectF5Total(validHome, validAway, validContext);
    // Should not trap in gate
    expect(result.status).not.toBe('NO_BET');
    // Should not use old SYNTHETIC_FALLBACK path
    expect(result.projection_source).not.toBe('SYNTHETIC_FALLBACK');
  });
});

// ---------------------------------------------------------------------------
// projectStrikeouts gate tests
// ---------------------------------------------------------------------------
describe('projectStrikeouts — WI-0820 input gate', () => {
  test('missing k_per_9 → NO_BET (was null return)', () => {
    const result = projectStrikeouts({}, 7.5);
    expect(result.status).toBe('NO_BET');
    expect(result.missingCritical).toContain('k_per_9');
    expect(result.projection_source).toBe('NO_BET');
    expect(result.sport).toBe('mlb');
    expect(result.market).toBe('strikeouts');
  });

  test('k_per_9 explicitly null → NO_BET', () => {
    const result = projectStrikeouts({ k_per_9: null }, 7.5);
    expect(result.status).toBe('NO_BET');
  });

  test('valid k_per_9 → produces a real projection (not NO_BET)', () => {
    const result = projectStrikeouts({ k_per_9: 9.4 }, 7.5);
    expect(result.status).not.toBe('NO_BET');
    expect(result.projected).toBeDefined();
  });
});

describe('projectFullGameTotalCard — WI-0944 gate semantics', () => {
  const baseFgContext = {
    home_offense_profile: {
      wrc_plus_vs_lhp: 118,
      xwoba_vs_lhp: 0.341,
      rolling_14d_wrc_plus_vs_lhp: 112,
    },
    away_offense_profile: {
      wrc_plus_vs_rhp: 94,
      xwoba_vs_rhp: 0.308,
      rolling_14d_wrc_plus_vs_rhp: 91,
    },
    park_run_factor: 1.04,
    temp_f: 82,
    wind_mph: 12,
    wind_dir: 'OUT',
    roof: 'OPEN',
    home_bullpen_era: 4.2,
    away_bullpen_era: 4.3,
    home_bullpen_fatigue_index: 0.5,
    away_bullpen_fatigue_index: 0.5,
    home_leverage_availability: 0.7,
    away_leverage_availability: 0.7,
    home_recent_usage: 0.5,
    away_recent_usage: 0.5,
    f5_line: 4.5,
  };

  test('edge below threshold remains PASS and preserves PASS reason continuity', () => {
    const result = projectFullGameTotalCard(
      validHome,
      validAway,
      8.5,
      baseFgContext,
    );

    expect(result).toBeTruthy();
    expect(result.status).toBe('PASS');
    expect(result.pass_reason_code).toBe('PASS_NO_EDGE');
    expect(result.reason_codes).toEqual(
      expect.arrayContaining(['PASS_NO_EDGE']),
    );
  });

  test('confidence below threshold remains PASS with PASS_CONFIDENCE_GATE', () => {
    const lowConfidenceContext = {
      ...baseFgContext,
      // Force DEGRADED_MODEL confidence cap path (max confidence 6/10),
      // then keep edge strong enough that confidence is the deciding hard gate.
      temp_f: null,
      wind_mph: null,
      wind_dir: null,
      roof: null,
      f5_line: 4.2,
    };

    const result = projectFullGameTotalCard(
      validHome,
      validAway,
      7.0,
      lowConfidenceContext,
    );

    expect(result).toBeTruthy();
    expect(result.status).toBe('PASS');
    expect(result.reason_codes).toEqual(
      expect.arrayContaining(['PASS_CONFIDENCE_GATE']),
    );
    expect(result.pass_reason_code).toBe('PASS_CONFIDENCE_GATE');
  });

  test('contradiction path is soft: candidate can still emit non-PASS when edge survives', () => {
    const contradictionContext = {
      ...baseFgContext,
      // Push F5 edge positive while forcing full-game edge negative.
      f5_line: 4.0,
      // Increase bullpen asymmetry to trigger contradiction flag path.
      home_bullpen_era: 2.8,
      away_bullpen_era: 6.4,
      home_bullpen_fatigue_index: 0.1,
      away_bullpen_fatigue_index: 0.95,
      home_leverage_availability: 0.95,
      away_leverage_availability: 0.1,
      home_recent_usage: 0.1,
      away_recent_usage: 0.95,
    };

    const result = projectFullGameTotalCard(
      validHome,
      validAway,
      11.2,
      contradictionContext,
    );

    expect(result).toBeTruthy();
    expect(result.reason_codes).toEqual(
      expect.arrayContaining(['SOFT_F5_CONTRADICTION']),
    );
    expect(result.status).not.toBe('PASS');
    expect(result.ev_threshold_passed).toBe(true);
  });
});
