const { validateCardPayload } = require('@cheddar-logic/data');
const {
  generateSoccerCard,
  deriveWinProbHome,
  resolveSoccerModelMode,
  shouldEmitOddsBackedCard,
  isSoccerSideMarket,
  normalizeToCanonicalSoccerMarket,
  computeFootieLambdas,
  computeFootieMlProbabilities,
  buildSoccerTier1Payload,
  buildSoccerOddsBackedCard,
  buildSoccerSideMarketCard,
  buildDeterministicSoccerPlayerId,
  buildSoccerTier1CardFromPropLine,
  isBlockedSoccerPropPlayer,
} = require('../run_soccer_model');
const {
  applySoccerDecisionBasisMeta,
  recordSoccerProjectionTelemetry,
} = require('../../utils/soccer-patch');

function buildOddsSnapshot(overrides = {}) {
  return {
    game_id: 'soccer-epl-2026-03-13-che-mci',
    home_team: 'Chelsea FC',
    away_team: 'Manchester City',
    game_time_utc: '2026-03-14T19:30:00.000Z',
    h2h_home: -120,
    h2h_away: 105,
    captured_at: '2026-03-13T16:00:00.000Z',
    raw_data: JSON.stringify({ league: 'EPL', bookmaker: 'test-book' }),
    ...overrides,
  };
}

function buildSoccerOddsSnapshot(overrides = {}) {
  const base = buildOddsSnapshot({
    raw_data: {
      league: 'EPL',
      bookmaker: 'test-book',
      soccer_market: 'team_totals',
    },
  });
  return { ...base, ...overrides };
}

describe('run_soccer_model payload hardening', () => {
  test('generates playable moneyline soccer payload with hardened context', () => {
    const oddsSnapshot = buildOddsSnapshot();
    const card = generateSoccerCard(oddsSnapshot.game_id, oddsSnapshot);
    const payload = card.payloadData;

    expect(card.cardType).toBe('soccer-model-output');
    expect(payload.kind).toBe('PLAY');
    expect(payload.market_type).toBe('MONEYLINE');
    expect(payload.recommended_bet_type).toBe('moneyline');
    expect(payload.selection).toEqual({
      side: 'HOME',
      team: 'Chelsea FC',
    });
    expect(payload.price).toBe(-120);
    expect(payload.recommendation.type).toBe('ML_HOME');
    expect(payload.drivers_active.length).toBeGreaterThan(0);
    expect(payload.drivers_active).toContain('moneyline_favorite_signal');
    expect(payload.drivers_active).toContain('league_context_epl');
    expect(payload.projection.win_prob_home).toBeCloseTo(
      deriveWinProbHome(-120, 105),
      4,
    );
    expect(payload.projection_context.available).toBe(true);
    expect(payload.projection_context.missing_fields).toEqual([]);
    expect(payload.meta.is_mock).toBe(false);
    expect(payload.meta.missing_context_fields).toEqual([]);

    const validation = validateCardPayload(card.cardType, payload);
    expect(validation.success).toBe(true);
  });

  test('marks fallback payload as mock and fails strict validator on missing moneyline context', () => {
    const oddsSnapshot = buildOddsSnapshot({
      h2h_away: null,
      raw_data: JSON.stringify({ league: 'MLS' }),
    });
    const card = generateSoccerCard(oddsSnapshot.game_id, oddsSnapshot);
    const payload = card.payloadData;

    expect(payload.meta.is_mock).toBe(true);
    expect(payload.meta.missing_context_fields).toContain('h2h_away');
    expect(payload.projection_context.missing_fields).toContain('h2h_away');

    const validation = validateCardPayload(card.cardType, payload);
    expect(validation.success).toBe(false);
    expect(validation.errors.join(' ')).toContain('odds_context.h2h_away');
  });

  test('rejects placeholder recommended_bet_type drift for soccer payloads', () => {
    const oddsSnapshot = buildOddsSnapshot();
    const card = generateSoccerCard(oddsSnapshot.game_id, oddsSnapshot);
    const payload = {
      ...card.payloadData,
      recommended_bet_type: 'unknown',
    };

    const validation = validateCardPayload(card.cardType, payload);
    expect(validation.success).toBe(false);
    expect(validation.errors.join(' ')).toContain('recommended_bet_type');
  });

  test('emits AWAY moneyline recommendation when away side is favored', () => {
    const oddsSnapshot = buildOddsSnapshot({
      h2h_home: 120,
      h2h_away: -140,
    });
    const card = generateSoccerCard(oddsSnapshot.game_id, oddsSnapshot);
    const payload = card.payloadData;

    expect(payload.selection).toEqual({
      side: 'AWAY',
      team: 'Manchester City',
    });
    expect(payload.price).toBe(-140);
    expect(payload.recommendation.type).toBe('ML_AWAY');
  });
});

