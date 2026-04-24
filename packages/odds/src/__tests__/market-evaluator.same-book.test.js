'use strict';

const { selectBestExecution } = require('../market_evaluator');

describe('market_evaluator same-book execution pairing (WI-0813)', () => {
  test('totals execution exposes same-book counterparts for devig', () => {
    const entries = [
      { book: 'BookA', line: 8.5, over: -102, under: -120 },
      { book: 'BookB', line: 8.5, over: -130, under: -108 },
    ];

    const execution = selectBestExecution(entries, 'total');

    expect(execution.best_price_over).toBe(-102);
    expect(execution.best_price_over_book).toBe('BookA');
    expect(execution.same_book_under_for_over).toBe(-120);

    expect(execution.best_price_under).toBe(-108);
    expect(execution.best_price_under_book).toBe('BookB');
    expect(execution.same_book_over_for_under).toBe(-130);
  });

  test('spread execution exposes same-book counterparts for devig', () => {
    const entries = [
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
    ];

    const execution = selectBestExecution(entries, 'spread');

    expect(execution.best_price_home).toBe(-104);
    expect(execution.best_price_home_book).toBe('BookA');
    expect(execution.same_book_away_for_home).toBe(-122);

    expect(execution.best_price_away).toBe(-106);
    expect(execution.best_price_away_book).toBe('BookB');
    expect(execution.same_book_home_for_away).toBe(-126);
  });

  test('spread execution exposes same-book line for the best price book', () => {
    const entries = [
      { book: 'BookA', home_line: -1.5, away_line: 1.5, home_price: -104, away_price: -122 },
      { book: 'BookB', home_line: -2.5, away_line: 2.5, home_price: -126, away_price: -106 },
    ];

    const execution = selectBestExecution(entries, 'spread');

    // Best home price is BookA (-104), so same-book line home is BookA's home_line (-1.5)
    expect(execution.same_book_line_home).toBe(-1.5);
    // Best away price is BookB (-106), so same-book line away is BookB's away_line (2.5)
    expect(execution.same_book_line_away).toBe(2.5);
  });

  test('total execution exposes same-book line for the best price book', () => {
    const entries = [
      { book: 'BookA', line: 8.0, over: -102, under: -120 },
      { book: 'BookB', line: 8.5, over: -130, under: -108 },
    ];

    const execution = selectBestExecution(entries, 'total');

    // Best over price is BookA (-102), so same-book line for over is BookA's line (8.0)
    expect(execution.same_book_line_for_over).toBe(8.0);
    // Best under price is BookB (-108), so same-book line for under is BookB's line (8.5)
    expect(execution.same_book_line_for_under).toBe(8.5);
  });

  test('missing opposite side on same book resolves counterpart to null', () => {
    const entries = [
      { book: 'BookA', line: 8.5, over: -102, under: null },
      { book: 'BookB', line: 8.5, over: -130, under: -108 },
    ];

    const execution = selectBestExecution(entries, 'total');

    expect(execution.best_price_over).toBe(-102);
    expect(execution.best_price_over_book).toBe('BookA');
    expect(execution.same_book_under_for_over).toBeNull();
  });
});
