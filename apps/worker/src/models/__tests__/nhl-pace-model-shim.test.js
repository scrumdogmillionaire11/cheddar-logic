'use strict';

const { predictNHLGame } = require('../nhl-pace-model');
const { makeCanonicalGoalieState } = require('../nhl-goalie-state');

function buildBase(overrides = {}) {
  return {
    homeGoalsFor: 3.2,
    homeGoalsAgainst: 3.0,
    awayGoalsFor: 3.1,
    awayGoalsAgainst: 3.0,
    homeGoalieSavePct: 0.93,
    awayGoalieSavePct: 0.931,
    homeGoalieConfirmed: true,
    awayGoalieConfirmed: true,
    homeGoalieCertainty: null,
    awayGoalieCertainty: null,
    ...overrides,
  };
}

describe('predictNHLGame goalie-state shim', () => {
  test('homeGoalieState/awayGoalieState override legacy booleans', () => {
    const legacyConfirmed = predictNHLGame(buildBase());

    const homeGoalieState = makeCanonicalGoalieState({
      game_id: 'game-1',
      team_side: 'home',
      starter_state: 'UNKNOWN',
      starter_source: 'SEASON_TABLE_INFERENCE',
      goalie_name: null,
      goalie_tier: 'UNKNOWN',
      tier_confidence: 'NONE',
      evidence_flags: ['SEASON_TABLE_INFERENCE_ONLY'],
    });
    const awayGoalieState = makeCanonicalGoalieState({
      game_id: 'game-1',
      team_side: 'away',
      starter_state: 'UNKNOWN',
      starter_source: 'SEASON_TABLE_INFERENCE',
      goalie_name: null,
      goalie_tier: 'UNKNOWN',
      tier_confidence: 'NONE',
      evidence_flags: ['SEASON_TABLE_INFERENCE_ONLY'],
    });

    const canonicalOverride = predictNHLGame(
      buildBase({
        homeGoalieState,
        awayGoalieState,
      }),
    );

    expect(legacyConfirmed.homeGoalieCertainty).toBe('CONFIRMED');
    expect(canonicalOverride.homeGoalieCertainty).toBe('UNKNOWN');
    expect(canonicalOverride.homeGoalieConfirmed).toBe(false);
    expect(canonicalOverride.awayGoalieConfirmed).toBe(false);
    expect(canonicalOverride.expectedTotal).toBeGreaterThan(
      legacyConfirmed.expectedTotal,
    );
    expect(legacyConfirmed.homeAdjustmentTrust).toBe('FULL');
    expect(legacyConfirmed.awayAdjustmentTrust).toBe('FULL');
    expect(legacyConfirmed.official_eligible).toBe(true);
    expect(canonicalOverride.homeAdjustmentTrust).toBe('NEUTRALIZED');
    expect(canonicalOverride.awayAdjustmentTrust).toBe('NEUTRALIZED');
    expect(canonicalOverride.official_eligible).toBe(true);
    expect(canonicalOverride.homeGoalieState).toEqual(homeGoalieState);
    expect(canonicalOverride.awayGoalieState).toEqual(awayGoalieState);
  });

  test('legacy shim still applies when canonical state is null', () => {
    const result = predictNHLGame(
      buildBase({
        homeGoalieState: null,
        awayGoalieState: null,
        homeGoalieConfirmed: true,
        awayGoalieConfirmed: true,
      }),
    );

    expect(result.homeGoalieCertainty).toBe('CONFIRMED');
    expect(result.awayGoalieCertainty).toBe('CONFIRMED');
    expect(result.homeGoalieConfirmed).toBe(true);
    expect(result.awayGoalieConfirmed).toBe(true);
    expect(result.homeAdjustmentTrust).toBe('FULL');
    expect(result.awayAdjustmentTrust).toBe('FULL');
    expect(result.official_eligible).toBe(true);
    expect(result.homeGoalieState).toBeNull();
    expect(result.awayGoalieState).toBeNull();
  });

  test('legacy unconfirmed booleans map to neutralized trust fallback', () => {
    const result = predictNHLGame(
      buildBase({
        homeGoalieState: null,
        awayGoalieState: null,
        homeGoalieConfirmed: false,
        awayGoalieConfirmed: false,
        homeGoalieCertainty: null,
        awayGoalieCertainty: null,
      }),
    );

    expect(result.homeGoalieCertainty).toBe('UNKNOWN');
    expect(result.awayGoalieCertainty).toBe('UNKNOWN');
    expect(result.homeAdjustmentTrust).toBe('NEUTRALIZED');
    expect(result.awayAdjustmentTrust).toBe('NEUTRALIZED');
    expect(result.official_eligible).toBe(true);
  });
});
