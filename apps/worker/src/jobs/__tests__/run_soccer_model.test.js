const { validateCardPayload } = require('@cheddar-logic/data');
const {
  generateSoccerCard,
  deriveWinProbHome,
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
