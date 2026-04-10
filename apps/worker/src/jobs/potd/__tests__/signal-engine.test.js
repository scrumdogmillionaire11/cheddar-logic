'use strict';

const {
  buildCandidates,
  kellySize,
  scoreCandidate,
  selectBestPlay,
} = require('../signal-engine');

function buildGame(overrides = {}) {
  return {
    gameId: 'game-potd-001',
    sport: 'NHL',
    homeTeam: 'Boston Bruins',
    awayTeam: 'Toronto Maple Leafs',
    gameTimeUtc: '2026-04-10T00:00:00.000Z',
    capturedAtUtc: '2026-04-09T18:00:00.000Z',
    market: {
      spreads: [
        { book: 'book-a', home_line: -1.5, away_line: 1.5, home_price: 115, away_price: -135 },
        { book: 'book-b', home_line: -1.0, away_line: 1.0, home_price: -105, away_price: -115 },
        { book: 'book-c', home_line: -1.0, away_line: 1.0, home_price: -102, away_price: -118 },
      ],
      totals: [
        { book: 'book-a', line: 6.5, over: -110, under: -110 },
        { book: 'book-b', line: 6.0, over: 105, under: -125 },
        { book: 'book-c', line: 6.5, over: -102, under: -118 },
      ],
      h2h: [
        { book: 'book-a', home: -140, away: 120 },
        { book: 'book-b', home: -132, away: 118 },
        { book: 'book-c', home: -128, away: 125 },
      ],
    },
    ...overrides,
  };
}

function buildEliteGame() {
  return buildGame({
    sport: 'NBA',
    market: {
      totals: [
        { book: 'book-a', line: 220.5, over: -108, under: -112 },
        { book: 'book-b', line: 220.5, over: -109, under: -111 },
        { book: 'book-c', line: 220.5, over: -107, under: -113 },
        { book: 'book-d', line: 220.5, over: -110, under: -110 },
        { book: 'book-e', line: 219, over: 125, under: -140 },
      ],
    },
  });
}

function buildHighEdgeGame() {
  return buildGame({
    market: {
      totals: [
        { book: 'book-a', line: 5.5, over: -102, under: -118 },
        { book: 'book-b', line: 5.0, over: 115, under: -122 },
        { book: 'book-c', line: 5.5, over: -105, under: -115 },
      ],
    },
  });
}

describe('potd signal engine', () => {
  test('builds spread candidates for both sides', () => {
    const candidates = buildCandidates(buildGame());
    const spreads = candidates.filter((candidate) => candidate.marketType === 'SPREAD');

    expect(spreads).toHaveLength(2);
    expect(spreads.map((candidate) => candidate.selection).sort()).toEqual([
      'AWAY',
      'HOME',
    ]);

    const home = spreads.find((candidate) => candidate.selection === 'HOME');
    expect(home).toMatchObject({
      line: -1,
      price: -102,
      consensusLine: -1,
    });
  });

  test('builds totals candidates for both outcomes', () => {
    const candidates = buildCandidates(buildGame());
    const totals = candidates.filter((candidate) => candidate.marketType === 'TOTAL');

    expect(totals).toHaveLength(2);
    expect(totals.map((candidate) => candidate.selection).sort()).toEqual([
      'OVER',
      'UNDER',
    ]);

    const over = totals.find((candidate) => candidate.selection === 'OVER');
    expect(over).toMatchObject({
      line: 6,
      price: 105,
      consensusLine: 6.5,
    });
  });

  test('builds moneyline candidates for both teams', () => {
    const candidates = buildCandidates(buildGame());
    const moneyline = candidates.filter((candidate) => candidate.marketType === 'MONEYLINE');

    expect(moneyline).toHaveLength(2);
    const away = moneyline.find((candidate) => candidate.selection === 'AWAY');
    expect(away).toMatchObject({
      line: null,
      price: 125,
      consensusPrice: 120,
    });
  });

  test('malformed games return no actionable candidates', () => {
    expect(buildCandidates(null)).toEqual([]);
    expect(buildCandidates({ gameId: 'x', market: {} })).toEqual([]);
  });

  test('positive-edge candidate outranks negative-edge candidate', () => {
    const best = selectBestPlay(
      [
        { selection: 'NEG', totalScore: 0.95, edgePct: -0.01 },
        { selection: 'POS', totalScore: 0.6, edgePct: 0.02 },
      ],
      { minConfidence: 0 },
    );

    expect(best).toMatchObject({
      selection: 'POS',
      edgePct: 0.02,
    });
  });

  test('confidence thresholds distinguish HIGH and ELITE', () => {
    const high = buildCandidates(buildHighEdgeGame())
      .map(scoreCandidate)
      .filter(Boolean)
      .find((candidate) => candidate.confidenceLabel === 'HIGH');
    const elite = buildCandidates(buildEliteGame())
      .map(scoreCandidate)
      .filter(Boolean)
      .find((candidate) => candidate.confidenceLabel === 'ELITE');

    expect(high).toBeDefined();
    expect(elite).toBeDefined();
    expect(selectBestPlay([high], { minConfidence: 'ELITE' })).toBeNull();
    expect(selectBestPlay([high], { minConfidence: 'HIGH' })).toEqual(high);
    expect(selectBestPlay([elite], { minConfidence: 'ELITE' })).toEqual(elite);
  });

  test('kelly sizing floors at zero and caps stake at 20 percent', () => {
    expect(
      kellySize({
        edgePct: -0.01,
        impliedProb: 0.5,
        bankroll: 100,
      }),
    ).toBe(0);

    expect(
      kellySize({
        edgePct: 0.79,
        impliedProb: 0.2,
        bankroll: 100,
      }),
    ).toBe(20);
  });

  test('totals-only NHL game path remains eligible', () => {
    const candidates = buildCandidates(
      buildGame({
        market: {
          totals: [
            { book: 'book-a', line: 5.5, over: -102, under: -118 },
            { book: 'book-b', line: 5.0, over: 115, under: -122 },
            { book: 'book-c', line: 5.5, over: -105, under: -115 },
          ],
        },
      }),
    );

    expect(candidates.map((candidate) => candidate.marketType)).toEqual([
      'TOTAL',
      'TOTAL',
    ]);

    const scored = candidates.map(scoreCandidate).filter(Boolean);
    const best = selectBestPlay(scored, { minConfidence: 'HIGH' });
    expect(best).not.toBeNull();
    expect(best.marketType).toBe('TOTAL');
  });
});
