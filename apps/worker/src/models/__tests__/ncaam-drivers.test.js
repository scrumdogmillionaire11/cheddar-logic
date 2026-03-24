'use strict';

const { computeNCAAMDriverCards } = require('../index');

describe('computeNCAAMDriverCards', () => {
  test('does not emit rest-advantage when neither team is on a back-to-back', () => {
    const cards = computeNCAAMDriverCards('game-1', {
      spread_home: -3.5,
      raw_data: {
        espn_metrics: {
          home: {
            metrics: { avgPoints: 78, avgPointsAllowed: 69, restDays: 2 },
          },
          away: {
            metrics: { avgPoints: 73, avgPointsAllowed: 70, restDays: 1 },
          },
        },
      },
    });

    expect(cards.some((card) => card.cardType === 'ncaam-rest-advantage')).toBe(
      false,
    );
  });

  test('emits rest-advantage when away team is on a back-to-back', () => {
    const cards = computeNCAAMDriverCards('game-2', {
      spread_home: -4.0,
      raw_data: {
        espn_metrics: {
          home: {
            metrics: { avgPoints: 80, avgPointsAllowed: 71, restDays: 2 },
          },
          away: {
            metrics: { avgPoints: 74, avgPointsAllowed: 72, restDays: 0 },
          },
        },
      },
    });

    const restCard = cards.find(
      (card) => card.cardType === 'ncaam-rest-advantage',
    );
    expect(restCard).toBeDefined();
    expect(restCard.prediction).toBe('HOME');
  });

  test('emits ncaam-ft-trend when FT thresholds match and total is under 160', () => {
    const cards = computeNCAAMDriverCards('game-ft-1', {
      total: 158.5,
      spread_home: -2.5,
      raw_data: {
        espn_metrics: {
          home: {
            metrics: {
              avgPoints: 79,
              avgPointsAllowed: 70,
              restDays: 2,
              freeThrowPct: 77.2,
            },
          },
          away: {
            metrics: {
              avgPoints: 73,
              avgPointsAllowed: 71,
              restDays: 1,
              freeThrowPct: 71.4,
            },
          },
        },
      },
    });

    const ftCard = cards.find((card) => card.cardType === 'ncaam-ft-trend');
    expect(ftCard).toBeDefined();
    expect(ftCard.prediction).toBe('HOME');
    expect(ftCard.confidence).toBe(0.62);
    expect(ftCard.marketTypes).toEqual(['spread']);
    expect(ftCard.driverKey).toBe('freeThrowTrend');
    expect(ftCard.driverInputs.total_line).toBe(158.5);
    expect(ftCard.driverInputs.home_ft_pct).toBe(77.2);
    expect(ftCard.driverInputs.away_ft_pct).toBe(71.4);
  });

  test('does not emit ncaam-ft-trend when total is 160 or higher', () => {
    const cards = computeNCAAMDriverCards('game-ft-2', {
      total: 160.0,
      spread_home: 1.5,
      raw_data: {
        espn_metrics: {
          home: {
            metrics: {
              avgPoints: 76,
              avgPointsAllowed: 69,
              freeThrowPct: 76.0,
            },
          },
          away: {
            metrics: {
              avgPoints: 74,
              avgPointsAllowed: 71,
              freeThrowPct: 72.0,
            },
          },
        },
      },
    });

    expect(cards.some((card) => card.cardType === 'ncaam-ft-trend')).toBe(
      false,
    );
  });

  test('does not emit ncaam-ft-trend when both teams are on same side of threshold', () => {
    const cards = computeNCAAMDriverCards('game-ft-3', {
      total: 149.5,
      spread_home: -3.0,
      raw_data: {
        espn_metrics: {
          home: {
            metrics: {
              avgPoints: 80,
              avgPointsAllowed: 72,
              freeThrowPct: 76.2,
            },
          },
          away: {
            metrics: {
              avgPoints: 77,
              avgPointsAllowed: 70,
              freeThrowPct: 75.8,
            },
          },
        },
      },
    });

    expect(cards.some((card) => card.cardType === 'ncaam-ft-trend')).toBe(
      false,
    );
  });

  test('emits ncaam-ft-trend with AWAY prediction when away FT% clears threshold and home does not', () => {
    const cards = computeNCAAMDriverCards('game-ft-away-1', {
      total: 146.5,
      spread_home: 5.5,
      raw_data: {
        espn_metrics: {
          home: {
            metrics: {
              avgPoints: 70,
              avgPointsAllowed: 68,
              freeThrowPct: 72.1,
            },
          },
          away: {
            metrics: {
              avgPoints: 74,
              avgPointsAllowed: 70,
              freeThrowPct: 75.1,
            },
          },
        },
      },
    });

    const ftCard = cards.find((card) => card.cardType === 'ncaam-ft-trend');
    expect(ftCard).toBeDefined();
    expect(ftCard.prediction).toBe('AWAY');
    expect(ftCard.driverInputs.home_ft_pct).toBe(72.1);
    expect(ftCard.driverInputs.away_ft_pct).toBe(75.1);
    expect(ftCard.driverInputs.ft_gap).toBe(-3);
  });

  test('never emits ncaam-matchup-style even with large efficiency gap', () => {
    // home avgPoints=90, avgPointsAllowed=65, away avgPoints=70, avgPointsAllowed=80
    // homeEfficiency = 90 - 65 = 25; awayEfficiency = 70 - 80 = -10; efficiencyGap = 35 (well above >=5 threshold)
    const cards = computeNCAAMDriverCards('game-matchup-style-1', {
      spread_home: -8.0,
      raw_data: {
        espn_metrics: {
          home: {
            metrics: {
              avgPoints: 90,
              avgPointsAllowed: 65,
              restDays: 2,
            },
          },
          away: {
            metrics: {
              avgPoints: 70,
              avgPointsAllowed: 80,
              restDays: 2,
            },
          },
        },
      },
    });

    expect(cards.some((c) => c.cardType === 'ncaam-matchup-style')).toBe(false);
  });

  test('still emits ncaam-base-projection when team metrics are present', () => {
    // Same large-efficiency-gap snapshot — base-projection should still fire
    const cards = computeNCAAMDriverCards('game-matchup-style-2', {
      spread_home: -8.0,
      raw_data: {
        espn_metrics: {
          home: {
            metrics: {
              avgPoints: 90,
              avgPointsAllowed: 65,
              restDays: 2,
            },
          },
          away: {
            metrics: {
              avgPoints: 70,
              avgPointsAllowed: 80,
              restDays: 2,
            },
          },
        },
      },
    });

    expect(cards.some((c) => c.cardType === 'ncaam-base-projection')).toBe(true);
  });
});