describe('soccer model mode routing helpers', () => {
  const originalMode = process.env.SOCCER_MODEL_MODE;
  const originalModeLegacy = process.env.soccer_model_mode;

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.SOCCER_MODEL_MODE;
    } else {
      process.env.SOCCER_MODEL_MODE = originalMode;
    }
    if (originalModeLegacy === undefined) {
      delete process.env.soccer_model_mode;
    } else {
      process.env.soccer_model_mode = originalModeLegacy;
    }
  });

  test('defaults to SIDES_AND_PROPS when unset/invalid', () => {
    delete process.env.SOCCER_MODEL_MODE;
    delete process.env.soccer_model_mode;
    expect(resolveSoccerModelMode()).toBe('SIDES_AND_PROPS');

    process.env.SOCCER_MODEL_MODE = 'invalid';
    expect(resolveSoccerModelMode()).toBe('SIDES_AND_PROPS');
  });

  test('resolves explicit OHIO_PROPS_ONLY mode', () => {
    process.env.SOCCER_MODEL_MODE = 'OHIO_PROPS_ONLY';
    expect(resolveSoccerModelMode()).toBe('OHIO_PROPS_ONLY');
  });

  test('gates odds-backed card emission in OHIO_PROPS_ONLY', () => {
    expect(shouldEmitOddsBackedCard('OHIO_PROPS_ONLY', 'soccer_ml')).toBe(false);
    expect(shouldEmitOddsBackedCard('OHIO_PROPS_ONLY', 'asian_handicap_home')).toBe(false);
    expect(shouldEmitOddsBackedCard('SIDES_AND_PROPS', 'soccer_ml')).toBe(true);
  });

  test('identifies side markets', () => {
    expect(isSoccerSideMarket('soccer_ml')).toBe(true);
    expect(isSoccerSideMarket('asian_handicap_home')).toBe(true);
    expect(isSoccerSideMarket('asian_handicap_away')).toBe(true);
    expect(isSoccerSideMarket('soccer_game_total')).toBe(false);
  });
});

describe('footie side lambda/model helpers', () => {
  test('uses STATS_PRIMARY when explicit non-market lambdas are available', () => {
    const snap = buildOddsSnapshot({
      h2h_home: null,
      h2h_away: null,
      spread_home: null,
      spread_away: null,
      raw_data: JSON.stringify({
        league: 'EPL',
        lambda_home: 1.74,
        lambda_away: 1.09,
        lambda_source: 'stats_seed',
      }),
    });
    const lambdaModel = computeFootieLambdas({
      oddsSnapshot: snap,
      rawData: JSON.parse(snap.raw_data),
      side: 'HOME',
      offeredLine: null,
    });

    expect(lambdaModel.lambda_source).toBe('STATS_PRIMARY');
    expect(lambdaModel.lambda_home).toBeCloseTo(1.74, 3);
    expect(lambdaModel.lambda_away).toBeCloseTo(1.09, 3);
  });

  test('uses MARKET_FALLBACK when stats are missing and market inputs exist', () => {
    const snap = buildOddsSnapshot({
      h2h_home: -125,
      h2h_away: 102,
      spread_home: -0.5,
      spread_away: 0.5,
      raw_data: JSON.stringify({
        league: 'EPL',
        market: 'spreads',
        total_line: 2.5,
      }),
    });
    const lambdaModel = computeFootieLambdas({
      oddsSnapshot: snap,
      rawData: JSON.parse(snap.raw_data),
      side: 'HOME',
      offeredLine: -0.5,
    });

    expect(lambdaModel.lambda_source).toBe('MARKET_FALLBACK');
    expect(lambdaModel.lambda_source_quality).toBe('LOW');
    expect(lambdaModel.lambda_home).toEqual(expect.any(Number));
    expect(lambdaModel.lambda_away).toEqual(expect.any(Number));
  });

  test('ml probabilities sum to ~1 and draw increases when lambdas converge', () => {
    const separated = computeFootieMlProbabilities({
      lambdaHome: 1.9,
      lambdaAway: 1.0,
      leagueTag: 'EPL',
    });
    const balanced = computeFootieMlProbabilities({
      lambdaHome: 1.4,
      lambdaAway: 1.3,
      leagueTag: 'EPL',
    });
    const boostedHome = computeFootieMlProbabilities({
      lambdaHome: 2.1,
      lambdaAway: 1.0,
      leagueTag: 'EPL',
    });

    const separatedTotal = separated.p_home_win + separated.p_draw + separated.p_away_win;
    expect(separatedTotal).toBeCloseTo(1, 4);
    expect(boostedHome.p_home_win).toBeGreaterThan(separated.p_home_win);
    expect(balanced.p_draw).toBeGreaterThan(separated.p_draw);
  });
});

