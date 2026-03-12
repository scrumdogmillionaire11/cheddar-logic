const {
  computeNBADriverCards,
  computeNBAMarketDecisions,
} = require('../index');

describe('nba total projection alignment', () => {
  test('nba-total-projection projected_total matches cross-market TOTAL projection', () => {
    const oddsSnapshot = {
      total: 228.5,
      total_price_over: -114,
      total_price_under: -106,
      raw_data: {
        espn_metrics: {
          home: {
            metrics: {
              pace: 101.2,
              avgPoints: 116.4,
              avgPointsAllowed: 109.8,
              restDays: 2,
            },
          },
          away: {
            metrics: {
              pace: 99.3,
              avgPoints: 113.1,
              avgPointsAllowed: 111.6,
              restDays: 1,
            },
          },
        },
      },
    };

    const descriptors = computeNBADriverCards('nba-test-game', oddsSnapshot, {});
    const totalProjectionCard = descriptors.find(
      (descriptor) => descriptor.cardType === 'nba-total-projection',
    );
    expect(totalProjectionCard).toBeDefined();

    const projectedFromDriver =
      totalProjectionCard?.driverInputs?.projected_total;
    expect(typeof projectedFromDriver).toBe('number');

    const marketDecisions = computeNBAMarketDecisions(oddsSnapshot);
    const projectedFromCrossMarket =
      marketDecisions?.TOTAL?.projection?.projected_total;
    expect(typeof projectedFromCrossMarket).toBe('number');

    expect(Math.abs(projectedFromDriver - projectedFromCrossMarket)).toBeLessThanOrEqual(0.1);
  });
});
