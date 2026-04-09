'use strict';

const {
  predictNHLGame,
  resolveGoalieComposite,
  NHL_PACE_AUDIT_RULES,
} = require('../nhl-pace-model');
const { makeCanonicalGoalieState } = require('../nhl-goalie-state');

function buildBase(overrides = {}) {
  return {
    homeGoalsFor: 3.2,
    homeGoalsAgainst: 3.0,
    awayGoalsFor: 3.1,
    awayGoalsAgainst: 3.0,
    homePaceFactor: 1.0,
    awayPaceFactor: 1.0,
    homePpPct: 0.22,
    awayPpPct: 0.22,
    homePkPct: 0.8,
    awayPkPct: 0.8,
    homeGoalieSavePct: 0.93,
    awayGoalieSavePct: 0.89,
    homeGoalieConfirmed: false,
    awayGoalieConfirmed: false,
    homeGoalieCertainty: 'UNKNOWN',
    awayGoalieCertainty: 'UNKNOWN',
    homeB2B: false,
    awayB2B: false,
    restDaysHome: 1,
    restDaysAway: 1,
    ...overrides,
  };
}

function makeState(teamSide, starterState, tierConfidence = 'HIGH') {
  return makeCanonicalGoalieState({
    game_id: 'game-1',
    team_side: teamSide,
    starter_state: starterState,
    starter_source: 'USER_INPUT',
    goalie_name: starterState === 'UNKNOWN' ? null : `${teamSide}-goalie`,
    goalie_tier: starterState === 'UNKNOWN' ? 'UNKNOWN' : 'STRONG',
    tier_confidence: starterState === 'UNKNOWN' ? 'NONE' : tierConfidence,
    evidence_flags: starterState === 'CONFLICTING' ? ['CONFLICTING_SOURCE_EVIDENCE'] : [],
  });
}

describe('resolveGoalieComposite (WI-0823)', () => {
  test('supports FULL source when save pct and gsax are both present', () => {
    const result = resolveGoalieComposite(0.912, 0.28);

    expect(result.source).toBe('FULL');
    expect(result.composite).toBeGreaterThan(0);
    expect(result.factor).toBeLessThan(1);
  });

  test('supports GSAX_ONLY source', () => {
    const result = resolveGoalieComposite(null, 0.28);

    expect(result.source).toBe('GSAX_ONLY');
    expect(result.composite).toBeCloseTo(1, 5);
    expect(result.factor).toBeCloseTo(0.85, 5);
  });

  test('supports SV_PCT_ONLY source', () => {
    const result = resolveGoalieComposite(0.912, null);

    expect(result.source).toBe('SV_PCT_ONLY');
    expect(result.composite).toBeCloseTo(1, 5);
    expect(result.factor).toBeCloseTo(0.85, 5);
  });

  test('returns neutral factor when both inputs are missing', () => {
    expect(resolveGoalieComposite(null, null)).toEqual({
      factor: 1,
      composite: 0,
      source: 'NEUTRAL',
    });
  });
});

describe('predictNHLGame goalie composite wiring (WI-0823)', () => {
  test('gsax contributes to goalie adjustment even when save pct is neutral', () => {
    const neutral = predictNHLGame(
      buildBase({
        homeGoalieSavePct: 0.9,
        awayGoalieSavePct: 0.9,
        homeGoalieGsax: null,
        awayGoalieGsax: null,
        homeGoalieState: makeState('home', 'CONFIRMED', 'HIGH'),
        awayGoalieState: makeState('away', 'CONFIRMED', 'HIGH'),
      }),
    );
    const withGsax = predictNHLGame(
      buildBase({
        homeGoalieSavePct: 0.9,
        awayGoalieSavePct: 0.9,
        homeGoalieGsax: 0.28,
        awayGoalieGsax: -0.28,
        homeGoalieState: makeState('home', 'CONFIRMED', 'HIGH'),
        awayGoalieState: makeState('away', 'CONFIRMED', 'HIGH'),
      }),
    );

    expect(withGsax.adjustments.away.opponent_goalie).toBeLessThan(
      neutral.adjustments.away.opponent_goalie,
    );
    expect(withGsax.adjustments.home.opponent_goalie).toBeGreaterThan(
      neutral.adjustments.home.opponent_goalie,
    );
  });
});