describe('soccer scope — Tier 1 market hardening', () => {
  // ---- normalizeToCanonicalSoccerMarket ----
  describe('normalizeToCanonicalSoccerMarket', () => {
    test("'player_shots' -> 'player_shots'", () => {
      expect(normalizeToCanonicalSoccerMarket('player_shots')).toBe('player_shots');
    });
    test("'team_totals' -> 'team_totals'", () => {
      expect(normalizeToCanonicalSoccerMarket('team_totals')).toBe('team_totals');
    });
    test("'to_score_or_assist' -> 'to_score_or_assist'", () => {
      expect(normalizeToCanonicalSoccerMarket('to_score_or_assist')).toBe('to_score_or_assist');
    });
    test("'player_shots_on_target' -> 'player_shots_on_target'", () => {
      expect(normalizeToCanonicalSoccerMarket('player_shots_on_target')).toBe('player_shots_on_target');
    });
    test("'draws' -> null (out of scope)", () => {
      expect(normalizeToCanonicalSoccerMarket('draws')).toBeNull();
    });
    test("'asian_handicap' -> null (banned)", () => {
      expect(normalizeToCanonicalSoccerMarket('asian_handicap')).toBeNull();
    });
    test("'asian_handicap_home' -> 'asian_handicap_home'", () => {
      expect(normalizeToCanonicalSoccerMarket('asian_handicap_home')).toBe('asian_handicap_home');
    });
    test("'asian_handicap_away' -> 'asian_handicap_away'", () => {
      expect(normalizeToCanonicalSoccerMarket('asian_handicap_away')).toBe('asian_handicap_away');
    });
    test("'1x2' -> null (banned)", () => {
      expect(normalizeToCanonicalSoccerMarket('1x2')).toBeNull();
    });
    test('undefined -> null', () => {
      expect(normalizeToCanonicalSoccerMarket(undefined)).toBeNull();
    });
  });

  // ---- buildSoccerTier1Payload — team_totals ----
  describe('buildSoccerTier1Payload — team_totals happy path', () => {
    test('produces valid payload with pass_reason=null when full context provided', () => {
      const snap = buildSoccerOddsSnapshot({
        raw_data: {
          league: 'EPL',
          soccer_market: 'team_totals',
          line: 'o1.5',
          price: -115,
          projection_basis: 'implied_team_lambda_1.72',
          fair_prob: 0.62,
          implied_prob: 0.535,
        },
      });
      const { pass_reason, payloadData } = buildSoccerTier1Payload(
        snap.game_id,
        snap,
        'team_totals',
      );
      expect(pass_reason).toBeNull();
      expect(payloadData.canonical_market_key).toBe('team_totals');
      expect(payloadData.market_family).toBe('tier1');
      const validation = validateCardPayload('soccer', payloadData);
      expect(validation.success).toBe(true);
    });
  });

  describe('buildSoccerTier1Payload — team_totals missing line', () => {
    test('sets pass_reason=MISSING_LINE and includes line in missing_context_flags', () => {
      const snap = buildSoccerOddsSnapshot({
        raw_data: {
          league: 'EPL',
          soccer_market: 'team_totals',
          price: -115,
          projection_basis: 'implied_team_lambda_1.72',
        },
      });
      const { pass_reason, payloadData } = buildSoccerTier1Payload(
        snap.game_id,
        snap,
        'team_totals',
      );
      expect(pass_reason).toBe('MISSING_LINE');
      expect(payloadData.missing_context_flags).toContain('line');
      const validation = validateCardPayload('soccer', payloadData);
      expect(validation.success).toBe(true);
    });
  });

  // ---- buildSoccerTier1Payload — player_shots ----
  describe('buildSoccerTier1Payload — player_shots happy path', () => {
    test('returns valid payload with eligibility and pass_reason=null', () => {
      const snap = buildSoccerOddsSnapshot({
        raw_data: {
          league: 'EPL',
          soccer_market: 'player_shots',
          player_name: 'Erling Haaland',
          selection_side: 'OVER',
          line: 2.5,
          price: -130,
          projection_basis: 'shots_per90_3.1_vs_league_avg',
          fair_prob: 0.60,
          implied_prob: 0.565,
          player_context: {
            is_starter: true,
            projected_minutes: 78,
            role_tags: ['PRIMARY_VOLUME_SHOOTER'],
            shots_per90: 3.1,
          },
        },
      });
      const { pass_reason, payloadData } = buildSoccerTier1Payload(
        snap.game_id,
        snap,
        'player_shots',
      );
      expect(pass_reason).toBeNull();
      expect(payloadData.kind).toBe('PLAY');
      expect(payloadData.market_type).toBe('PROP');
      expect(payloadData.selection).toEqual({ side: 'OVER', team: 'Erling Haaland' });
      expect(payloadData.player_name).toBe('Erling Haaland');
      expect(payloadData.eligibility.starter_signal).toBe(true);
      expect(payloadData.eligibility.role_tags).toContain('PRIMARY_VOLUME_SHOOTER');
      const validation = validateCardPayload('soccer', payloadData);
      expect(validation.success).toBe(true);
    });
  });

  describe('buildSoccerTier1Payload — player_shots no starter signal', () => {
    test('sets pass_reason=NO_STARTER_SIGNAL and flags starter_signal', () => {
      const snap = buildSoccerOddsSnapshot({
        raw_data: {
          league: 'EPL',
          soccer_market: 'player_shots',
          player_name: 'Hwang Hee-chan',
          price: -130,
          projection_basis: 'shots_per90_2.8',
          player_context: { is_starter: false },
        },
      });
      const { pass_reason, payloadData } = buildSoccerTier1Payload(
        snap.game_id,
        snap,
        'player_shots',
      );
      expect(pass_reason).toBe('NO_STARTER_SIGNAL');
      expect(payloadData.missing_context_flags).toContain('starter_signal');
    });
  });

  describe('buildSoccerTier1Payload — missing player identity downgrade', () => {
    test('downgrades player market to INFO when player identity is missing', () => {
      const snap = buildSoccerOddsSnapshot({
        raw_data: {
          league: 'EPL',
          soccer_market: 'player_shots',
          price: -120,
          projection_basis: 'shots_per90_2.7',
          player_context: {
            is_starter: true,
            projected_minutes: 74,
            role_tags: ['PRIMARY_VOLUME_SHOOTER'],
          },
        },
      });

      const { pass_reason, payloadData } = buildSoccerTier1Payload(
        snap.game_id,
        snap,
        'player_shots',
      );

      expect(pass_reason).toBe('MISSING_PLAYER_IDENTITY');
      expect(payloadData.market_type).toBe('INFO');
      expect(payloadData.missing_context_flags).toContain('player_identity');
    });
  });

  describe('buildSoccerTier1Payload — player_shots price cap violation', () => {
    test('sets pass_reason=PRICE_CAP_VIOLATION and validator rejects', () => {
      const snap = buildSoccerOddsSnapshot({
        raw_data: {
          league: 'EPL',
          soccer_market: 'player_shots',
          price: -160,
          projection_basis: 'shots_per90_3.1_vs_league_avg',
          fair_prob: 0.60,
          implied_prob: 0.615,
          player_context: {
            is_starter: true,
            projected_minutes: 82,
            role_tags: ['PRIMARY_VOLUME_SHOOTER'],
          },
        },
      });
      const { pass_reason, payloadData } = buildSoccerTier1Payload(
        snap.game_id,
        snap,
        'player_shots',
      );
      expect(pass_reason).toBe('PRICE_CAP_VIOLATION');
      const validation = validateCardPayload('soccer', payloadData);
      expect(validation.success).toBe(false);
      expect(validation.errors.join(' ')).toContain('price_cap');
    });
  });

  // ---- buildSoccerTier1Payload — to_score_or_assist ----
  describe('buildSoccerTier1Payload — TSOA happy path', () => {
    test('returns valid payload with TERMINAL_NODE role tag', () => {
      const snap = buildSoccerOddsSnapshot({
        raw_data: {
          league: 'EPL',
          soccer_market: 'to_score_or_assist',
          player_name: 'Bukayo Saka',
          selection_side: 'OVER',
          line: 0.5,
          price: -135,
          projection_basis: 'xg_xa_combined_0.60',
          fair_prob: 0.58,
          implied_prob: 0.574,
          player_context: {
            is_starter: true,
            projected_minutes: 85,
            role_tags: ['TERMINAL_NODE'],
            xg_per90: 0.42,
            xa_per90: 0.18,
          },
        },
      });
      const { pass_reason, payloadData } = buildSoccerTier1Payload(
        snap.game_id,
        snap,
        'to_score_or_assist',
      );
      expect(pass_reason).toBeNull();
      expect(payloadData.market_type).toBe('PROP');
      expect(payloadData.selection).toEqual({ side: 'OVER', team: 'Bukayo Saka' });
      expect(payloadData.player_name).toBe('Bukayo Saka');
      expect(payloadData.eligibility.role_tags).toContain('TERMINAL_NODE');
      const validation = validateCardPayload('soccer', payloadData);
      expect(validation.success).toBe(true);
    });
  });

  describe('buildSoccerTier1Payload — team_totals mapping for games contract', () => {
    test('emits TEAM_TOTAL market_type with OVER/UNDER selection', () => {
      const snap = buildSoccerOddsSnapshot({
        raw_data: {
          league: 'EPL',
          soccer_market: 'team_totals',
          team: 'Chelsea FC',
          selection_side: 'UNDER',
          line: 'u2.5',
          price: -105,
          projection_basis: 'implied_team_lambda_1.21',
          fair_prob: 0.56,
          implied_prob: 0.512,
        },
      });

      const { payloadData } = buildSoccerTier1Payload(
        snap.game_id,
        snap,
        'team_totals',
      );

      expect(payloadData.market_type).toBe('TEAM_TOTAL');
      expect(payloadData.selection).toEqual({ side: 'UNDER', team: 'Chelsea FC' });
      const validation = validateCardPayload('soccer', payloadData);
      expect(validation.success).toBe(true);
    });
  });

  describe('buildSoccerTier1Payload — TSOA missing role tag', () => {
    test('sets pass_reason=MISSING_ROLE_TAG when no qualifying role tag present', () => {
      const snap = buildSoccerOddsSnapshot({
        raw_data: {
          league: 'EPL',
          soccer_market: 'to_score_or_assist',
          price: -130,
          projection_basis: 'xg_xa_combined_0.45',
          player_context: {
            is_starter: true,
            projected_minutes: 80,
            role_tags: [],
          },
        },
      });
      const { pass_reason, payloadData } = buildSoccerTier1Payload(
        snap.game_id,
        snap,
        'to_score_or_assist',
      );
      expect(pass_reason).toBe('MISSING_ROLE_TAG');
      expect(payloadData.missing_context_flags).toContain('tsoa_role_tag');
    });
  });

  // ---- Validator: placeholder rejection ----
  describe('Placeholder rejection via validator', () => {
    test("projection_basis='unknown' fails validator with 'placeholder' in error", () => {
      const payload = {
        canonical_market_key: 'team_totals',
        market_family: 'tier1',
        sport: 'SOCCER',
        game_id: 'game-001',
        home_team: 'Team A',
        away_team: 'Team B',
        generated_at: new Date().toISOString(),
        missing_context_flags: [],
        pass_reason: null,
        projection_basis: 'unknown',
        edge_ev: 0.03,
        price: -115,
      };
      const validation = validateCardPayload('soccer', payload);
      expect(validation.success).toBe(false);
      expect(validation.errors.join(' ')).toContain('placeholder');
    });
  });

  // ---- Validator: banned market key ----
  describe('Banned market via validator', () => {
    test("canonical_market_key='match_total' (not in soccer enum) fails validator", () => {
      const payload = {
        canonical_market_key: 'match_total',
        market_family: 'tier1',
        sport: 'SOCCER',
        game_id: 'game-001',
        home_team: 'Team A',
        away_team: 'Team B',
        generated_at: new Date().toISOString(),
        missing_context_flags: [],
        pass_reason: null,
        projection_basis: 'model_implied',
        edge_ev: 0.02,
        price: -110,
      };
      const validation = validateCardPayload('soccer', payload);
      expect(validation.success).toBe(false);
    });
  });
});

