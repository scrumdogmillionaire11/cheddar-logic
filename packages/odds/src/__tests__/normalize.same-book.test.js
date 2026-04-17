'use strict';

const { normalizeGame } = require('../normalize');

describe('normalize same-book execution fields (WI-0813)', () => {
  test('threads same-book price pairs into normalized odds payload', () => {
    const rawGame = {
      gameId: 'mlb-2026-04-16-test-game',
      home_team: 'Houston Astros',
      away_team: 'Colorado Rockies',
      commence_time: '2026-04-16T23:10:00.000Z',
      markets: {
        totals: [
          { book: 'BookA', line: 8.5, over: -102, under: -120 },
          { book: 'BookB', line: 8.5, over: -130, under: -108 },
        ],
        spreads: [
          {
            book: 'BookA',
            home_line: -1.5,
            away_line: 1.5,
            home_price: -104,
            away_price: -122,
          },
          {
            book: 'BookB',
            home_line: -1.5,
            away_line: 1.5,
            home_price: -126,
            away_price: -106,
          },
        ],
        h2h: [
          { book: 'BookA', home: -118, away: 102 },
          { book: 'BookB', home: -134, away: -101 },
        ],
      },
    };

    const normalized = normalizeGame(rawGame, 'MLB');

    expect(normalized).toBeTruthy();
    expect(normalized.odds.totalSameBookUnderForOver).toBe(-120);
    expect(normalized.odds.totalSameBookOverForUnder).toBe(-130);
    expect(normalized.odds.spreadSameBookAwayForHome).toBe(-122);
    expect(normalized.odds.spreadSameBookHomeForAway).toBe(-126);
    expect(normalized.odds.h2hSameBookAwayForHome).toBe(102);
    expect(normalized.odds.h2hSameBookHomeForAway).toBe(-118);
  });
});
