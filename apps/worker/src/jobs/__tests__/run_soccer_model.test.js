const { validateCardPayload } = require('@cheddar-logic/data');
const {
  generateSoccerCard,
  deriveWinProbHome,
  normalizeToCanonicalSoccerMarket,
  buildSoccerTier1Payload,
} = require('../run_soccer_model');

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

describe('soccer ohio scope — Tier 1 market hardening', () => {
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
      const validation = validateCardPayload('soccer-ohio-scope', payloadData);
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
      const validation = validateCardPayload('soccer-ohio-scope', payloadData);
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
      expect(payloadData.eligibility.starter_signal).toBe(true);
      expect(payloadData.eligibility.role_tags).toContain('PRIMARY_VOLUME_SHOOTER');
      const validation = validateCardPayload('soccer-ohio-scope', payloadData);
      expect(validation.success).toBe(true);
    });
  });

  describe('buildSoccerTier1Payload — player_shots no starter signal', () => {
    test('sets pass_reason=NO_STARTER_SIGNAL and flags starter_signal', () => {
      const snap = buildSoccerOddsSnapshot({
        raw_data: {
          league: 'EPL',
          soccer_market: 'player_shots',
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
      const validation = validateCardPayload('soccer-ohio-scope', payloadData);
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
      expect(payloadData.eligibility.role_tags).toContain('TERMINAL_NODE');
      const validation = validateCardPayload('soccer-ohio-scope', payloadData);
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
      const validation = validateCardPayload('soccer-ohio-scope', payload);
      expect(validation.success).toBe(false);
      expect(validation.errors.join(' ')).toContain('placeholder');
    });
  });

  // ---- Validator: banned market key ----
  describe('Banned market via validator', () => {
    test("canonical_market_key='match_total' (not in Ohio enum) fails validator", () => {
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
      const validation = validateCardPayload('soccer-ohio-scope', payload);
      expect(validation.success).toBe(false);
    });
  });
});
