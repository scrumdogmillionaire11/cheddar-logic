const {
  computeNBADriverCards,
  computeNBAMarketDecisions,
} = require('../index');
const { assessProjectionInputs } = require('../projections');

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

  test('ncaam projection gate accepts raw home/away fallback metrics', () => {
    const gate = assessProjectionInputs('NCAAM', {
      raw_data: {
        home: {
          avg_points: 77.2,
          avg_points_allowed: 69.1,
        },
        away: {
          avg_points: 73.8,
          avg_points_allowed: 68.4,
        },
      },
    });

    expect(gate.projection_inputs_complete).toBe(true);
    expect(gate.missing_inputs).toEqual([]);
  });
});

describe('nba spread line perspective (away team uses spread_away, not -spread_home)', () => {
  function buildSnapshot(spreadHome, spreadAway) {
    return {
      total: 224.5,
      spread_home: spreadHome,
      spread_away: spreadAway,
      spread_price_home: -110,
      spread_price_away: -110,
      raw_data: {
        espn_metrics: {
          home: {
            metrics: {
              avgPtsHome: 112,
              avgPointsAllowed: 114,
              paceHome: 100,
              restDays: 1,
            },
          },
          away: {
            metrics: {
              avgPtsAway: 118,
              avgPointsAllowed: 110,
              paceAway: 102,
              restDays: 2,
            },
          },
        },
      },
    };
  }

  test('AWAY spread line uses spread_away directly, not -spread_home', () => {
    // Scenario: Hawks (away) are -4.5 favorites. Outlier book inflates Miami to +6.5.
    // spread_home = +6.5 (best home execution, outlier), spread_away = -4.5 (actual Hawks line)
    const snapshot = buildSnapshot(6.5, -4.5);
    const result = computeNBAMarketDecisions(snapshot);
    expect(result.SPREAD).toBeDefined();

    const awayCandidate = result.SPREAD.best_candidate;
    if (awayCandidate.side === 'AWAY') {
      // Line should be -4.5 (spread_away), NOT -6.5 (-spread_home)
      expect(awayCandidate.line).toBeCloseTo(-4.5, 1);
      expect(awayCandidate.line).not.toBeCloseTo(-6.5, 1);
    } else {
      // HOME side: line should be +6.5 (spread_home)
      expect(awayCandidate.line).toBeCloseTo(6.5, 1);
    }
  });

  test('when spread_away is null, falls back to -spread_home', () => {
    const snapshot = buildSnapshot(-5.5, null);
    const result = computeNBAMarketDecisions(snapshot);
    expect(result.SPREAD).toBeDefined();

    const candidate = result.SPREAD.best_candidate;
    if (candidate.side === 'AWAY') {
      expect(candidate.line).toBeCloseTo(5.5, 1);
    } else {
      expect(candidate.line).toBeCloseTo(-5.5, 1);
    }
  });
});
