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
  // NHL total with a significant line outlier at book-e (+value price too).
  // Under the AC2 consensus-magnitude normalization, a 1.5-point delta on a
  // ~5.5 consensus line (lineDelta/consensusLine ≈ 0.27) still produces a
  // high lineValue when combined with a much better price at that book.
  // Expected: best OVER candidate scores ELITE (totalScore >= 0.75).
  return buildGame({
    sport: 'NHL',
    market: {
      totals: [
        { book: 'book-a', line: 5.5, over: -115, under: 110 },
        { book: 'book-b', line: 5.5, over: -115, under: 110 },
        { book: 'book-c', line: 5.5, over: -115, under: 110 },
        { book: 'book-d', line: 5.5, over: -115, under: 110 },
        { book: 'book-e', line: 3.5, over: 100, under: -115 },
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

  test('MLB model signal overrides consensus fair prob in scoreCandidate', () => {
    const candidate = {
      gameId: 'mlb-game-001',
      sport: 'baseball_mlb',
      home_team: 'Cubs',
      away_team: 'Cardinals',
      commence_time: new Date().toISOString(),
      marketType: 'MONEYLINE',
      selection: 'HOME',
      selectionLabel: 'Cubs',
      line: null,
      price: -130,
      consensusLine: null,
      consensusPrice: -132,
      counterpartConsensusPrice: 112,
      comparableLines: [],
      comparablePrices: [-132, -130, -128],
      sourceCount: 3,
      mlbSignal: { modelWinProb: 0.58, edge: 0.06, projection_source: 'FULL_MODEL' },
    };

    const result = scoreCandidate(candidate);
    expect(result).not.toBeNull();
    expect(result.modelWinProb).toBe(0.58);
    expect(result.edgePct).toBe(0.06);
    expect(result.scoreBreakdown.model_win_prob).toBe(0.58);
    expect(result.scoreBreakdown.projection_source).toBe('FULL_MODEL');
  });

  test('MLB candidate without mlbSignal falls back to consensus path', () => {
    const candidate = {
      gameId: 'mlb-game-002',
      sport: 'baseball_mlb',
      home_team: 'Cubs',
      away_team: 'Cardinals',
      commence_time: new Date().toISOString(),
      marketType: 'MONEYLINE',
      selection: 'HOME',
      selectionLabel: 'Cubs',
      line: null,
      price: -130,
      consensusLine: null,
      consensusPrice: -132,
      counterpartConsensusPrice: 112,
      comparableLines: [],
      comparablePrices: [-132, -130, -128],
      sourceCount: 3,
      // no mlbSignal property
    };

    const result = scoreCandidate(candidate);
    expect(result).not.toBeNull();
    // edgePct must NOT be the model edge (0.06) — it is the consensus edge
    expect(result.edgePct).not.toBe(0.06);
    // scoreBreakdown must not have model_win_prob
    expect(result.scoreBreakdown.model_win_prob).toBeUndefined();
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

    // AC2: same absolute lineDelta produces a larger lineValue boost on a
    // small consensus line (runline-like ~1.5) than on a large one (NBA ~7).
    // This confirms normalization is magnitude-relative, not hardcoded.
    const smallConsensus = scoreCandidate({
      ...nhlOver,
      marketType: 'TOTAL',
      selection: 'OVER',
      line: 1.0,
      consensusLine: 1.5,  // runline-scale: lineDelta = 1.5 - 1.0 = 0.5
      comparableLines: [1.5, 1.5, 1.5],
    });
    const largeConsensus = scoreCandidate({
      ...nhlOver,
      marketType: 'TOTAL',
      selection: 'OVER',
      line: 6.5,
      consensusLine: 7.0,  // NBA-scale: lineDelta = 7.0 - 6.5 = 0.5
      comparableLines: [7.0, 7.0, 7.0],
    });
    // Same lineDelta (0.5) but smaller consensus magnitude → bigger lineValue boost
    expect(smallConsensus.lineValue).toBeGreaterThan(largeConsensus.lineValue);
  });
});

describe('scoreCandidate - reasoning string', () => {
  const baseCandidate = {
    sport: 'NHL',
    gameId: 'game-r-001',
    home_team: 'Boston Bruins',
    away_team: 'Toronto Maple Leafs',
    marketType: 'TOTAL',
    selection: 'OVER',
    selectionLabel: 'OVER 5.5',
    line: 5.5,
    price: 115,
    consensusLine: 5.5,
    consensusPrice: -110,
    counterpartConsensusPrice: -110,
    comparableLines: [5.5, 5.5, 5.5],
    comparablePrices: [115, -110, -110],
    sourceCount: 3,
  };

  test('scored candidate includes a non-empty reasoning string', () => {
    const scored = scoreCandidate(baseCandidate);
    expect(scored).not.toBeNull();
    expect(typeof scored.reasoning).toBe('string');
    expect(scored.reasoning.length).toBeGreaterThan(0);
    expect(scored.reasoning).toContain('OVER 5.5');
    expect(scored.reasoning).toContain('+115');
  });

  test('reasoning includes edge and win prob formatted values', () => {
    const scored = scoreCandidate(baseCandidate);
    expect(scored).not.toBeNull();
    // edge formatted as +X.Xpp
    expect(scored.reasoning).toMatch(/edge \+[\d.]+pp/);
    // win prob formatted as XX.X%
    expect(scored.reasoning).toMatch(/win prob [\d.]+%/);
  });

  test('MLB moneyline reasoning references projection source not "Model likes"', () => {
    const mlbCandidate = {
      sport: 'baseball_mlb',
      gameId: 'game-mlb-r-001',
      home_team: 'Red Sox',
      away_team: 'Yankees',
      marketType: 'MONEYLINE',
      selection: 'HOME',
      selectionLabel: 'Red Sox',
      line: null,
      price: -160,
      consensusLine: null,
      consensusPrice: -155,
      counterpartConsensusPrice: 145,
      comparableLines: [],
      comparablePrices: [-155, -158, -160],
      sourceCount: 3,
      mlbSignal: {
        modelWinProb: 0.572,
        edge: 0.031,
        projection_source: 'FULL_MODEL',
      },
    };

    const scored = scoreCandidate(mlbCandidate);
    expect(scored).not.toBeNull();
    expect(typeof scored.reasoning).toBe('string');
    expect(scored.reasoning.length).toBeGreaterThan(0);
    // MLB model path references FULL_MODEL, not "Model likes"
    expect(scored.reasoning).toContain('Full model projection backs');
    expect(scored.reasoning).not.toContain('Model likes');
    expect(scored.reasoning).toContain('Red Sox');
  });
});
