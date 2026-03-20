const { validateCardPayload } = require('../../validators/card-payload');

function buildBaseAhPayload(overrides = {}) {
  return {
    kind: 'PLAY',
    sport: 'SOCCER',
    game_id: 'soccer-ah-home-001',
    recommended_bet_type: 'spread',
    prediction: 'HOME',
    selection: {
      side: 'HOME',
      team: 'Arsenal',
    },
    home_team: 'Arsenal',
    away_team: 'Chelsea',
    generated_at: new Date().toISOString(),
    canonical_market_key: 'asian_handicap_home',
    market_type: 'ASIAN_HANDICAP',
    side: 'HOME',
    line: -0.75,
    split_flag: true,
    price: 102,
    opposite_price: -122,
    probabilities: {
      P_win: 0.56,
      P_push: 0.08,
      P_loss: 0.36,
      P_full_win: 0.48,
      P_half_win: 0.16,
      P_half_loss: 0.04,
      P_full_loss: 0.32,
    },
    model_prob_no_push: 0.61,
    edge_ev: 0.032,
    expected_value: 0.018,
    fair_line: -0.75,
    fair_price_american: -113,
    edge_basis: 'ah_de_vig_poisson_goal_diff',
    missing_context_flags: [],
    pass_reason: null,
    ...overrides,
  };
}

describe('soccer card payload validator - asian handicap', () => {
  test('accepts valid asian_handicap_home payload', () => {
    const payload = buildBaseAhPayload();

    const result = validateCardPayload('asian_handicap_home', payload);
    expect(result.success).toBe(true);
  });

  test('rejects payload without canonical play envelope fields', () => {
    const payload = buildBaseAhPayload({
      kind: undefined,
      recommended_bet_type: undefined,
      selection: undefined,
    });

    const result = validateCardPayload('asian_handicap_home', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('kind');
    expect(result.errors.join(' ')).toContain('recommended_bet_type');
    expect(result.errors.join(' ')).toContain('selection');
  });

  test('rejects quarter line when split_flag is false', () => {
    const payload = buildBaseAhPayload({
      game_id: 'soccer-ah-home-002',
      line: -0.25,
      split_flag: false,
      price: -108,
      opposite_price: -112,
      probabilities: {
        P_win: 0.52,
        P_push: 0.12,
        P_loss: 0.36,
      },
      model_prob_no_push: 0.59,
      edge_ev: 0.011,
      expected_value: 0.009,
      fair_line: -0.25,
      fair_price_american: -110,
    });

    const result = validateCardPayload('asian_handicap_home', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('split_flag');
  });

  test('rejects payload when selection.side does not match canonical AH side', () => {
    const payload = buildBaseAhPayload({
      selection: {
        side: 'AWAY',
        team: 'Chelsea',
      },
    });

    const result = validateCardPayload('asian_handicap_home', payload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('selection.side');
  });

  test('allows pass payload for asian_handicap_away with missing AH inputs', () => {
    const payload = {
      kind: 'PLAY',
      sport: 'SOCCER',
      game_id: 'soccer-ah-away-001',
      recommended_bet_type: 'spread',
      prediction: 'AWAY',
      selection: {
        side: 'AWAY',
        team: 'Chelsea',
      },
      home_team: 'Arsenal',
      away_team: 'Chelsea',
      generated_at: new Date().toISOString(),
      canonical_market_key: 'asian_handicap_away',
      market_type: 'ASIAN_HANDICAP',
      side: 'AWAY',
      line: null,
      split_flag: false,
      price: null,
      opposite_price: null,
      probabilities: null,
      model_prob_no_push: null,
      edge_ev: null,
      expected_value: null,
      fair_line: null,
      fair_price_american: null,
      edge_basis: 'ah_de_vig_poisson_goal_diff',
      missing_context_flags: ['line', 'price', 'opposite_price', 'lambda_home', 'lambda_away'],
      pass_reason: 'MISSING_AH_INPUTS',
    };

    const result = validateCardPayload('asian_handicap_away', payload);
    expect(result.success).toBe(true);
  });
});
