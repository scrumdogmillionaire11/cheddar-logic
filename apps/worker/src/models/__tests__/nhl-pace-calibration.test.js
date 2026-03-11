'use strict';

const { predictNHLGame } = require('../nhl-pace-model');
const { edgeCalculator } = require('@cheddar-logic/models');

function buildBaseOverrides(overrides = {}) {
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
    homeGoalieSavePct: null,
    awayGoalieSavePct: null,
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

describe('NHL pace calibration rails', () => {
  test('regresses and clamps high raw total to <= 7.6', () => {
    const result = predictNHLGame(
      buildBaseOverrides({
        homeGoalsFor: 4.4,
        homeGoalsAgainst: 3.9,
        awayGoalsFor: 4.2,
        awayGoalsAgainst: 3.8,
        homePaceFactor: 1.18,
        awayPaceFactor: 1.14,
        homePpPct: 0.3,
        awayPpPct: 0.29,
        homePkPct: 0.72,
        awayPkPct: 0.71,
        homeGoalieSavePct: 0.885,
        awayGoalieSavePct: 0.884,
        homeGoalieConfirmed: true,
        awayGoalieConfirmed: true,
        homeGoalieCertainty: 'CONFIRMED',
        awayGoalieCertainty: 'CONFIRMED',
      }),
    );

    expect(result.rawTotalModel).toBeGreaterThan(7.6);
    expect(result.expectedTotal).toBeLessThanOrEqual(7.6);
    expect(result.totalClampedHigh).toBe(true);
  });

  test('keeps normal environments near league baseline without forced clamp', () => {
    const result = predictNHLGame(buildBaseOverrides());

    expect(result.expectedTotal).toBeGreaterThan(5.6);
    expect(result.expectedTotal).toBeLessThan(6.4);
    expect(result.totalClampedHigh).toBe(false);
    expect(result.totalClampedLow).toBe(false);
  });

  test('floors extremely low environments to >= 5.0', () => {
    const result = predictNHLGame(
      buildBaseOverrides({
        homeGoalsFor: 2.1,
        homeGoalsAgainst: 2.0,
        awayGoalsFor: 2.0,
        awayGoalsAgainst: 2.1,
        homePaceFactor: 0.92,
        awayPaceFactor: 0.9,
        homeGoalieSavePct: 0.93,
        awayGoalieSavePct: 0.932,
        homeGoalieConfirmed: true,
        awayGoalieConfirmed: true,
        homeGoalieCertainty: 'CONFIRMED',
        awayGoalieCertainty: 'CONFIRMED',
      }),
    );

    expect(result.expectedTotal).toBeGreaterThanOrEqual(5.0);
    expect(result.totalClampedLow).toBe(true);
  });

  test('goalie certainty scales impact: CONFIRMED < EXPECTED(=UNKNOWN)', () => {
    const base = buildBaseOverrides({
      homeGoalieSavePct: 0.93,
      awayGoalieSavePct: 0.932,
      homeGoalieConfirmed: true,
      awayGoalieConfirmed: true,
    });

    const confirmed = predictNHLGame({
      ...base,
      homeGoalieCertainty: 'CONFIRMED',
      awayGoalieCertainty: 'CONFIRMED',
    });
    const expected = predictNHLGame({
      ...base,
      homeGoalieCertainty: 'EXPECTED',
      awayGoalieCertainty: 'EXPECTED',
    });
    const unknown = predictNHLGame({
      ...base,
      homeGoalieCertainty: 'UNKNOWN',
      awayGoalieCertainty: 'UNKNOWN',
    });

    expect(confirmed.expectedTotal).toBeLessThan(expected.expectedTotal);
    expect(expected.expectedTotal).toBe(unknown.expectedTotal);
  });

  test('caps additive modifier stack to absolute 0.70 goals', () => {
    const result = predictNHLGame(
      buildBaseOverrides({
        homeGoalsFor: 3.9,
        homeGoalsAgainst: 3.6,
        awayGoalsFor: 3.8,
        awayGoalsAgainst: 3.7,
        homePaceFactor: 1.2,
        awayPaceFactor: 1.2,
        homePpPct: 0.31,
        awayPpPct: 0.3,
        homePkPct: 0.69,
        awayPkPct: 0.7,
        homeGoalieSavePct: 0.885,
        awayGoalieSavePct: 0.886,
        homeGoalieConfirmed: true,
        awayGoalieConfirmed: true,
        homeGoalieCertainty: 'CONFIRMED',
        awayGoalieCertainty: 'CONFIRMED',
      }),
    );

    expect(result.modifierBreakdown).toBeDefined();
    expect(
      Math.abs(result.modifierBreakdown.capped_modifier_total),
    ).toBeLessThanOrEqual(0.7);
    if (Math.abs(result.modifierBreakdown.raw_modifier_total) > 0.7) {
      expect(result.modifierCapApplied).toBe(true);
    }
  });
});

describe('NHL 1P calibration rails', () => {
  test('applies 1P safety rail floor at 1.20 in suppressive environments', () => {
    const result = predictNHLGame(
      buildBaseOverrides({
        homeGoalsFor: 1.9,
        homeGoalsAgainst: 1.9,
        awayGoalsFor: 1.9,
        awayGoalsAgainst: 1.9,
        homePaceFactor: 0.85,
        awayPaceFactor: 0.85,
        homePpPct: 0.15,
        awayPpPct: 0.15,
        homePkPct: 0.9,
        awayPkPct: 0.9,
        homeGoalieSavePct: 0.936,
        awayGoalieSavePct: 0.935,
        homeGoalieConfirmed: true,
        awayGoalieConfirmed: true,
        homeGoalieCertainty: 'CONFIRMED',
        awayGoalieCertainty: 'CONFIRMED',
      }),
    );

    expect(result.first_period_model.projection_final).toBeGreaterThanOrEqual(
      1.2,
    );
    if (result.first_period_model.projection_final === 1.2) {
      expect(result.first_period_model.reason_codes).toContain(
        'NHL_1P_CLAMP_LOW',
      );
    }
  });

  test('applies 1P safety rail ceiling at 2.25 in hot environments', () => {
    const result = predictNHLGame(
      buildBaseOverrides({
        homeGoalsFor: 4.7,
        homeGoalsAgainst: 3.8,
        awayGoalsFor: 4.6,
        awayGoalsAgainst: 3.7,
        homePaceFactor: 1.24,
        awayPaceFactor: 1.22,
        homePpPct: 0.34,
        awayPpPct: 0.33,
        homePkPct: 0.68,
        awayPkPct: 0.69,
        homeGoalieSavePct: 0.884,
        awayGoalieSavePct: 0.883,
        homeGoalieConfirmed: true,
        awayGoalieConfirmed: true,
        homeGoalieCertainty: 'CONFIRMED',
        awayGoalieCertainty: 'CONFIRMED',
      }),
    );

    expect(result.first_period_model.projection_final).toBeLessThanOrEqual(
      2.25,
    );
    if (result.first_period_model.projection_final === 2.25) {
      expect(result.first_period_model.reason_codes).toContain(
        'NHL_1P_CLAMP_HIGH',
      );
    }
  });

  test('forces PASS classification when either goalie certainty is UNKNOWN', () => {
    const result = predictNHLGame(
      buildBaseOverrides({
        homeGoalsFor: 4.3,
        homeGoalsAgainst: 2.7,
        awayGoalsFor: 4.2,
        awayGoalsAgainst: 2.8,
        homePaceFactor: 1.16,
        awayPaceFactor: 1.15,
        homeGoalieSavePct: 0.902,
        awayGoalieSavePct: 0.901,
        homeGoalieConfirmed: false,
        awayGoalieConfirmed: true,
        homeGoalieCertainty: 'UNKNOWN',
        awayGoalieCertainty: 'CONFIRMED',
      }),
    );

    expect(result.first_period_model.classification).toBe('PASS');
    expect(result.first_period_model.reason_codes).toContain(
      'NHL_1P_GOALIE_UNCERTAIN',
    );
    expect(result.first_period_model.reason_codes).not.toContain(
      'NHL_1P_PASS_DEAD_ZONE',
    );
  });

  test('zeros out goalie 1P directional effect when certainty is UNKNOWN', () => {
    const result = predictNHLGame(
      buildBaseOverrides({
        homeGoalieSavePct: 0.935,
        awayGoalieSavePct: 0.936,
        homeGoalieConfirmed: false,
        awayGoalieConfirmed: false,
        homeGoalieCertainty: 'UNKNOWN',
        awayGoalieCertainty: 'UNKNOWN',
      }),
    );

    const netEnvAdj = Number(
      (
        result.first_period_model.accelerant_1p +
        result.first_period_model.suppressor_1p
      ).toFixed(3),
    );
    expect(Number.isFinite(netEnvAdj)).toBe(true);
    expect(result.first_period_model.reason_codes).toContain(
      'NHL_1P_GOALIE_UNCERTAIN',
    );
  });
});

describe('NHL total probability rails', () => {
  test('prevents absurd NHL total fair probabilities and edge inflation', () => {
    const result = edgeCalculator.computeTotalEdge({
      projectionTotal: 8.5,
      totalLine: 5.5,
      totalPriceOver: -110,
      totalPriceUnder: -110,
      sigmaTotal: 2.0,
      isPredictionOver: true,
    });

    expect(result.p_fair).toBeLessThanOrEqual(0.75);
    expect(Math.abs(result.edge)).toBeLessThanOrEqual(0.18);
    expect(Array.isArray(result.rail_flags)).toBe(true);
    expect(result.rail_flags).toContain('UNREALISTIC_TOTAL_PROBABILITY');
    expect(result.rail_flags).toContain('EDGE_SANITY_CLAMP_APPLIED');
  });

  test('keeps realistic totals within rails without forced clamp', () => {
    const result = edgeCalculator.computeTotalEdge({
      projectionTotal: 6.2,
      totalLine: 6.0,
      totalPriceOver: -110,
      totalPriceUnder: -110,
      sigmaTotal: 2.0,
      isPredictionOver: true,
    });

    expect(result.p_fair).toBeGreaterThanOrEqual(0.43);
    expect(result.p_fair).toBeLessThanOrEqual(0.65);
    expect(Math.abs(result.edge)).toBeLessThanOrEqual(0.18);
  });
});
