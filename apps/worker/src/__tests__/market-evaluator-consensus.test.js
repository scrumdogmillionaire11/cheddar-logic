const {
  buildConsensus,
  detectMisprice,
  median,
  selectBestExecution,
  stddev,
} = require('../../../../packages/odds/src/market_evaluator.js');
const {
  normalizeGame,
} = require('../../../../packages/odds/src/normalize.js');

describe('market evaluator consensus', () => {
  test('median handles odd and even counts', () => {
    expect(median([1, 4, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  test('stddev computes population dispersion', () => {
    expect(stddev([-3.5, -3.0, -4.0])).toBeCloseTo(0.4082, 4);
    expect(stddev([220.5])).toBe(0);
    expect(stddev([])).toBeNull();
  });

  test('buildConsensus computes spread consensus across five books', () => {
    const consensus = buildConsensus(
      [
        { book: 'a', home_line: -3.5, away_line: 3.5, home_price: -110, away_price: -110 },
        { book: 'b', home_line: -3.0, away_line: 3.0, home_price: -108, away_price: -112 },
        { book: 'c', home_line: -3.0, away_line: 3.0, home_price: -105, away_price: -115 },
        { book: 'd', home_line: -2.5, away_line: 2.5, home_price: -102, away_price: -118 },
        { book: 'e', home_line: -4.0, away_line: 4.0, home_price: -115, away_price: -105 },
      ],
      'spread',
    );

    expect(consensus).toMatchObject({
      consensus_line: -3,
      consensus_price_home: -108,
      consensus_price_away: -112,
      source_book_count: 5,
      consensus_confidence: 'medium',
    });
    expect(consensus.dispersion_stddev).toBeCloseTo(0.5099, 4);
  });

  test('buildConsensus returns high confidence for four tightly clustered spread books', () => {
    const consensus = buildConsensus(
      [
        { book: 'a', home_line: -3.5, away_line: 3.5, home_price: -110, away_price: -110 },
        { book: 'b', home_line: -3.5, away_line: 3.5, home_price: -108, away_price: -112 },
        { book: 'c', home_line: -3.0, away_line: 3.0, home_price: -109, away_price: -111 },
        { book: 'd', home_line: -3.0, away_line: 3.0, home_price: -107, away_price: -113 },
      ],
      'spread',
    );

    expect(consensus).toMatchObject({
      consensus_line: -3.25,
      source_book_count: 4,
      consensus_confidence: 'high',
    });
    expect(consensus.dispersion_stddev).toBe(0.25);
  });

  test('buildConsensus handles even-book totals and ignores unusable rows', () => {
    const consensus = buildConsensus(
      [
        { book: 'a', line: 220.5, over: -110, under: -110 },
        { book: 'b', line: 221.0, over: -108, under: -112 },
        { book: 'c', line: null, over: -105, under: -115 },
        { book: 'd', line: 219.5, over: -102, under: -118 },
        { book: 'e', line: 220.0, over: -109, under: -111 },
      ],
      'total',
    );

    expect(consensus).toMatchObject({
      consensus_line: 220.25,
      consensus_price_over: -108.5,
      consensus_price_under: -111.5,
      source_book_count: 4,
      consensus_confidence: 'medium',
    });
    expect(consensus.dispersion_stddev).toBeCloseTo(0.559, 3);
  });

  test('buildConsensus applies the WI-0568 medium threshold to sparse spread inputs', () => {
    const consensus = buildConsensus(
      [{ book: 'solo', home_line: -1.5, away_line: 1.5, home_price: -110, away_price: -110 }],
      'spread',
    );

    expect(consensus).toMatchObject({
      consensus_line: -1.5,
      source_book_count: 1,
      dispersion_stddev: 0,
      consensus_confidence: 'medium',
    });
  });

  test('buildConsensus derives h2h confidence from price dispersion', () => {
    const highConfidence = buildConsensus(
      [
        { book: 'a', home: -135, away: 120 },
        { book: 'b', home: -130, away: 118 },
        { book: 'c', home: -132, away: 121 },
        { book: 'd', home: -134, away: 119 },
      ],
      'h2h',
    );

    const lowConfidence = buildConsensus(
      [{ book: 'solo', home: -150, away: 135 }],
      'h2h',
    );

    expect(highConfidence).toMatchObject({
      consensus_price_home: -133,
      consensus_price_away: 119.5,
      source_book_count: 4,
      consensus_confidence: 'high',
    });
    expect(lowConfidence.consensus_confidence).toBe('medium');
  });

  test('selectBestExecution separates spread line-book from price-book', () => {
    const execution = selectBestExecution(
      [
        { book: 'draftkings', home_line: -2.5, away_line: 2.5, home_price: -118, away_price: +102 },
        { book: 'fanduel', home_line: -3.0, away_line: 3.0, home_price: -105, away_price: -110 },
        { book: 'betmgm', home_line: -3.5, away_line: 3.5, home_price: +100, away_price: -120 },
      ],
      'spread',
    );

    expect(execution).toEqual({
      best_line_home: -2.5,
      best_line_home_book: 'draftkings',
      best_line_away: 3.5,
      best_line_away_book: 'betmgm',
      best_price_home: 100,
      best_price_home_book: 'betmgm',
      best_price_away: 102,
      best_price_away_book: 'draftkings',
      same_book_away_for_home: -120,
      same_book_home_for_away: -118,
    });
  });

  test('selectBestExecution handles total side-specific lines and books', () => {
    const execution = selectBestExecution(
      [
        { book: 'draftkings', line: 220.5, over: -115, under: +100 },
        { book: 'fanduel', line: 219.5, over: -110, under: -105 },
        { book: 'betmgm', line: 221.0, over: +102, under: -120 },
      ],
      'total',
    );

    expect(execution).toEqual({
      best_line_over: 219.5,
      best_line_over_book: 'fanduel',
      best_line_under: 221,
      best_line_under_book: 'betmgm',
      best_price_over: 102,
      best_price_over_book: 'betmgm',
      best_price_under: 100,
      best_price_under_book: 'draftkings',
      same_book_under_for_over: -120,
      same_book_over_for_under: -115,
    });
  });

  test('selectBestExecution handles h2h price books and sparse rows', () => {
    const execution = selectBestExecution(
      [
        { book: 'draftkings', home: -140, away: 120 },
        { book: 'fanduel', home: -132, away: null },
        { book: 'betmgm', home: null, away: 125 },
      ],
      'h2h',
    );

    expect(execution).toEqual({
      best_price_home: -132,
      best_price_home_book: 'fanduel',
      best_price_away: 125,
      best_price_away_book: 'betmgm',
      same_book_away_for_home: null,
      same_book_home_for_away: null,
    });
  });

  test('detectMisprice flags soft spread lines against consensus', () => {
    const misprice = detectMisprice(
      {
        consensus_line: -3,
        dispersion_stddev: 0.4,
      },
      {
        best_line_home: -1,
        best_line_home_book: 'draftkings',
        best_line_away: 3,
        best_line_away_book: 'fanduel',
      },
      [
        { book: 'draftkings', home_line: -1, away_line: 1, home_price: -110, away_price: -110 },
        { book: 'fanduel', home_line: -3, away_line: 3, home_price: -110, away_price: -110 },
      ],
      'spread',
    );

    expect(misprice).toEqual({
      is_mispriced: true,
      misprice_type: 'SOFT_LINE',
      misprice_strength: 2,
      outlier_book: 'draftkings',
      outlier_delta_vs_consensus: 2,
      stale_or_soft_flag: true,
      review_flag: false,
    });
  });

  test('detectMisprice flags price-only totals misprices in decimal-odds bps', () => {
    const misprice = detectMisprice(
      {
        consensus_line: 220.5,
        dispersion_stddev: 0,
      },
      {
        best_line_over: 220.5,
        best_line_over_book: 'draftkings',
        best_line_under: 220.5,
        best_line_under_book: 'draftkings',
      },
      [
        { book: 'draftkings', line: 220.5, over: +102, under: -120 },
        { book: 'fanduel', line: 220.5, over: -110, under: -110 },
        { book: 'betmgm', line: 220.5, over: -110, under: -112 },
      ],
      'total',
    );

    expect(misprice.is_mispriced).toBe(true);
    expect(misprice.misprice_type).toBe('PRICE_ONLY');
    expect(misprice.outlier_book).toBe('draftkings');
    expect(misprice.misprice_strength).toBeGreaterThan(800);
    expect(misprice.review_flag).toBe(false);
  });

  test('detectMisprice sets review flag for high dispersion without a soft-line winner', () => {
    const misprice = detectMisprice(
      {
        consensus_line: -3,
        dispersion_stddev: 1.8,
      },
      {
        best_line_home: -2,
        best_line_home_book: 'draftkings',
        best_line_away: 3,
        best_line_away_book: 'fanduel',
      },
      [
        { book: 'draftkings', home_line: -2, away_line: 2, home_price: -110, away_price: -110 },
        { book: 'fanduel', home_line: -3, away_line: 3, home_price: -110, away_price: -110 },
        { book: 'betmgm', home_line: -5, away_line: 5, home_price: -110, away_price: -110 },
      ],
      'spread',
    );

    expect(misprice).toEqual({
      is_mispriced: true,
      misprice_type: 'HIGH_DISPERSION',
      misprice_strength: 1.8,
      outlier_book: null,
      outlier_delta_vs_consensus: null,
      stale_or_soft_flag: false,
      review_flag: true,
    });
  });

  test('normalizeGame emits consensus fields alongside execution fields', () => {
    const normalized = normalizeGame(
      {
        id: 'game-1',
        home_team: 'Boston Celtics',
        away_team: 'Miami Heat',
        commence_time: '2026-03-27T23:00:00.000Z',
        markets: {
          h2h: [
            { book: 'a', home: -140, away: 122 },
            { book: 'b', home: -135, away: 118 },
            { book: 'c', home: -132, away: 120 },
          ],
          totals: [
            { book: 'a', line: 220.5, over: -110, under: -110 },
            { book: 'b', line: 221.5, over: -108, under: -112 },
            { book: 'c', line: 220.0, over: -105, under: -115 },
          ],
          spreads: [
            { book: 'a', home_line: -3.5, away_line: 3.5, home_price: -110, away_price: -110 },
            { book: 'b', home_line: -3.0, away_line: 3.0, home_price: -108, away_price: -112 },
            { book: 'c', home_line: -2.5, away_line: 2.5, home_price: -105, away_price: -115 },
          ],
        },
      },
      'nba',
    );

    expect(normalized.odds).toMatchObject({
      spreadHome: -2.5,
      spreadAway: 3.5,
      spreadHomeBook: 'c',
      spreadAwayBook: 'a',
      spreadPriceHome: -105,
      spreadPriceHomeBook: 'c',
      spreadPriceAway: -110,
      spreadPriceAwayBook: 'a',
      spreadConsensusLine: -3,
      spreadConsensusConfidence: 'medium',
      spreadSourceBookCount: 3,
      total: 220.5,
      totalLineOver: 220,
      totalLineOverBook: 'c',
      totalLineUnder: 221.5,
      totalLineUnderBook: 'b',
      totalPriceOver: -105,
      totalPriceOverBook: 'c',
      totalPriceUnder: -110,
      totalPriceUnderBook: 'a',
      totalConsensusLine: 220.5,
      totalConsensusConfidence: 'medium',
      totalSourceBookCount: 3,
      totalIsMispriced: false,
      totalMispriceType: null,
      totalReviewFlag: false,
      h2hHome: -132,
      h2hHomeBook: 'c',
      h2hAway: 122,
      h2hAwayBook: 'a',
      spreadIsMispriced: false,
      spreadMispriceType: null,
      spreadReviewFlag: false,
      h2hConsensusHome: -135,
      h2hConsensusAway: 120,
      h2hConsensusConfidence: 'medium',
    });
  });
});
