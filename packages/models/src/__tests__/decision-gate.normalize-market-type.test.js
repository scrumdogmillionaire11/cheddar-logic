const { normalizeMarketType } = require('../decision-gate');

describe('decision-gate normalizeMarketType', () => {
  test.each([
    [{ marketType: 'ML', recommendedBetType: null }, 'moneyline'],
    [{ marketType: 'h2h', recommendedBetType: null }, 'moneyline'],
    [{ marketType: 'OU', recommendedBetType: null }, 'total'],
    [{ marketType: 'spread', recommendedBetType: null }, 'spread'],
    [{ marketType: 'puck_line', recommendedBetType: null }, 'puckline'],
    [{ marketType: 'TEAM TOTAL', recommendedBetType: null }, 'team_total'],
    [{ marketType: 'first_period_total', recommendedBetType: null }, 'first_period'],
    [{ marketType: null, recommendedBetType: 'TOTAL_OVER' }, 'total'],
    [{ marketType: 'player_prop_points', recommendedBetType: null }, 'prop'],
    [{ marketType: 'custom_market', recommendedBetType: null }, 'unknown'],
  ])('normalizes %p -> %s', ({ marketType, recommendedBetType }, expected) => {
    expect(normalizeMarketType(marketType, recommendedBetType)).toBe(expected);
  });
});