// ============================================================================
// New: normalizeToCanonicalSoccerMarket — odds API market keys
// ============================================================================

describe('normalizeToCanonicalSoccerMarket — odds API market keys', () => {
  test("'h2h' -> 'soccer_ml'", () => {
    expect(normalizeToCanonicalSoccerMarket('h2h')).toBe('soccer_ml');
  });
  test("'moneyline' -> 'soccer_ml'", () => {
    expect(normalizeToCanonicalSoccerMarket('moneyline')).toBe('soccer_ml');
  });
  test("'totals' -> 'soccer_game_total'", () => {
    expect(normalizeToCanonicalSoccerMarket('totals')).toBe('soccer_game_total');
  });
  test("'game_total' -> 'soccer_game_total'", () => {
    expect(normalizeToCanonicalSoccerMarket('game_total')).toBe('soccer_game_total');
  });
  test("'double_chance' -> 'soccer_double_chance' (no longer banned)", () => {
    expect(normalizeToCanonicalSoccerMarket('double_chance')).toBe('soccer_double_chance');
  });
  test("'doubleChance' -> 'soccer_double_chance' (camelCase normalizes via replace)", () => {
    expect(normalizeToCanonicalSoccerMarket('doubleChance')).toBe('soccer_double_chance');
  });
  test("'asian_handicap_home' -> 'asian_handicap_home'", () => {
    expect(normalizeToCanonicalSoccerMarket('asian_handicap_home')).toBe('asian_handicap_home');
  });
  test("'asian_handicap_away' -> 'asian_handicap_away'", () => {
    expect(normalizeToCanonicalSoccerMarket('asian_handicap_away')).toBe('asian_handicap_away');
  });
  test("'asian_handicap' -> null (banned)", () => {
    expect(normalizeToCanonicalSoccerMarket('asian_handicap')).toBeNull();
  });
  test("'1x2' -> null (banned)", () => {
    expect(normalizeToCanonicalSoccerMarket('1x2')).toBeNull();
  });
});