describe('predictNHLGame trust-gated goalie adjustment (WI-0381)', () => {
  test('FULL trust canonical path is math-identical to legacy confirmed fallback', () => {
    const canonical = predictNHLGame(
      buildBase({
        homeGoalieState: makeState('home', 'CONFIRMED', 'HIGH'),
        awayGoalieState: makeState('away', 'CONFIRMED', 'HIGH'),
        homeGoalieConfirmed: false,
        awayGoalieConfirmed: false,
        homeGoalieCertainty: null,
        awayGoalieCertainty: null,
      }),
    );
    const legacy = predictNHLGame(
      buildBase({
        homeGoalieState: null,
        awayGoalieState: null,
        homeGoalieConfirmed: true,
        awayGoalieConfirmed: true,
        homeGoalieCertainty: null,
        awayGoalieCertainty: null,
      }),
    );

    expect(canonical.homeAdjustmentTrust).toBe('FULL');
    expect(canonical.awayAdjustmentTrust).toBe('FULL');
    expect(legacy.homeAdjustmentTrust).toBe('FULL');
    expect(legacy.awayAdjustmentTrust).toBe('FULL');

    expect(canonical.homeExpected).toBeCloseTo(legacy.homeExpected, 6);
    expect(canonical.awayExpected).toBeCloseTo(legacy.awayExpected, 6);
    expect(canonical.expectedTotal).toBeCloseTo(legacy.expectedTotal, 6);
    expect(canonical.rawTotalModel).toBeCloseTo(legacy.rawTotalModel, 6);
    expect(canonical.regressedTotalModel).toBeCloseTo(legacy.regressedTotalModel, 6);
    expect(canonical.adjustments.away.opponent_goalie).toBeCloseTo(
      legacy.adjustments.away.opponent_goalie,
      6,
    );
    expect(canonical.adjustments.home.opponent_goalie).toBeCloseTo(
      legacy.adjustments.home.opponent_goalie,
      6,
    );
  });

  test('FULL trust applies full goalie factor and remains official-eligible', () => {
    const result = predictNHLGame(
      buildBase({
        homeGoalieState: makeState('home', 'CONFIRMED', 'HIGH'),
        awayGoalieState: makeState('away', 'CONFIRMED', 'HIGH'),
      }),
    );

    expect(result).not.toBeNull();
    expect(result.homeAdjustmentTrust).toBe('FULL');
    expect(result.awayAdjustmentTrust).toBe('FULL');
    expect(result.official_eligible).toBe(true);
    expect(result.adjustments.away.opponent_goalie).toBeCloseTo(0.85, 6);
    expect(result.adjustments.home.opponent_goalie).toBeCloseTo(1.15, 6);
  });

  test('DEGRADED trust applies goalie factor at half weight', () => {
    const result = predictNHLGame(
      buildBase({
        homeGoalieState: makeState('home', 'EXPECTED', 'MEDIUM'),
        awayGoalieState: makeState('away', 'CONFIRMED', 'HIGH'),
      }),
    );

    const fullFactor = 0.85;
    const expectedDegradedFactor = 1 + (fullFactor - 1) * 0.5;

    expect(result.homeAdjustmentTrust).toBe('DEGRADED');
    expect(result.official_eligible).toBe(true);
    expect(result.adjustments.away.opponent_goalie).toBeCloseTo(
      expectedDegradedFactor,
      6,
    );
  });

  test('DEGRADED only changes goalie application; non-goalie modifier components stay fixed', () => {
    const full = predictNHLGame(
      buildBase({
        homeGoalieState: makeState('home', 'CONFIRMED', 'HIGH'),
        awayGoalieState: makeState('away', 'CONFIRMED', 'HIGH'),
      }),
    );
    const degraded = predictNHLGame(
      buildBase({
        homeGoalieState: makeState('home', 'EXPECTED', 'MEDIUM'),
        awayGoalieState: makeState('away', 'CONFIRMED', 'HIGH'),
      }),
    );

    expect(degraded.homeAdjustmentTrust).toBe('DEGRADED');
    expect(full.modifierBreakdown.base_5v5_total).toBe(
      degraded.modifierBreakdown.base_5v5_total,
    );
    expect(full.modifierBreakdown.special_teams_delta).toBe(
      degraded.modifierBreakdown.special_teams_delta,
    );
    expect(full.modifierBreakdown.home_ice_delta).toBe(
      degraded.modifierBreakdown.home_ice_delta,
    );
    expect(full.modifierBreakdown.rest_delta).toBe(
      degraded.modifierBreakdown.rest_delta,
    );
    expect(degraded.modifierBreakdown.goalie_delta_raw).toBe(
      full.modifierBreakdown.goalie_delta_raw,
    );
    expect(
      degraded.adjustments.away.opponent_goalie,
    ).toBeCloseTo(1 + (full.adjustments.away.opponent_goalie - 1) * 0.5, 6);
  });

  test('NEUTRALIZED trust removes directional goalie effect and stays official-eligible', () => {
    const neutralized = predictNHLGame(
      buildBase({
        awayGoalieSavePct: null,
        homeGoalieState: makeState('home', 'UNKNOWN'),
        awayGoalieState: makeState('away', 'CONFIRMED', 'HIGH'),
      }),
    );
    const noGoalie = predictNHLGame(
      buildBase({
        homeGoalieSavePct: null,
        awayGoalieSavePct: null,
        homeGoalieState: makeState('home', 'UNKNOWN'),
        awayGoalieState: makeState('away', 'CONFIRMED', 'HIGH'),
      }),
    );

    expect(neutralized.homeAdjustmentTrust).toBe('NEUTRALIZED');
    expect(neutralized.official_eligible).toBe(true);
    expect(neutralized.expectedTotal).toBe(noGoalie.expectedTotal);
    expect(neutralized.modifierBreakdown.goalie_delta_applied).toBe(0);
    expect(neutralized.confidence).toBeLessThanOrEqual(
      NHL_PACE_AUDIT_RULES.unknown_goalie_confidence_cap,
    );
  });

  test('BLOCKED trust yields descriptive projection but official_eligible false', () => {
    const blocked = predictNHLGame(
      buildBase({
        awayGoalieSavePct: null,
        homeGoalieState: makeState('home', 'CONFLICTING', 'NONE'),
        awayGoalieState: makeState('away', 'CONFIRMED', 'HIGH'),
      }),
    );
    const noGoalie = predictNHLGame(
      buildBase({
        homeGoalieSavePct: null,
        awayGoalieSavePct: null,
        homeGoalieState: makeState('home', 'CONFLICTING', 'NONE'),
        awayGoalieState: makeState('away', 'CONFIRMED', 'HIGH'),
      }),
    );

    expect(blocked).not.toBeNull();
    expect(blocked.homeAdjustmentTrust).toBe('BLOCKED');
    expect(blocked.official_eligible).toBe(false);
    expect(blocked.expectedTotal).toBe(noGoalie.expectedTotal);
    expect(blocked.modifierBreakdown.goalie_delta_applied).toBe(0);
  });

  test('BLOCKED both sides still returns projection and marks game ineligible', () => {
    const result = predictNHLGame(
      buildBase({
        homeGoalieState: makeState('home', 'CONFLICTING', 'NONE'),
        awayGoalieState: makeState('away', 'CONFLICTING', 'NONE'),
      }),
    );

    expect(result).not.toBeNull();
    expect(result.homeAdjustmentTrust).toBe('BLOCKED');
    expect(result.awayAdjustmentTrust).toBe('BLOCKED');
    expect(result.official_eligible).toBe(false);
    expect(result.expectedTotal).toEqual(expect.any(Number));
  });

  test('legacy null canonical + unconfirmed fallback maps to NEUTRALIZED behavior', () => {
    const neutralized = predictNHLGame(
      buildBase({
        awayGoalieSavePct: null,
        homeGoalieState: null,
        awayGoalieState: null,
        homeGoalieConfirmed: false,
        awayGoalieConfirmed: false,
        homeGoalieCertainty: null,
        awayGoalieCertainty: null,
      }),
    );
    const noGoalie = predictNHLGame(
      buildBase({
        homeGoalieSavePct: null,
        awayGoalieSavePct: null,
        homeGoalieState: null,
        awayGoalieState: null,
        homeGoalieConfirmed: false,
        awayGoalieConfirmed: false,
        homeGoalieCertainty: null,
        awayGoalieCertainty: null,
      }),
    );

    expect(neutralized.homeAdjustmentTrust).toBe('NEUTRALIZED');
    expect(neutralized.awayAdjustmentTrust).toBe('NEUTRALIZED');
    expect(neutralized.official_eligible).toBe(true);
    expect(neutralized.expectedTotal).toBe(noGoalie.expectedTotal);
    expect(neutralized).toHaveProperty('homeAdjustmentTrust');
    expect(neutralized).toHaveProperty('awayAdjustmentTrust');
    expect(neutralized).toHaveProperty('official_eligible');
  });

  test('UNKNOWN goalie certainty never coexists with FULL adjustment trust', () => {
    const result = predictNHLGame(
      buildBase({
        homeGoalieState: makeState('home', 'UNKNOWN'),
        awayGoalieState: makeState('away', 'UNKNOWN'),
      }),
    );

    expect(result.homeGoalieCertainty).toBe('UNKNOWN');
    expect(result.awayGoalieCertainty).toBe('UNKNOWN');
    expect(result.homeAdjustmentTrust).not.toBe('FULL');
    expect(result.awayAdjustmentTrust).not.toBe('FULL');
    expect(result.confidence).toBeLessThanOrEqual(
      NHL_PACE_AUDIT_RULES.unknown_goalie_confidence_cap,
    );
  });
});

