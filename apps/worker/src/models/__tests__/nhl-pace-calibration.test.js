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
        homePpPct: 0.30,
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

  test('goalie certainty scales impact: CONFIRMED > EXPECTED > UNKNOWN', () => {
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
    expect(expected.expectedTotal).toBeLessThan(unknown.expectedTotal);
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
        awayPpPct: 0.30,
        homePkPct: 0.69,
        awayPkPct: 0.70,
        homeGoalieSavePct: 0.885,
        awayGoalieSavePct: 0.886,
        homeGoalieConfirmed: true,
        awayGoalieConfirmed: true,
        homeGoalieCertainty: 'CONFIRMED',
        awayGoalieCertainty: 'CONFIRMED',
      }),
    );

    expect(result.modifierBreakdown).toBeDefined();
    expect(Math.abs(result.modifierBreakdown.capped_modifier_total)).toBeLessThanOrEqual(0.7);
    if (Math.abs(result.modifierBreakdown.raw_modifier_total) > 0.7) {
      expect(result.modifierCapApplied).toBe(true);
    }
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
