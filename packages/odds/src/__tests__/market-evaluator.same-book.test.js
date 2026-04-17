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
