'use strict';

const {
  makeCanonicalGoalieState,
  resolveGoalieState,
} = require('../nhl-goalie-state');

function buildState(overrides = {}) {
  return {
    game_id: 'game-123',
    team_side: 'home',
    starter_state: 'CONFIRMED',
    starter_source: 'USER_INPUT',
    goalie_name: 'Goalie Example',
    goalie_tier: 'STRONG',
    tier_confidence: 'HIGH',
    evidence_flags: [],
    ...overrides,
  };
}

describe('makeCanonicalGoalieState', () => {
  test('CONFIRMED + HIGH confidence -> FULL', () => {
    const state = makeCanonicalGoalieState(
      buildState({ starter_state: 'CONFIRMED', tier_confidence: 'HIGH' }),
    );
    expect(state.adjustment_trust).toBe('FULL');
  });

  test('CONFIRMED + LOW confidence -> DEGRADED', () => {
    const state = makeCanonicalGoalieState(
      buildState({ starter_state: 'CONFIRMED', tier_confidence: 'LOW' }),
    );
    expect(state.adjustment_trust).toBe('DEGRADED');
  });

  test('EXPECTED + any confidence -> DEGRADED', () => {
    const state = makeCanonicalGoalieState(
      buildState({ starter_state: 'EXPECTED', tier_confidence: 'HIGH' }),
    );
    expect(state.adjustment_trust).toBe('DEGRADED');
  });

  test('UNKNOWN + any confidence -> NEUTRALIZED', () => {
    const state = makeCanonicalGoalieState(
      buildState({
        starter_state: 'UNKNOWN',
        tier_confidence: 'NONE',
        goalie_name: null,
        goalie_tier: 'UNKNOWN',
      }),
    );
    expect(state.adjustment_trust).toBe('NEUTRALIZED');
  });

  test('CONFLICTING + any confidence -> BLOCKED', () => {
    const state = makeCanonicalGoalieState(
      buildState({
        starter_state: 'CONFLICTING',
        tier_confidence: 'LOW',
        starter_source: 'MERGED',
      }),
    );
    expect(state.adjustment_trust).toBe('BLOCKED');
  });

  test('preserves CONFLICTING_SOURCE_EVIDENCE flag', () => {
    const state = makeCanonicalGoalieState(
      buildState({
        starter_state: 'CONFLICTING',
        tier_confidence: 'LOW',
        starter_source: 'MERGED',
        evidence_flags: ['CONFLICTING_SOURCE_EVIDENCE'],
      }),
    );

    expect(state.evidence_flags).toEqual(['CONFLICTING_SOURCE_EVIDENCE']);
  });

  test('throws on missing required fields', () => {
    expect(() => makeCanonicalGoalieState({})).toThrow(
      /game_id is required/i,
    );
  });
});