// ============================================================================
// New: buildSoccerOddsBackedCard — soccer_ml
// ============================================================================

describe('buildSoccerOddsBackedCard — soccer_ml', () => {
  test('produces lambda-based soccer_ml payload with explicit fallback flags', () => {
    const snap = buildOddsSnapshot({ h2h_home: -120, h2h_away: 105 });
    const card = buildSoccerOddsBackedCard(snap.game_id, snap, 'soccer_ml');
    expect(card.cardType).toBe('soccer_ml');
    expect(card.payloadData.market_type).toBe('MONEYLINE');
    expect(card.payloadData.model_prob).toEqual(expect.any(Number));
    expect(card.payloadData.p_home_win).toEqual(expect.any(Number));
    expect(card.payloadData.p_draw).toEqual(expect.any(Number));
    expect(card.payloadData.p_away_win).toEqual(expect.any(Number));
    expect(card.payloadData.edge).toEqual(expect.any(Number));
    expect(card.payloadData.lambda_source).toBeTruthy();
    expect(card.payloadData.pass_reason).toBeTruthy();
    expect(card.payloadData.reason_codes).toContain(card.payloadData.pass_reason);
    expect(card.payloadData.missing_context_flags).toEqual([]);
    const v = validateCardPayload('soccer_ml', card.payloadData);
    expect(v.success).toBe(true);
  });
});

