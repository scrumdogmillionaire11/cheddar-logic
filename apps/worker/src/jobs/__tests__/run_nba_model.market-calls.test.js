/**
 * Unit tests: generateNBAMarketCallCards edge gate (WI-0550)
 *
 * Verifies that nba-spread-call cards are only emitted when edge > 0.02.
 */

const { generateNBAMarketCallCards } = require('../run_nba_model');

// Minimal valid oddsSnapshot — all fields required for spread card emission
const baseOdds = {
  home_team: 'LAL',
  away_team: 'GSW',
  game_time_utc: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
  spread_home: -4.5,
  spread_away: 4.5,
  spread_price_home: -110,
  spread_price_away: -110,
  h2h_home: -180,
  h2h_away: 155,
  total: 224.5,
  total_price_over: -110,
  total_price_under: -110,
  captured_at: new Date().toISOString(),
};

function makeSpreadDecision(edge, status = 'FIRE') {
  return {
    status,
    edge,
    edge_points: edge != null ? edge * 10 : null,
    best_candidate: { side: 'HOME', line: -4.5 },
    drivers: [],
    reasoning: 'test reasoning',
    score: 0.7,
    net: 0.6,
    conflict: 0.1,
    coverage: 0.8,
    p_fair: 0.58,
    p_implied: 0.52,
    projection: { projected_margin: 5 },
    line_source: 'odds_snapshot',
    price_source: 'odds_snapshot',
  };
}

describe('generateNBAMarketCallCards — spread edge gate', () => {
  test('RED: negative edge (-0.25) with FIRE status emits no spread card', () => {
    const cards = generateNBAMarketCallCards(
      'game-123',
      { SPREAD: makeSpreadDecision(-0.25, 'FIRE') },
      baseOdds,
    );
    const spreadCards = cards.filter((c) => c.cardType === 'nba-spread-call');
    expect(spreadCards).toHaveLength(0);
  });

  test('RED: edge exactly at threshold (0.02) with FIRE status emits no spread card', () => {
    const cards = generateNBAMarketCallCards(
      'game-123',
      { SPREAD: makeSpreadDecision(0.02, 'FIRE') },
      baseOdds,
    );
    const spreadCards = cards.filter((c) => c.cardType === 'nba-spread-call');
    expect(spreadCards).toHaveLength(0);
  });

  test('GREEN: positive edge (0.08) with FIRE status emits a spread card', () => {
    const cards = generateNBAMarketCallCards(
      'game-123',
      { SPREAD: makeSpreadDecision(0.08, 'FIRE') },
      baseOdds,
    );
    const spreadCards = cards.filter((c) => c.cardType === 'nba-spread-call');
    expect(spreadCards).toHaveLength(1);
    expect(spreadCards[0].payloadData.edge_pct).toBe(0.08);
    expect(spreadCards[0].payloadData.kind).toBe('PLAY');
  });

  test('GREEN: null edge with FIRE status emits a spread card (null not filtered)', () => {
    const cards = generateNBAMarketCallCards(
      'game-123',
      { SPREAD: makeSpreadDecision(null, 'FIRE') },
      baseOdds,
    );
    const spreadCards = cards.filter((c) => c.cardType === 'nba-spread-call');
    expect(spreadCards).toHaveLength(1);
  });
});
