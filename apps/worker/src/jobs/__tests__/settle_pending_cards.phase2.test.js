/**
 * Test: Phase 2 - Top-Level Card Selection
 * 
 * Verifies that selectTopLevelCard() correctly picks the highest confidence
 * card from multiple cards for the same game, preventing double-settlement.
 */

const { __private } = require('../settle_pending_cards.js');
const { selectTopLevelCard } = __private;

describe('Phase 2: Top-Level Card Selection', () => {
  test('selects highest confidence card from multiple options', () => {
    const cardsForGame = [
      {
        result_id: 'result-1',
        card_id: 'card-nba-rest-advantage',
        game_id: 'game-123',
        market_key: 'game-123|ML|HOME',
        market_type: 'MONEYLINE',
        locked_price: -110,
        payload_data: JSON.stringify({ confidence: 52 }),
      },
      {
        result_id: 'result-2',
        card_id: 'card-nba-base-projection',
        game_id: 'game-123',
        market_key: 'game-123|ML|HOME',
        market_type: 'MONEYLINE',
        locked_price: -110,
        payload_data: JSON.stringify({ confidence: 68 }), // HIGHEST
      },
      {
        result_id: 'result-3',
        card_id: 'card-nba-pace-totals',
        game_id: 'game-123',
        market_key: 'game-123|ML|AWAY',
        market_type: 'MONEYLINE',
        locked_price: +120,
        payload_data: JSON.stringify({ confidence: 44 }),
      },
    ];

    const topCard = selectTopLevelCard(cardsForGame);

    expect(topCard).toBeDefined();
    expect(topCard.card_id).toBe('card-nba-base-projection');
    expect(topCard.result_id).toBe('result-2');
    
    const payload = JSON.parse(topCard.payload_data);
    expect(payload.confidence).toBe(68);
  });

  test('returns single card when only one valid', () => {
    const cardsForGame = [
      {
        result_id: 'result-1',
        card_id: 'card-nba-only',
        game_id: 'game-456',
        market_key: 'game-456|ML|HOME',
        market_type: 'MONEYLINE',
        locked_price: -110,
        payload_data: JSON.stringify({ confidence: 60 }),
      },
    ];

    const topCard = selectTopLevelCard(cardsForGame);

    expect(topCard).toBeDefined();
    expect(topCard.card_id).toBe('card-nba-only');
  });

  test('filters out invalid cards before selection', () => {
    const cardsForGame = [
      {
        result_id: 'result-1',
        card_id: 'card-invalid-no-market',
        game_id: 'game-789',
        market_key: null, // INVALID
        market_type: 'MONEYLINE',
        locked_price: -110,
        payload_data: JSON.stringify({ confidence: 70 }),
      },
      {
        result_id: 'result-2',
        card_id: 'card-valid',
        game_id: 'game-789',
        market_key: 'game-789|ML|HOME',
        market_type: 'MONEYLINE',
        locked_price: -110,
        payload_data: JSON.stringify({ confidence: 60 }), // VALID, lower confidence but should win
      },
    ];

    const topCard = selectTopLevelCard(cardsForGame);

    expect(topCard).toBeDefined();
    expect(topCard.card_id).toBe('card-valid');
  });

  test('prevents double-settlement scenario (HOME + AWAY on same game)', () => {
    const cardsForGame = [
      {
        result_id: 'result-home',
        card_id: 'card-pick-home',
        game_id: 'game-ncaab-1',
        market_key: 'game-ncaab-1|ML|HOME',
        market_type: 'MONEYLINE',
        locked_price: -150,
        payload_data: JSON.stringify({ 
          confidence: 65,
          home_team: 'BUTLER BULLDOGS',
          away_team: 'CREIGHTON BLUEJAYS'
        }),
      },
      {
        result_id: 'result-away',
        card_id: 'card-pick-away',
        game_id: 'game-ncaab-1',
        market_key: 'game-ncaab-1|ML|AWAY',
        market_type: 'MONEYLINE',
        locked_price: +130,
        payload_data: JSON.stringify({ 
          confidence: 58,
          home_team: 'BUTLER BULLDOGS',
          away_team: 'CREIGHTON BLUEJAYS'
        }),
      },
    ];

    const topCard = selectTopLevelCard(cardsForGame);

    // Should only select HOME pick (higher confidence)
    expect(topCard).toBeDefined();
    expect(topCard.card_id).toBe('card-pick-home');
    expect(topCard.market_key).toContain('|HOME');
    
    // The AWAY pick should NOT be settled (will be archived)
  });

  test('returns null when no valid cards', () => {
    const cardsForGame = [
      {
        result_id: 'result-1',
        card_id: 'card-invalid',
        game_id: 'game-999',
        market_key: null,
        market_type: null,
        locked_price: null,
        payload_data: JSON.stringify({ confidence: 70 }),
      },
    ];

    const topCard = selectTopLevelCard(cardsForGame);

    expect(topCard).toBeNull();
  });
});