describe('buildSoccerSideMarketCard', () => {
  test('routes soccer_ml through FOOTIE_SIDES_ENGINE metadata', () => {
    const snap = buildOddsSnapshot({ h2h_home: -120, h2h_away: 105 });
    const card = buildSoccerSideMarketCard(snap.game_id, snap, 'soccer_ml');
    expect(card.cardType).toBe('soccer_ml');
    expect(card.payloadData.footie_engine).toBe('FOOTIE_SIDES_ENGINE');
    expect(card.payloadData.model_inputs_source).toBe('stats_team_strength');
  });

  test('throws for non-side market inputs', () => {
    const snap = buildOddsSnapshot();
    expect(() =>
      buildSoccerSideMarketCard(snap.game_id, snap, 'soccer_game_total'),
    ).toThrow('not a soccer side market');
  });
});

// ============================================================================
// New: buildSoccerOddsBackedCard — soccer_game_total
// ============================================================================

describe('buildSoccerOddsBackedCard — soccer_game_total', () => {
  test('produces valid soccer_game_total payload when line provided in raw_data', () => {
    const snap = buildOddsSnapshot({
      raw_data: JSON.stringify({ league: 'EPL', market: 'totals', total_line: 2.5, over_price: -115, under_price: -105, selection: 'OVER' }),
    });
    const card = buildSoccerOddsBackedCard(snap.game_id, snap, 'soccer_game_total');
    expect(card.cardType).toBe('soccer_game_total');
    expect(card.payloadData.market_type).toBe('GAME_TOTAL');
    expect(card.payloadData.line).toBe(2.5);
    expect(card.payloadData.pass_reason).toBeNull();
    const v = validateCardPayload('soccer_game_total', card.payloadData);
    expect(v.success).toBe(true);
  });

  test('sets pass_reason=MISSING_LINE when total_line absent', () => {
    const snap = buildOddsSnapshot({ raw_data: JSON.stringify({ league: 'EPL', market: 'totals' }) });
    const card = buildSoccerOddsBackedCard(snap.game_id, snap, 'soccer_game_total');
    expect(card.payloadData.pass_reason).toBe('MISSING_LINE');
  });
});

// ============================================================================
// New: buildSoccerOddsBackedCard — soccer_double_chance
// ============================================================================

describe('buildSoccerOddsBackedCard — soccer_double_chance', () => {
  test('produces valid soccer_double_chance payload', () => {
    const snap = buildOddsSnapshot({
      raw_data: JSON.stringify({ league: 'EPL', market: 'doubleChance', dc_outcome: 'home_or_draw', dc_price: -145, edge_basis: 'vig_gap_0.04' }),
    });
    const card = buildSoccerOddsBackedCard(snap.game_id, snap, 'soccer_double_chance');
    expect(card.cardType).toBe('soccer_double_chance');
    expect(card.payloadData.market_type).toBe('DOUBLE_CHANCE');
    expect(card.payloadData.outcome).toBe('home_or_draw');
    const v = validateCardPayload('soccer_double_chance', card.payloadData);
    expect(v.success).toBe(true);
  });
});

