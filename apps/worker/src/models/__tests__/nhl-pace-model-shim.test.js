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
    ...overrides,
  };
}

describe('predictNHLGame goalie-state contract', () => {
  test('unknown canonical state yields UNKNOWN certainty and neutralized trust', () => {

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

    expect(canonicalOverride.homeGoalieCertainty).toBe('UNKNOWN');
    expect(canonicalOverride.awayGoalieCertainty).toBe('UNKNOWN');
    expect(canonicalOverride.homeAdjustmentTrust).toBe('NEUTRALIZED');
    expect(canonicalOverride.awayAdjustmentTrust).toBe('NEUTRALIZED');
    expect(canonicalOverride.official_eligible).toBe(true);
    expect(canonicalOverride.homeGoalieState).toEqual(homeGoalieState);
    expect(canonicalOverride.awayGoalieState).toEqual(awayGoalieState);
  });

  test('null canonical state defaults certainty/trust to UNKNOWN/NEUTRALIZED', () => {
    const result = predictNHLGame(
      buildBase({
        homeGoalieState: null,
        awayGoalieState: null,
      }),
    );

    expect(result.homeGoalieCertainty).toBe('UNKNOWN');
    expect(result.awayGoalieCertainty).toBe('UNKNOWN');
    expect(result.homeAdjustmentTrust).toBe('NEUTRALIZED');
    expect(result.awayAdjustmentTrust).toBe('NEUTRALIZED');
    expect(result.official_eligible).toBe(true);
    expect(result.homeGoalieState).toBeNull();
    expect(result.awayGoalieState).toBeNull();
  });

  test('confirmed canonical state yields FULL trust and confirmed certainty', () => {
    const homeGoalieState = makeCanonicalGoalieState({
      game_id: 'game-1',
      team_side: 'home',
      starter_state: 'CONFIRMED',
      starter_source: 'NHL_API_CONFIRMED',
      goalie_name: 'Home Goalie',
      goalie_tier: 'STRONG',
      tier_confidence: 'HIGH',
      evidence_flags: [],
    });
    const awayGoalieState = makeCanonicalGoalieState({
      game_id: 'game-1',
      team_side: 'away',
      starter_state: 'CONFIRMED',
      starter_source: 'NHL_API_CONFIRMED',
      goalie_name: 'Away Goalie',
      goalie_tier: 'STRONG',
      tier_confidence: 'HIGH',
      evidence_flags: [],
    });

    const result = predictNHLGame(
      buildBase({
        homeGoalieState,
        awayGoalieState,
      }),
    );

    expect(result.homeGoalieCertainty).toBe('CONFIRMED');
    expect(result.awayGoalieCertainty).toBe('CONFIRMED');
    expect(result.homeAdjustmentTrust).toBe('FULL');
    expect(result.awayAdjustmentTrust).toBe('FULL');
    expect(result.official_eligible).toBe(true);
  });
});