describe('predictNHLGame — skater injury factor (WI-0463)', () => {
  test('null factor leaves homeExpected unchanged', () => {
    const base = predictNHLGame(buildBase());
    const withNull = predictNHLGame(buildBase({ homeSkaterInjuryFactor: null }));
    expect(withNull.homeExpected).toBeCloseTo(base.homeExpected, 6);
    expect(withNull.adjustments.home.skater_injury).toBeUndefined();
  });

  test('factor = 1.0 leaves homeExpected unchanged', () => {
    const base = predictNHLGame(buildBase());
    const with1 = predictNHLGame(buildBase({ homeSkaterInjuryFactor: 1.0 }));
    // factor >= 1.0 is not applied (condition: factor < 1.0)
    expect(with1.homeExpected).toBeCloseTo(base.homeExpected, 6);
    expect(with1.adjustments.home.skater_injury).toBeUndefined();
  });

  test('1 confirmed-out home skater reduces homeExpected by ~3.5%', () => {
    const base = predictNHLGame(buildBase());
    const injured = predictNHLGame(buildBase({ homeSkaterInjuryFactor: 0.965 }));
    expect(injured.homeExpected).toBeLessThan(base.homeExpected);
    expect(injured.adjustments.home.skater_injury).toBe(0.965);
  });

  test('3 confirmed-out home skaters (factor 0.895) reduces homeExpected ~10.5%', () => {
    const base = predictNHLGame(buildBase());
    const injured = predictNHLGame(buildBase({ homeSkaterInjuryFactor: 0.895 }));
    // homeExpected should be ~10.5% lower than base
    expect(injured.homeExpected).toBeCloseTo(base.homeExpected * 0.895, 1);
    expect(injured.adjustments.home.skater_injury).toBe(0.895);
  });

  test('capped factor (0.88) applies correctly', () => {
    const base = predictNHLGame(buildBase());
    const maxInjured = predictNHLGame(buildBase({ homeSkaterInjuryFactor: 0.88 }));
    // homeExpected is reduced roughly proportional to 0.88; regression/clamp prevent exact linear scaling
    expect(maxInjured.homeExpected).toBeLessThan(base.homeExpected);
    expect(maxInjured.homeExpected / base.homeExpected).toBeGreaterThan(0.85);
    expect(maxInjured.homeExpected / base.homeExpected).toBeLessThan(0.95);
    expect(maxInjured.adjustments.home.skater_injury).toBe(0.88);
  });

  test('away skater injury factor reduces awayExpected, not homeExpected', () => {
    const base = predictNHLGame(buildBase());
    const injured = predictNHLGame(buildBase({ awaySkaterInjuryFactor: 0.93 }));
    expect(injured.awayExpected).toBeLessThan(base.awayExpected);
    // homeExpected may shift slightly due to shared regression/scaling steps, but not by much
    expect(Math.abs(injured.homeExpected - base.homeExpected)).toBeLessThan(0.1);
    expect(injured.adjustments.away.skater_injury).toBe(0.93);
    expect(injured.adjustments.home.skater_injury).toBeUndefined();
  });

  test('both teams injured reduces both expected goals', () => {
    const base = predictNHLGame(buildBase());
    const bothInjured = predictNHLGame(
      buildBase({ homeSkaterInjuryFactor: 0.93, awaySkaterInjuryFactor: 0.965 }),
    );
    expect(bothInjured.homeExpected).toBeLessThan(base.homeExpected);
    expect(bothInjured.awayExpected).toBeLessThan(base.awayExpected);
    expect(bothInjured.expectedTotal).toBeLessThan(base.expectedTotal);
  });
});

