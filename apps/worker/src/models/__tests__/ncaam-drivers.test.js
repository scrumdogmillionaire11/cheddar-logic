'use strict';

const { computeNCAAMDriverCards } = require('../index');

describe('computeNCAAMDriverCards', () => {
  test('does not emit rest-advantage when neither team is on a back-to-back', () => {
    const cards = computeNCAAMDriverCards('game-1', {
      spread_home: -3.5,
      raw_data: {
        espn_metrics: {
          home: { metrics: { avgPoints: 78, avgPointsAllowed: 69, restDays: 2 } },
          away: { metrics: { avgPoints: 73, avgPointsAllowed: 70, restDays: 1 } }
        }
      }
    });

    expect(cards.some(card => card.cardType === 'ncaam-rest-advantage')).toBe(false);
  });

  test('emits rest-advantage when away team is on a back-to-back', () => {
    const cards = computeNCAAMDriverCards('game-2', {
      spread_home: -4.0,
      raw_data: {
        espn_metrics: {
          home: { metrics: { avgPoints: 80, avgPointsAllowed: 71, restDays: 2 } },
          away: { metrics: { avgPoints: 74, avgPointsAllowed: 72, restDays: 0 } }
        }
      }
    });

    const restCard = cards.find(card => card.cardType === 'ncaam-rest-advantage');
    expect(restCard).toBeDefined();
    expect(restCard.prediction).toBe('HOME');
  });
});
