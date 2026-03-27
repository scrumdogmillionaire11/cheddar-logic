const {
  buildConsensus,
  median,
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

  test('normalizeGame emits consensus fields alongside existing best-line fields', () => {
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
      spreadConsensusLine: -3,
      spreadConsensusConfidence: 'medium',
      spreadSourceBookCount: 3,
      totalConsensusLine: 220.5,
      totalConsensusConfidence: 'medium',
      totalSourceBookCount: 3,
      h2hConsensusHome: -135,
      h2hConsensusAway: 120,
      h2hConsensusConfidence: 'medium',
    });
  });
});
