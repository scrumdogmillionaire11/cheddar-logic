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

  test('fixed-line runline (+-1.5) scores like MONEYLINE not like a floating spread', () => {
    const fixedLineGame = buildGame({
      sport: 'baseball_mlb',
      market: {
        spreads: [
          { book: 'book-a', home_line: -1.5, away_line: 1.5, home_price: -130, away_price: 110 },
          { book: 'book-b', home_line: -1.5, away_line: 1.5, home_price: -128, away_price: 108 },
          { book: 'book-c', home_line: -1.5, away_line: 1.5, home_price: -125, away_price: 105 },
        ],
        totals: [],
        h2h: [],
      },
    });

    const floatingLineGame = buildGame({
      sport: 'basketball_nba',
      market: {
        spreads: [
          { book: 'book-a', home_line: -7.0, away_line: 7.0, home_price: -110, away_price: -110 },
          { book: 'book-b', home_line: -7.5, away_line: 7.5, home_price: -108, away_price: -112 },
          { book: 'book-c', home_line: -7.0, away_line: 7.0, home_price: -112, away_price: -108 },
        ],
        totals: [],
        h2h: [],
      },
    });

    const mlbHome = buildCandidates(fixedLineGame).find(
      (c) => c.marketType === 'SPREAD' && c.selection === 'HOME',
    );
    const nbaHome = buildCandidates(floatingLineGame).find(
      (c) => c.marketType === 'SPREAD' && c.selection === 'HOME',
    );

    const mlbScored = scoreCandidate(mlbHome);
    const nbaScored = scoreCandidate(nbaHome);

    expect(mlbScored).not.toBeNull();
    expect(nbaScored).not.toBeNull();
    // Fixed-line market must not get a free lineScore=1.0 boost
    expect(mlbScored.marketConsensus).toBeLessThan(1.0);
    expect(nbaScored.marketConsensus).toBeLessThan(1.0);
  });

  test('per-sport pool: NBA candidate with highest score wins even when MLB has more candidates', () => {
    const mlbCandidates = [
      { sport: 'baseball_mlb', totalScore: 0.62, edgePct: 0.03 },
      { sport: 'baseball_mlb', totalScore: 0.63, edgePct: 0.02 },
      { sport: 'baseball_mlb', totalScore: 0.64, edgePct: 0.02 },
    ];
    const nbaCandidates = [
      { sport: 'basketball_nba', totalScore: 0.68, edgePct: 0.04 },
    ];

    const best = selectBestPlay([...mlbCandidates, ...nbaCandidates], { minConfidence: 0 });
    expect(best).not.toBeNull();
    expect(best.sport).toBe('basketball_nba');
    expect(best.totalScore).toBe(0.68);
  });

  test('favorable line delta increases lineValue above neutral 0.5', () => {
    // A candidate whose line is better than consensus should score above neutral
    const nhlOver = {
      gameId: 'nhl-test',
      sport: 'NHL',
      home_team: 'A',
      away_team: 'B',
      commence_time: new Date().toISOString(),
      marketType: 'TOTAL',
      selection: 'OVER',
      selectionLabel: 'OVER 5.0',
      line: 5.0,        // better (lower) than consensus for OVER
      price: 105,
      consensusLine: 5.5,
      consensusPrice: -110,
      counterpartConsensusPrice: -110,
      comparableLines: [5.5, 5.5, 5.5],
      comparablePrices: [-110, -108, -112],
      sourceCount: 3,
    };

    const scored = scoreCandidate(nhlOver);
    expect(scored).not.toBeNull();
    // lineValue should exceed 0.5 because we have a favorable line delta
    expect(scored.lineValue).toBeGreaterThan(0.5);
  });
});