describe('resolveGoalieState', () => {
  const gameId = 'game-123';
  const gameTimeUtc = '2026-03-13T12:00:00Z';

  function resolve(scraperInput, userInput = null, teamSide = 'home') {
    return resolveGoalieState(scraperInput, userInput, gameId, teamSide, {
      gameTimeUtc,
    });
  }

  test('user and scraper agree on name -> user source, clean evidence', () => {
    const state = resolve(
      {
        goalie_name: 'Igor Shesterkin',
        gsax: 9.1,
        source_type: 'SCRAPER_NAME_MATCH',
      },
      {
        goalie_name: 'Igor Shesterkin',
        status: 'CONFIRMED',
        supplied_at: '2026-03-13T10:00:00Z',
      },
    );

    expect(state.starter_state).toBe('CONFIRMED');
    expect(state.starter_source).toBe('USER_INPUT');
    expect(state.goalie_name).toBe('Igor Shesterkin');
    expect(state.evidence_flags).toEqual([]);
  });

  test('user and scraper disagree on name -> CONFLICTING + flag', () => {
    const state = resolve(
      {
        goalie_name: 'Scraper Goalie',
        gsax: 3.5,
        source_type: 'SCRAPER_NAME_MATCH',
      },
      {
        goalie_name: 'User Goalie',
        status: 'CONFIRMED',
        supplied_at: '2026-03-13T10:00:00Z',
      },
    );

    expect(state.starter_state).toBe('CONFLICTING');
    expect(state.starter_source).toBe('USER_INPUT');
    expect(state.evidence_flags).toContain('CONFLICTING_SOURCE_EVIDENCE');
  });

  test('user-only input -> USER_INPUT source without conflict', () => {
    const state = resolve(
      {
        goalie_name: null,
        gsax: null,
        source_type: 'SEASON_TABLE_INFERENCE',
      },
      {
        goalie_name: 'User Only',
        status: 'EXPECTED',
        supplied_at: '2026-03-13T09:00:00Z',
      },
    );

    expect(state.starter_source).toBe('USER_INPUT');
    expect(state.starter_state).toBe('EXPECTED');
    expect(state.goalie_name).toBe('User Only');
    expect(state.evidence_flags).toEqual([]);
  });

  test('scraper name-match only -> EXPECTED + SCRAPER_NAME_MATCH', () => {
    const state = resolve({
      goalie_name: 'Scraper Named',
      gsax: 1.1,
      source_type: 'SCRAPER_NAME_MATCH',
    });

    expect(state.starter_state).toBe('EXPECTED');
    expect(state.starter_source).toBe('SCRAPER_NAME_MATCH');
    expect(state.goalie_name).toBe('Scraper Named');
    expect(state.evidence_flags).toEqual([]);
  });

  test('scraper CONFIRMED status is preserved as CONFIRMED', () => {
    const state = resolve({
      goalie_name: 'Scraper Confirmed',
      status: 'CONFIRMED',
      gsax: 2.3,
      source_type: 'SCRAPER_NAME_MATCH',
    });

    expect(state.starter_state).toBe('CONFIRMED');
    expect(state.starter_source).toBe('SCRAPER_NAME_MATCH');
    expect(state.goalie_name).toBe('Scraper Confirmed');
  });

  test('season-table inference only -> UNKNOWN + flag + LOW confidence', () => {
    const state = resolve({
      goalie_name: null,
      gsax: -2.4,
      source_type: 'SEASON_TABLE_INFERENCE',
    });

    expect(state.starter_state).toBe('UNKNOWN');
    expect(state.starter_source).toBe('SEASON_TABLE_INFERENCE');
    expect(state.tier_confidence).toBe('LOW');
    expect(state.evidence_flags).toContain('SEASON_TABLE_INFERENCE_ONLY');
  });

  test('no data at all -> UNKNOWN + tier UNKNOWN + NONE confidence', () => {
    const state = resolve({
      goalie_name: null,
      gsax: null,
      source_type: 'SEASON_TABLE_INFERENCE',
    });

    expect(state.starter_state).toBe('UNKNOWN');
    expect(state.goalie_tier).toBe('UNKNOWN');
    expect(state.tier_confidence).toBe('NONE');
  });

  test('stale user input falls back to scraper and flags STALE_USER_INPUT', () => {
    const state = resolve(
      {
        goalie_name: 'Scraper Fresh',
        gsax: 4.1,
        source_type: 'SCRAPER_NAME_MATCH',
      },
      {
        goalie_name: 'User Stale',
        status: 'CONFIRMED',
        supplied_at: '2026-03-13T05:59:59Z',
      },
    );

    expect(state.starter_source).toBe('SCRAPER_NAME_MATCH');
    expect(state.goalie_name).toBe('Scraper Fresh');
    expect(state.evidence_flags).toContain('STALE_USER_INPUT');
  });

  test('malformed user input falls back to scraper and flags MALFORMED_USER_INPUT', () => {
    const state = resolve(
      {
        goalie_name: 'Scraper Fallback',
        gsax: 0.5,
        source_type: 'SCRAPER_NAME_MATCH',
      },
      {
        goalie_name: 'Bad Timestamp',
        status: 'CONFIRMED',
        supplied_at: 'not-a-date',
      },
    );

    expect(state.starter_source).toBe('SCRAPER_NAME_MATCH');
    expect(state.goalie_name).toBe('Scraper Fallback');
    expect(state.evidence_flags).toContain('MALFORMED_USER_INPUT');
  });

  test('maps CONFIRMED user status to CONFIRMED starter_state', () => {
    const state = resolve(
      { goalie_name: null, gsax: 8.0, source_type: 'SEASON_TABLE_INFERENCE' },
      {
        goalie_name: 'User Confirmed',
        status: 'CONFIRMED',
        supplied_at: '2026-03-13T10:00:00Z',
      },
    );

    expect(state.starter_state).toBe('CONFIRMED');
  });

  test('maps EXPECTED user status to EXPECTED starter_state', () => {
    const state = resolve(
      { goalie_name: null, gsax: 8.0, source_type: 'SEASON_TABLE_INFERENCE' },
      {
        goalie_name: 'User Expected',
        status: 'EXPECTED',
        supplied_at: '2026-03-13T10:00:00Z',
      },
    );

    expect(state.starter_state).toBe('EXPECTED');
  });
});

describe('adjustment_trust values used for training row exclusion (WI-0970)', () => {
  // stampTrainingRowExclusion in run_nhl_model.js excludes cards when
  // adjustment_trust is NEUTRALIZED or BLOCKED (reason tag: GOALIE_UNCERTAIN).
  // These tests document that contract — the values come from makeCanonicalGoalieState.

  test('UNKNOWN starter_state produces NEUTRALIZED adjustment_trust → triggers GOALIE_UNCERTAIN exclusion', () => {
    const state = makeCanonicalGoalieState({
      game_id: 'game-wi0970',
      team_side: 'home',
      starter_state: 'UNKNOWN',
      starter_source: 'USER_INPUT',
      goalie_name: null,
      goalie_tier: 'UNKNOWN',
      tier_confidence: 'NONE',
      evidence_flags: [],
    });

    expect(state.adjustment_trust).toBe('NEUTRALIZED');
  });

  test('CONFIRMED + HIGH confidence produces FULL adjustment_trust → no GOALIE_UNCERTAIN exclusion', () => {
    const state = makeCanonicalGoalieState({
      game_id: 'game-wi0970',
      team_side: 'home',
      starter_state: 'CONFIRMED',
      starter_source: 'USER_INPUT',
      goalie_name: 'J. Smith',
      goalie_tier: 'STRONG',
      tier_confidence: 'HIGH',
      evidence_flags: [],
    });

    expect(state.adjustment_trust).toBe('FULL');
  });

  test('CONFIRMED + LOW confidence produces DEGRADED adjustment_trust → no GOALIE_UNCERTAIN exclusion', () => {
    const state = makeCanonicalGoalieState({
      game_id: 'game-wi0970',
      team_side: 'away',
      starter_state: 'CONFIRMED',
      starter_source: 'USER_INPUT',
      goalie_name: 'A. Backup',
      goalie_tier: 'WEAK',
      tier_confidence: 'LOW',
      evidence_flags: [],
    });

    expect(state.adjustment_trust).toBe('DEGRADED');
  });
});