describe('buildSoccerOddsBackedCard — asian handicap', () => {
  test('produces valid asian_handicap_home payload with required AH fields', () => {
    const snap = buildOddsSnapshot({
      raw_data: JSON.stringify({
        league: 'EPL',
        market: 'asian_handicap_home',
        ah_line: -0.75,
        ah_price: 102,
        ah_opposite_price: -122,
        lambda_home: 1.6,
        lambda_away: 1.1,
      }),
    });

    const card = buildSoccerOddsBackedCard(snap.game_id, snap, 'asian_handicap_home');
    expect(card.cardType).toBe('asian_handicap_home');
    expect(card.payloadData.kind).toBe('PLAY');
    expect(card.payloadData.recommended_bet_type).toBe('spread');
    expect(card.payloadData.prediction).toBe('HOME');
    expect(card.payloadData.selection).toEqual({
      side: 'HOME',
      team: 'Chelsea FC',
    });
    expect(card.payloadData.market_type).toBe('ASIAN_HANDICAP');
    expect(card.payloadData.side).toBe('HOME');
    expect(card.payloadData.line).toBe(-0.75);
    expect(card.payloadData.price).toBe(102);
    expect(card.payloadData.split_flag).toBe(true);
    expect(card.payloadData.probabilities).toEqual(
      expect.objectContaining({
        P_win: expect.any(Number),
        P_push: expect.any(Number),
        P_loss: expect.any(Number),
      }),
    );
    expect(card.payloadData.edge_ev).toEqual(expect.any(Number));
    expect(card.payloadData.expected_value).toEqual(expect.any(Number));

    const v = validateCardPayload('asian_handicap_home', card.payloadData);
    expect(v.success).toBe(true);
  });

  test('flags missing AH inputs with pass_reason and missing_context_flags', () => {
    const snap = buildOddsSnapshot({
      raw_data: JSON.stringify({
        league: 'EPL',
        market: 'asian_handicap_away',
        ah_line: 0.25,
        ah_price: -108,
      }),
    });

    const card = buildSoccerOddsBackedCard(snap.game_id, snap, 'asian_handicap_away');
    expect(card.payloadData.kind).toBe('PLAY');
    expect(card.payloadData.recommended_bet_type).toBe('spread');
    expect(card.payloadData.prediction).toBe('AWAY');
    expect(card.payloadData.selection).toEqual({
      side: 'AWAY',
      team: 'Manchester City',
    });
    expect(card.payloadData.pass_reason).toBe('MISSING_AH_INPUTS');
    expect(card.payloadData.missing_context_flags).toContain('opposite_price');
    expect(card.payloadData.missing_context_flags).not.toContain('lambda_home');
    expect(card.payloadData.missing_context_flags).not.toContain('lambda_away');
  });

  test('falls back to spread snapshot fields when raw AH fields are absent', () => {
    const snap = buildOddsSnapshot({
      spread_home: -0.5,
      spread_away: 0.5,
      spread_price_home: -112,
      spread_price_away: -108,
      raw_data: JSON.stringify({
        league: 'EPL',
        market: 'spreads',
      }),
    });

    const homeCard = buildSoccerOddsBackedCard(
      snap.game_id,
      snap,
      'asian_handicap_home',
    );
    const awayCard = buildSoccerOddsBackedCard(
      snap.game_id,
      snap,
      'asian_handicap_away',
    );

    expect(homeCard.payloadData.line).toBe(-0.5);
    expect(homeCard.payloadData.price).toBe(-112);
    expect(homeCard.payloadData.opposite_price).toBe(-108);
    expect(homeCard.payloadData.selection).toEqual({
      side: 'HOME',
      team: 'Chelsea FC',
    });
    expect(homeCard.payloadData.model_prob).toEqual(expect.any(Number));
    expect(homeCard.payloadData.edge).toEqual(expect.any(Number));
    expect(homeCard.payloadData.lambda_source).toBe('MARKET_FALLBACK');
    expect(homeCard.payloadData.pass_reason).toBe('BLOCKED_MARKET_FALLBACK_ONLY');
    expect(homeCard.payloadData.reason_codes).toContain('BLOCKED_MARKET_FALLBACK_ONLY');

    expect(awayCard.payloadData.line).toBe(0.5);
    expect(awayCard.payloadData.price).toBe(-108);
    expect(awayCard.payloadData.opposite_price).toBe(-112);
    expect(awayCard.payloadData.selection).toEqual({
      side: 'AWAY',
      team: 'Manchester City',
    });
    expect(awayCard.payloadData.model_prob).toEqual(expect.any(Number));
    expect(awayCard.payloadData.edge).toEqual(expect.any(Number));
    expect(awayCard.payloadData.lambda_source).toBe('MARKET_FALLBACK');
    expect(awayCard.payloadData.pass_reason).toBe('BLOCKED_MARKET_FALLBACK_ONLY');
    expect(awayCard.payloadData.reason_codes).toContain('BLOCKED_MARKET_FALLBACK_ONLY');
  });

  test('fails validator when AH selection side drifts from canonical side', () => {
    const snap = buildOddsSnapshot({
      raw_data: JSON.stringify({
        league: 'EPL',
        market: 'asian_handicap_home',
        ah_line: -0.5,
        ah_price: -110,
        ah_opposite_price: -110,
        lambda_home: 1.5,
        lambda_away: 1.2,
      }),
    });
    const card = buildSoccerOddsBackedCard(snap.game_id, snap, 'asian_handicap_home');
    const driftedPayload = {
      ...card.payloadData,
      selection: { ...card.payloadData.selection, side: 'AWAY' },
    };

    const result = validateCardPayload('asian_handicap_home', driftedPayload);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('selection.side');
  });
});

// ============================================================================
// New: Track 2 projection-only cards
// ============================================================================

describe('Track 2 projection-only cards', () => {
  test('soccer card with projection_only:true passes validator without price', () => {
    const payload = {
      canonical_market_key: 'to_score_or_assist',
      market_family: 'tier1',
      sport: 'SOCCER',
      game_id: 'game-proj-001',
      home_team: 'Arsenal',
      away_team: 'Chelsea',
      generated_at: new Date().toISOString(),
      missing_context_flags: ['price'],
      pass_reason: null,
      projection_basis: 'xg_xa_combined_0.55',
      edge_ev: 0.04,
      price: null,
      projection_only: true,
    };
    const v = validateCardPayload('soccer', payload);
    expect(v.success).toBe(true);
  });
});

