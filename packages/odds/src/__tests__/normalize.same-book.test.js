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

  test('uses same-book line over independently-best line when books differ', () => {
    const rawGame = {
      gameId: 'mlb-2026-04-23-test-same-book-line',
      home_team: 'Team Home',
      away_team: 'Team Away',
      commence_time: '2026-04-23T23:10:00.000Z',
      markets: {
        totals: [
          { book: 'BookA', line: 8.0, over: -102, under: -120 },
          { book: 'BookB', line: 9.0, over: -130, under: -108 },
        ],
        spreads: [
          { book: 'BookA', home_line: -1.5, away_line: 1.5, home_price: -104, away_price: -122 },
          { book: 'BookB', home_line: -2.5, away_line: 2.5, home_price: -126, away_price: -106 },
        ],
        h2h: [
          { book: 'BookA', home: -118, away: 102 },
        ],
      },
    };

    const normalized = normalizeGame(rawGame, 'MLB');

    expect(normalized).toBeTruthy();

    // spreadHome: BookA has best home price (-104), use BookA's home_line (-1.5), not BookB's -2.5
    expect(normalized.odds.spreadHome).toBe(-1.5);
    expect(normalized.odds.spreadHomeBook).toBe('BookA');
    expect(normalized.odds.spreadPriceHome).toBe(-104);
    expect(normalized.odds.spreadPriceHomeBook).toBe('BookA');

    // spreadAway: BookB has best away price (-106), use BookB's away_line (2.5), not BookA's 1.5
    expect(normalized.odds.spreadAway).toBe(2.5);
    expect(normalized.odds.spreadAwayBook).toBe('BookB');
    expect(normalized.odds.spreadPriceAway).toBe(-106);
    expect(normalized.odds.spreadPriceAwayBook).toBe('BookB');

    // totalLineOver: BookA has best over price (-102), use BookA's line (8.0), not BookB's 9.0
    expect(normalized.odds.totalLineOver).toBe(8.0);
    expect(normalized.odds.totalLineOverBook).toBe('BookA');
    expect(normalized.odds.totalPriceOver).toBe(-102);
    expect(normalized.odds.totalPriceOverBook).toBe('BookA');

    // totalLineUnder: BookB has best under price (-108), use BookB's line (9.0), not BookA's 8.0
    expect(normalized.odds.totalLineUnder).toBe(9.0);
    expect(normalized.odds.totalLineUnderBook).toBe('BookB');
    expect(normalized.odds.totalPriceUnder).toBe(-108);
    expect(normalized.odds.totalPriceUnderBook).toBe('BookB');
  });
});
