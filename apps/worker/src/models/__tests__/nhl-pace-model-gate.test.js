'use strict';
// WI-0820: Input gate regression tests for nhl-pace-model.js
// Verifies model_status field and that base-stat null checks produce null.

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

function confirmedGoalieState(teamSide) {
  return makeCanonicalGoalieState({
    game_id: 'game-1',
    team_side: teamSide,
    starter_state: 'CONFIRMED',
    starter_source: 'USER_INPUT',
    goalie_name: `${teamSide}-goalie`,
    goalie_tier: 'STRONG',
    tier_confidence: 'HIGH',
    evidence_flags: [],
  });
}

describe('predictNHLGame — WI-0820 input gate', () => {
  test('null base stats → returns null (existing NO_BET contract preserved)', () => {
    const result = predictNHLGame(buildBase({ homeGoalsFor: null }));
    expect(result).toBeNull();
  });

  test('null homeGoalsAgainst → returns null (extended gate check)', () => {
    const result = predictNHLGame(buildBase({ homeGoalsAgainst: null }));
    expect(result).toBeNull();
  });

  test('null awayGoalsAgainst → returns null (extended gate check)', () => {
    const result = predictNHLGame(buildBase({ awayGoalsAgainst: null }));
    expect(result).toBeNull();
  });

  test('double-UNKNOWN (default fixture) → valid result with model_status DEGRADED', () => {
    // Existing behavior: double-UNKNOWN → confidence-capped result (NOT NO_BET at model level)
    // The NO_BET enforcement for double-UNKNOWN happens in cross-market.js, not here
    const result = predictNHLGame(buildBase());
    expect(result).not.toBeNull();
    expect(result.model_status).toBe('DEGRADED');
    expect(result.goalieConfidenceCapped).toBe(true);
    expect(result.confidence).toBeLessThanOrEqual(0.35);
  });

  test('both CONFIRMED goalies → model_status MODEL_OK', () => {
    const state = {
      homeGoalieState: confirmedGoalieState('home'),
      awayGoalieState: confirmedGoalieState('away'),
      homeGoalieCertainty: 'CONFIRMED',
      awayGoalieCertainty: 'CONFIRMED',
      homeGoalieConfirmed: true,
      awayGoalieConfirmed: true,
    };
    const result = predictNHLGame(buildBase(state));
    expect(result).not.toBeNull();
    expect(result.model_status).toBe('MODEL_OK');
    expect(result.goalieConfidenceCapped).toBe(false);
  });

  test('valid full input → result has model_status field', () => {
    const result = predictNHLGame(buildBase());
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('model_status');
    expect(['MODEL_OK', 'DEGRADED']).toContain(result.model_status);
  });
});