describe('soccer tier-1 prop line identity mapping', () => {
  test('buildDeterministicSoccerPlayerId is stable for same game + player', () => {
    const first = buildDeterministicSoccerPlayerId({
      gameId: 'soccer-game-identity-001',
      playerName: 'Bryan Mbeumo',
    });
    const second = buildDeterministicSoccerPlayerId({
      gameId: 'soccer-game-identity-001',
      playerName: 'Bryan Mbeumo',
    });

    expect(first).toBe(second);
    expect(first.startsWith('soccer-')).toBe(true);
  });

  test('buildSoccerTier1CardFromPropLine emits PROP payload with player identity', () => {
    const snap = buildOddsSnapshot({
      game_id: 'soccer-game-identity-002',
      home_team: 'Brentford',
      away_team: 'Wolverhampton Wanderers',
      game_time_utc: '2026-03-16T20:00:00.000Z',
    });

    const card = buildSoccerTier1CardFromPropLine(
      'soccer-game-identity-002',
      snap,
      {
        player_name: 'Bryan Mbeumo',
        prop_type: 'player_shots',
        period: 'full_game',
        line: 1.5,
        over_price: -110,
        under_price: -120,
      },
    );

    expect(card).toBeTruthy();
    expect(card.payloadData.market_type).toBe('PROP');
    expect(card.payloadData.player_name).toBe('Bryan Mbeumo');
    expect(card.payloadData.player_id).toBeTruthy();
    expect(card.payloadData.selection).toEqual({
      side: 'OVER',
      team: 'Bryan Mbeumo',
    });

    const validation = validateCardPayload('soccer', card.payloadData);
    expect(validation.success).toBe(true);
  });

  test('blocks known stale-team player props by default', () => {
    expect(isBlockedSoccerPropPlayer('Matheus Cunha')).toBe(true);

    const snap = buildOddsSnapshot({
      game_id: 'soccer-game-identity-003',
      home_team: 'Brentford',
      away_team: 'Wolverhampton Wanderers',
      game_time_utc: '2026-03-16T20:00:00.000Z',
    });

    const card = buildSoccerTier1CardFromPropLine(
      'soccer-game-identity-003',
      snap,
      {
        player_name: 'Matheus Cunha',
        prop_type: 'player_shots',
        period: 'full_game',
        line: 1.5,
        over_price: -110,
        under_price: -120,
      },
    );

    expect(card).toBeNull();
  });

  test('skips unrealistic high player_shots lines', () => {
    const snap = buildOddsSnapshot({
      game_id: 'soccer-game-identity-004',
      home_team: 'Brentford',
      away_team: 'Wolverhampton Wanderers',
      game_time_utc: '2026-03-16T20:00:00.000Z',
    });

    const card = buildSoccerTier1CardFromPropLine(
      'soccer-game-identity-004',
      snap,
      {
        player_name: 'Bryan Mbeumo',
        prop_type: 'player_shots',
        period: 'full_game',
        line: 6.0,
        over_price: -110,
        under_price: -120,
      },
    );

    expect(card).toBeNull();
  });
});

describe('WI-0472 soccer rollout patch helpers', () => {
  afterEach(() => {
    delete process.env.ENABLE_DECISION_BASIS_TAGS;
    delete process.env.ENABLE_PROJECTION_PERF_LEDGER;
  });

  test('applySoccerDecisionBasisMeta is additive and flag-gated', () => {
    const payload = {
      canonical_market_key: 'to_score_or_assist',
      edge_ev: 0.03,
    };

    const noFlag = applySoccerDecisionBasisMeta(payload, {
      isProjectionOnly: true,
      marketLineSource: 'synthetic',
    });
    expect(noFlag).toBeNull();
    expect(payload.decision_basis_meta).toBeUndefined();

    process.env.ENABLE_DECISION_BASIS_TAGS = 'true';
    const withFlag = applySoccerDecisionBasisMeta(payload, {
      isProjectionOnly: true,
      marketLineSource: 'synthetic',
    });

    expect(withFlag).toEqual(
      expect.objectContaining({
        decision_basis: 'PROJECTION_ONLY',
        execution_eligible: false,
        market_line_source: 'synthetic',
      }),
    );
  });

  test('recordSoccerProjectionTelemetry writes only projection-only entries when enabled', () => {
    process.env.ENABLE_PROJECTION_PERF_LEDGER = 'true';

    const recordProjectionEntry = jest.fn();
    const card = {
      id: 'card-soccer-proj-001',
      gameId: 'game-soccer-proj-001',
      cardType: 'soccer',
    };
    const payloadData = {
      canonical_market_key: 'to_score_or_assist',
      player_name: 'Bukayo Saka',
      selection: { side: 'OVER' },
      confidence: 0.78,
      line: 0.5,
      decision: { projection: 0.64 },
      decision_basis_meta: {
        decision_basis: 'PROJECTION_ONLY',
        volatility_band: 'HIGH',
      },
    };

    recordSoccerProjectionTelemetry(recordProjectionEntry, card, payloadData);
    expect(recordProjectionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        cardId: 'card-soccer-proj-001',
        gameId: 'game-soccer-proj-001',
        sport: 'SOCCER',
        decisionBasis: 'PROJECTION_ONLY',
      }),
    );

    recordProjectionEntry.mockClear();
    payloadData.decision_basis_meta.decision_basis = 'ODDS_BACKED';
    recordSoccerProjectionTelemetry(recordProjectionEntry, card, payloadData);
    expect(recordProjectionEntry).not.toHaveBeenCalled();
  });
});