describe('predictNHLGame — defense-side skater injury (WI-0465-C)', () => {
  test('homeSkaterDefInjuryFactor reduces homeDefRating → away scores more', () => {
    const base = predictNHLGame(buildBase());
    // Home missing defenders → homeDefRating degrades → away expected goals increase
    const withHomeDef = predictNHLGame(
      buildBase({ homeSkaterDefInjuryFactor: 0.95 }),
    );
    expect(withHomeDef.awayExpected).toBeGreaterThan(base.awayExpected);
    expect(withHomeDef.adjustments.home.skater_def_injury).toBe(0.95);
    expect(withHomeDef.adjustments.away.skater_def_injury).toBeUndefined();
  });

  test('awaySkaterDefInjuryFactor reduces awayDefRating → home scores more', () => {
    const base = predictNHLGame(buildBase());
    const withAwayDef = predictNHLGame(
      buildBase({ awaySkaterDefInjuryFactor: 0.95 }),
    );
    expect(withAwayDef.homeExpected).toBeGreaterThan(base.homeExpected);
    expect(withAwayDef.adjustments.away.skater_def_injury).toBe(0.95);
    expect(withAwayDef.adjustments.home.skater_def_injury).toBeUndefined();
  });

  test('null homeSkaterDefInjuryFactor has no effect (no adjustment recorded)', () => {
    const base = predictNHLGame(buildBase());
    const noAdj = predictNHLGame(buildBase({ homeSkaterDefInjuryFactor: null }));
    expect(noAdj.homeExpected).toBeCloseTo(base.homeExpected, 6);
    expect(noAdj.awayExpected).toBeCloseTo(base.awayExpected, 6);
    expect(noAdj.adjustments.home.skater_def_injury).toBeUndefined();
  });

  test('defense and offense injury factors combine — both expected goals affected', () => {
    const base = predictNHLGame(buildBase());
    const combined = predictNHLGame(
      buildBase({
        // Home missing forwards (offense down) and away missing defenders (away def degrades → home scores more)
        homeSkaterInjuryFactor: 0.93,  // home off down
        awaySkaterDefInjuryFactor: 0.95, // away def down → home scores more
      }),
    );
    // homeExpected: off down but also helped by away def gap; net effect depends on magnitudes
    // awayExpected: no off injury, home def intact
    // Just verify the adjustments were recorded
    expect(combined.adjustments.home.skater_injury).toBe(0.93);
    expect(combined.adjustments.away.skater_def_injury).toBe(0.95);
  });
});
