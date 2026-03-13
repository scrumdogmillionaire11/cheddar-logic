'use strict';

const { predictNHLGame } = require('../nhl-pace-model');
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
    expect(result.adjustments.away.opponent_goalie).toBeCloseTo(0.925, 6);
    expect(result.adjustments.home.opponent_goalie).toBeCloseTo(1.025, 6);
  });

  test('DEGRADED trust applies goalie factor at half weight', () => {
    const result = predictNHLGame(
      buildBase({
        homeGoalieState: makeState('home', 'EXPECTED', 'MEDIUM'),
        awayGoalieState: makeState('away', 'CONFIRMED', 'HIGH'),
      }),
    );

    const fullFactor = 0.925;
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
});
