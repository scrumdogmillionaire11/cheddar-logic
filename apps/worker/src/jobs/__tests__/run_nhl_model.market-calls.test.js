const {
  generateNHLMarketCallCards,
  applyNhlSettlementMarketContext,
} = require('../run_nhl_model');

function buildBaseOddsSnapshot() {
  return {
    game_time_utc: '2026-03-11T00:00:00.000Z',
    home_team: 'Home Team',
    away_team: 'Away Team',
    h2h_home: -130,
    h2h_away: 115,
    spread_home: -1.5,
    spread_away: 1.5,
    spread_price_home: -110,
    spread_price_away: -110,
    total: 6.5,
    total_price_over: -112,
    total_price_under: -108,
    captured_at: '2026-03-10T18:00:00.000Z',
  };
}

function buildBaseDecisions() {
  return {
    TOTAL: {
      status: 'WATCH',
      best_candidate: { side: 'OVER', line: 6.5 },
      edge: 0.02,
      edge_points: 0.4,
      p_fair: 0.53,
      p_implied: 0.5,
      line_source: 'odds_snapshot',
      price_source: 'odds_snapshot',
      drivers: [],
      score: 0.25,
      net: 0.25,
      conflict: 0.1,
      coverage: 0.75,
      reasoning: 'Totals edge',
      projection: {
        projected_total: 6.9,
      },
    },
    SPREAD: {
      status: 'PASS',
      best_candidate: { side: 'HOME', line: -1.5 },
      drivers: [],
      score: 0.1,
      net: 0.1,
      conflict: 0.1,
      coverage: 0.5,
      reasoning: 'No spread edge',
      projection: {
        projected_margin: 0.8,
      },
    },
    ML: {
      status: 'FIRE',
      best_candidate: { side: 'AWAY', price: 115 },
      edge: 0.034,
      p_fair: 0.499,
      p_implied: 0.465,
      line_source: 'odds_snapshot',
      price_source: 'odds_snapshot',
      drivers: [
        {
          driverKey: 'powerRating',
          weight: 0.5,
          signal: 0.35,
          eligible: true,
        },
      ],
      score: 0.52,
      net: 0.61,
      conflict: 0.07,
      coverage: 0.79,
      reasoning: 'Away side carries the strongest edge.',
      projection: {
        projected_margin: -0.9,
        win_prob_home: 0.501,
      },
    },
  };
}

describe('run_nhl_model market call generation', () => {
  test('emits nhl-moneyline-call with canonical payload fields', () => {
    const oddsSnapshot = buildBaseOddsSnapshot();
    const marketDecisions = buildBaseDecisions();

    const cards = generateNHLMarketCallCards(
      'nhl-test-game',
      marketDecisions,
      oddsSnapshot,
    );
    const mlCard = cards.find((card) => card.cardType === 'nhl-moneyline-call');

    expect(mlCard).toBeDefined();
    expect(mlCard.payloadData.kind).toBe('PLAY');
    expect(mlCard.payloadData.market_type).toBe('MONEYLINE');
    expect(mlCard.payloadData.selection).toEqual({
      side: 'AWAY',
      team: 'Away Team',
    });
    expect(mlCard.payloadData.price).toBe(115);
    expect(mlCard.payloadData.reason_codes).toEqual(expect.any(Array));
    expect(mlCard.payloadData.pricing_trace).toMatchObject({
      called_market_type: 'ML',
      called_side: 'AWAY',
      called_price: 115,
      price_source: 'odds_snapshot',
    });
    expect(mlCard.payloadData.market_context).toMatchObject({
      market_type: 'MONEYLINE',
      selection_side: 'AWAY',
      selection_team: 'Away Team',
      wager: {
        called_line: null,
        called_price: 115,
        line_source: null,
        price_source: 'odds_snapshot',
      },
    });
  });

  test('does not emit nhl-moneyline-call when candidate price is unavailable', () => {
    const oddsSnapshot = {
      ...buildBaseOddsSnapshot(),
      h2h_away: null,
    };
    const marketDecisions = buildBaseDecisions();

    const cards = generateNHLMarketCallCards(
      'nhl-test-game',
      marketDecisions,
      oddsSnapshot,
    );
    const mlCard = cards.find((card) => card.cardType === 'nhl-moneyline-call');

    expect(mlCard).toBeUndefined();
  });

  test('emits 1P period odds context fields for nhl-pace-1p cards', () => {
    const oddsSnapshot = {
      ...buildBaseOddsSnapshot(),
      total_1p: 1.5,
      total_price_over_1p: -124,
      total_price_under_1p: 102,
    };

    const card = {
      cardType: 'nhl-pace-1p',
      payloadData: {
        status: 'FIRE',
        classification: 'OVER',
        odds_context: {
          total: 6.5,
          total_price_over: -112,
          total_price_under: -108,
        },
        driver: {
          inputs: {
            market_1p_total: 1.5,
          },
        },
      },
    };

    applyNhlSettlementMarketContext(card, oddsSnapshot);

    expect(card.payloadData.kind).toBe('PLAY');
    expect(card.payloadData.selection).toEqual({ side: 'OVER' });
    expect(card.payloadData.period).toBe('1P');
    expect(card.payloadData.market_context).toMatchObject({
      market_type: 'FIRST_PERIOD',
      period: '1P',
      wager: {
        period: '1P',
      },
    });
    expect(card.payloadData.odds_context).toMatchObject({
      total_1p: 1.5,
      total_price_over_1p: -124,
      total_price_under_1p: 102,
    });
    expect(card.payloadData.price).toBe(-124);
    expect(card.payloadData.price_source).toBe('odds_snapshot');
    expect(card.payloadData.pricing_trace).toMatchObject({
      called_market_type: 'FIRST_PERIOD',
      called_side: 'OVER',
      called_line: 1.5,
      called_price: -124,
      period: '1P',
    });
    expect(card.payloadData.market_context?.wager?.called_price).toBe(-124);
  });

  test('forces nhl-pace-1p to EVIDENCE when 1P side price is unavailable', () => {
    const oddsSnapshot = {
      ...buildBaseOddsSnapshot(),
      total_1p: 1.5,
      total_price_over_1p: null,
      total_price_under_1p: null,
    };

    const card = {
      cardType: 'nhl-pace-1p',
      payloadData: {
        status: 'WATCH',
        classification: 'OVER',
        odds_context: {
          total: 6.5,
          total_price_over: -112,
          total_price_under: -108,
        },
        driver: {
          inputs: {
            market_1p_total: 1.5,
          },
        },
      },
    };

    applyNhlSettlementMarketContext(card, oddsSnapshot);

    expect(card.payloadData.market_type).toBe('FIRST_PERIOD');
    expect(card.payloadData.period).toBe('1P');
    expect(card.payloadData.selection).toEqual({ side: 'OVER' });
    expect(card.payloadData.price).toBeNull();
    expect(card.payloadData.kind).toBe('EVIDENCE');
  });
});
