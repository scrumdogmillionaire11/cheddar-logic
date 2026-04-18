'use strict';

const {
  buildCandidates,
  isNhlSport,
  kellySize,
  resolveNHLModelSignal,
  scoreCandidate,
  selectBestPlay,
  selectTopPlays,
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

describe('confidenceMultiplier', () => {
  const { confidenceMultiplier, kellySize } = require('../signal-engine');

  test('returns correct multiplier for each tier label', () => {
    expect(confidenceMultiplier('ELITE')).toBe(1.0);
    expect(confidenceMultiplier('HIGH')).toBe(0.85);
    expect(confidenceMultiplier('MEDIUM')).toBe(0.65);
    expect(confidenceMultiplier('LOW')).toBe(0.40);
  });

  test('returns 0.85 safe default for unknown or missing label', () => {
    expect(confidenceMultiplier('UNKNOWN_LABEL')).toBe(0.85);
    expect(confidenceMultiplier(undefined)).toBe(0.85);
    expect(confidenceMultiplier(null)).toBe(0.85);
  });

  test('ELITE / HIGH ratio is approximately 1.176 using identical kellySize inputs', () => {
    const inputs = { edgePct: 0.05, impliedProb: 0.476, bankroll: 10, kellyFraction: 0.25, maxWagerPct: 0.2 };
    const rawWager = kellySize(inputs);
    const eliteWager = Math.round(rawWager * confidenceMultiplier('ELITE') * 100) / 100;
    const highWager = Math.round(rawWager * confidenceMultiplier('HIGH') * 100) / 100;
    const ratio = eliteWager / highWager;
    expect(ratio).toBeCloseTo(1.0 / 0.85, 1); // ≈ 1.176, tolerance 0.1
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

// ---------------------------------------------------------------------------
// isNhlSport
// ---------------------------------------------------------------------------
describe('isNhlSport', () => {
  it('returns true for NHL', () => {
    expect(isNhlSport('NHL')).toBe(true);
  });

  it('returns true for icehockey_nhl (lowercase)', () => {
    expect(isNhlSport('icehockey_nhl')).toBe(true);
  });

  it('returns true for ICEHOCKEY_NHL (uppercase)', () => {
    expect(isNhlSport('ICEHOCKEY_NHL')).toBe(true);
  });

  it('returns false for MLB', () => {
    expect(isNhlSport('MLB')).toBe(false);
  });

  it('returns false for NBA', () => {
    expect(isNhlSport('NBA')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isNhlSport(null)).toBe(false);
    expect(isNhlSport(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveNHLModelSignal
// ---------------------------------------------------------------------------
describe('resolveNHLModelSignal', () => {
  function buildNhlGameWithSnapshot(overrides = {}) {
    return {
      gameId: 'nhl-game-001',
      sport: 'NHL',
      homeTeam: 'Boston Bruins',
      awayTeam: 'Toronto Maple Leafs',
      gameTimeUtc: '2026-04-10T00:00:00.000Z',
      market: {
        h2h: [
          { book: 'book-a', home: -115, away: -105 },
          { book: 'book-b', home: -112, away: -108 },
          { book: 'book-c', home: -118, away: -102 },
        ],
      },
      nhlSnapshot: {
        homeGoalie: { savePct: 0.918, gsax: 2.0 },
        awayGoalie: { savePct: 0.910, gsax: -1.0 },
      },
      ...overrides,
    };
  }

  it('returns null when nhlSnapshot is null', () => {
    const game = buildNhlGameWithSnapshot({ nhlSnapshot: null });
    expect(resolveNHLModelSignal(game)).toBeNull();
  });

  it('returns null when nhlSnapshot is missing (undefined)', () => {
    const game = { gameId: 'x', market: { h2h: [] } };
    expect(resolveNHLModelSignal(game)).toBeNull();
  });

  it('returns null when both goalies have no data (savePct and gsax both null)', () => {
    const game = buildNhlGameWithSnapshot({
      nhlSnapshot: {
        homeGoalie: { savePct: null, gsax: null },
        awayGoalie: { savePct: null, gsax: null },
      },
    });
    expect(resolveNHLModelSignal(game)).toBeNull();
  });

  it('elite home goalie vs weak away produces homeModelWinProb > vig-removed consensus', () => {
    const game = buildNhlGameWithSnapshot({
      nhlSnapshot: {
        homeGoalie: { savePct: 0.928, gsax: 8.5 },
        awayGoalie: { savePct: 0.901, gsax: -2.1 },
      },
    });
    const signal = resolveNHLModelSignal(game);
    expect(signal).not.toBeNull();
    // The signal should push homeModelWinProb above vig-removed consensus
    // At -115/-105, vig-removed home is approximately 0.523
    expect(signal.homeModelWinProb).toBeGreaterThan(0.523);
    expect(signal.homeModelWinProb).toBeLessThanOrEqual(0.95);
    expect(signal.projection_source).toBe('NHL_GOALIE_COMPOSITE');
  });

  it('reports projection_source NHL_GOALIE_COMPOSITE when both goalies have data', () => {
    const game = buildNhlGameWithSnapshot();
    const signal = resolveNHLModelSignal(game);
    expect(signal).not.toBeNull();
    expect(signal.projection_source).toBe('NHL_GOALIE_COMPOSITE');
  });

  it('reports projection_source NHL_GOALIE_PARTIAL when only home goalie has data', () => {
    const game = buildNhlGameWithSnapshot({
      nhlSnapshot: {
        homeGoalie: { savePct: 0.920, gsax: 3.0 },
        awayGoalie: { savePct: null, gsax: null },
      },
    });
    const signal = resolveNHLModelSignal(game);
    expect(signal).not.toBeNull();
    expect(signal.projection_source).toBe('NHL_GOALIE_PARTIAL');
  });

  it('reports projection_source NHL_GOALIE_PARTIAL when only away goalie has data', () => {
    const game = buildNhlGameWithSnapshot({
      nhlSnapshot: {
        homeGoalie: { savePct: null, gsax: null },
        awayGoalie: { savePct: 0.915, gsax: 1.5 },
      },
    });
    const signal = resolveNHLModelSignal(game);
    expect(signal).not.toBeNull();
    expect(signal.projection_source).toBe('NHL_GOALIE_PARTIAL');
  });

  it('clamps goalieEdgeDelta to [-0.06, 0.06]', () => {
    // Extreme goalie difference — delta should be clamped
    const game = buildNhlGameWithSnapshot({
      nhlSnapshot: {
        homeGoalie: { savePct: 0.950, gsax: 30.0 },
        awayGoalie: { savePct: 0.870, gsax: -20.0 },
      },
    });
    const signal = resolveNHLModelSignal(game);
    expect(signal).not.toBeNull();
    // homeModelWinProb is at most consensus + 0.06
    expect(signal.homeModelWinProb).toBeLessThanOrEqual(0.95);
  });

  it('clamps homeModelWinProb to [0.05, 0.95]', () => {
    const game = buildNhlGameWithSnapshot({
      nhlSnapshot: {
        homeGoalie: { savePct: 0.950, gsax: 30.0 },
        awayGoalie: { savePct: 0.870, gsax: -20.0 },
      },
    });
    const signal = resolveNHLModelSignal(game);
    expect(signal).not.toBeNull();
    expect(signal.homeModelWinProb).toBeGreaterThanOrEqual(0.05);
    expect(signal.homeModelWinProb).toBeLessThanOrEqual(0.95);
  });

  it('returns null when h2h market is empty (cannot derive consensus)', () => {
    const game = buildNhlGameWithSnapshot({
      market: { h2h: [] },
    });
    expect(resolveNHLModelSignal(game)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// scoreCandidate - NHL moneyline override
// ---------------------------------------------------------------------------
describe('scoreCandidate - NHL moneyline override', () => {
  function buildNhlMoneylineCandidate(selection, overrides = {}) {
    return {
      gameId: 'nhl-game-001',
      sport: 'NHL',
      homeTeam: 'Boston Bruins',
      awayTeam: 'Toronto Maple Leafs',
      gameTimeUtc: '2026-04-10T00:00:00.000Z',
      marketType: 'MONEYLINE',
      selection,
      selectionLabel: selection === 'HOME' ? 'Boston Bruins' : 'Toronto Maple Leafs',
      price: selection === 'HOME' ? -120 : 102,
      consensusPrice: selection === 'HOME' ? -115 : -105,
      counterpartConsensusPrice: selection === 'HOME' ? -105 : -115,
      consensusImplied: selection === 'HOME' ? 0.535 : 0.488,
      counterpartConsensusImplied: selection === 'HOME' ? 0.488 : 0.535,
      comparableLines: [],
      comparablePrices: selection === 'HOME' ? [-115, -118, -120] : [-105, -102, 102],
      sourceCount: 3,
      line: null,
      consensusLine: null,
      nhlSignal: {
        homeModelWinProb: 0.56,
        projection_source: 'NHL_GOALIE_COMPOSITE',
      },
      ...overrides,
    };
  }

  it('HOME candidate edgePct = homeModelWinProb - impliedProb(homePrice)', () => {
    const candidate = buildNhlMoneylineCandidate('HOME');
    const scored = scoreCandidate(candidate);
    expect(scored).not.toBeNull();
    // impliedProb(-120) = 120/220 ≈ 0.5455
    const expectedImplied = 120 / 220;
    const expectedEdge = 0.56 - expectedImplied;
    expect(scored.edgePct).toBeCloseTo(expectedEdge, 4);
    expect(scored.modelWinProb).toBe(0.56);
  });

  it('AWAY candidate edgePct = (1 - homeModelWinProb) - impliedProb(awayPrice)', () => {
    const candidate = buildNhlMoneylineCandidate('AWAY');
    const scored = scoreCandidate(candidate);
    expect(scored).not.toBeNull();
    // awayModelWinProb = 1 - 0.56 = 0.44
    // impliedProb(+102) = 100/(102+100) ≈ 0.4950
    const awayModelWinProb = 1 - 0.56;
    const expectedImplied = 100 / (102 + 100);
    const expectedEdge = awayModelWinProb - expectedImplied;
    expect(scored.edgePct).toBeCloseTo(expectedEdge, 4);
    expect(scored.modelWinProb).toBeCloseTo(awayModelWinProb, 6);
  });

  it('HOME and AWAY edgePct are not equal (AWAY is complement, not mirror)', () => {
    const homeScored = scoreCandidate(buildNhlMoneylineCandidate('HOME'));
    const awayScored = scoreCandidate(buildNhlMoneylineCandidate('AWAY'));
    expect(homeScored).not.toBeNull();
    expect(awayScored).not.toBeNull();
    expect(homeScored.edgePct).not.toBe(awayScored.edgePct);
  });

  it('scoreBreakdown includes model_win_prob and projection_source when nhlSignal present', () => {
    const candidate = buildNhlMoneylineCandidate('HOME');
    const scored = scoreCandidate(candidate);
    expect(scored).not.toBeNull();
    expect(scored.scoreBreakdown.model_win_prob).toBe(0.56);
    expect(scored.scoreBreakdown.projection_source).toBe('NHL_GOALIE_COMPOSITE');
  });

  it('falls through to consensus path when no nhlSignal (scoreBreakdown has no model_win_prob)', () => {
    const candidate = buildNhlMoneylineCandidate('HOME', { nhlSignal: null });
    const scored = scoreCandidate(candidate);
    expect(scored).not.toBeNull();
    expect(scored.scoreBreakdown.model_win_prob).toBeUndefined();
    expect(scored.scoreBreakdown.projection_source).toBeUndefined();
  });

  it('MLB scoreCandidate path is unaffected by nhlSignal logic', () => {
    const mlbCandidate = {
      gameId: 'mlb-game-002',
      sport: 'MLB',
      homeTeam: 'Yankees',
      awayTeam: 'Red Sox',
      gameTimeUtc: '2026-04-10T00:00:00.000Z',
      marketType: 'MONEYLINE',
      selection: 'HOME',
      selectionLabel: 'Yankees',
      price: -150,
      consensusPrice: -145,
      counterpartConsensusPrice: 132,
      consensusImplied: 0.592,
      counterpartConsensusImplied: 0.431,
      comparableLines: [],
      comparablePrices: [-145, -148, -150],
      sourceCount: 3,
      line: null,
      consensusLine: null,
      mlbSignal: {
        modelWinProb: 0.61,
        edge: 0.04,
        projection_source: 'FULL_MODEL',
      },
      // Should not trigger NHL path
      nhlSignal: null,
    };
    const scored = scoreCandidate(mlbCandidate);
    expect(scored).not.toBeNull();
    expect(scored.modelWinProb).toBe(0.61);
    expect(scored.edgePct).toBeCloseTo(0.04, 4);
  });
});

// ---------------------------------------------------------------------------
// selectTopPlays
// ---------------------------------------------------------------------------
describe('selectTopPlays', () => {
  function makeCandidate(sport, totalScore, edgePct, overrides = {}) {
    return {
      sport,
      gameId: `${sport}-game-001`,
      marketType: 'TOTAL',
      selectionLabel: `${sport} pick`,
      totalScore,
      edgePct,
      ...overrides,
    };
  }

  test('returns empty array when no viable candidates', () => {
    expect(selectTopPlays([], { minConfidence: 0 })).toEqual([]);
    expect(selectTopPlays(null, { minConfidence: 0 })).toEqual([]);
    expect(selectTopPlays([makeCandidate('NHL', 0.8, -0.01)], { minConfidence: 0 })).toEqual([]);
  });

  test('can rank diagnostic nominees without positive edge', () => {
    const candidates = [
      makeCandidate('NHL', 0.72, -0.01),
      makeCandidate('NBA', 0.78, -0.02),
    ];

    const result = selectTopPlays(candidates, {
      minConfidence: 0,
      requirePositiveEdge: false,
    });

    expect(result).toHaveLength(2);
    expect(result[0].sport).toBe('NBA');
    expect(selectBestPlay(candidates, { minConfidence: 0 })).toBeNull();
  });

  test('returns one winner per sport, not raw top N from same sport', () => {
    const candidates = [
      makeCandidate('MLB', 0.80, 0.04),
      makeCandidate('MLB', 0.75, 0.05, { gameId: 'MLB-game-002' }),
      makeCandidate('MLB', 0.70, 0.06, { gameId: 'MLB-game-003' }),
      makeCandidate('NHL', 0.65, 0.03),
    ];

    const result = selectTopPlays(candidates, { minConfidence: 0, maxNominees: 5 });
    expect(result).toHaveLength(2);
    const sports = result.map((c) => c.sport);
    expect(sports).toContain('MLB');
    expect(sports).toContain('NHL');
    expect(result.find((c) => c.sport === 'MLB').totalScore).toBe(0.80);
  });

  test('ranks sport winners by totalScore descending then edgePct', () => {
    const candidates = [
      makeCandidate('NBA', 0.70, 0.03),
      makeCandidate('NHL', 0.75, 0.02),
      makeCandidate('MLB', 0.75, 0.04),
    ];

    const result = selectTopPlays(candidates, { minConfidence: 0, maxNominees: 5 });
    expect(result[0].sport).toBe('MLB');   // tied totalScore, higher edgePct wins
    expect(result[1].sport).toBe('NHL');
    expect(result[2].sport).toBe('NBA');
  });

  test('respects maxNominees cap', () => {
    const candidates = [
      makeCandidate('NHL', 0.80, 0.04),
      makeCandidate('NBA', 0.75, 0.03),
      makeCandidate('MLB', 0.70, 0.05),
      makeCandidate('NFL', 0.65, 0.02),
    ];

    expect(selectTopPlays(candidates, { minConfidence: 0, maxNominees: 2 })).toHaveLength(2);
    expect(selectTopPlays(candidates, { minConfidence: 0, maxNominees: 10 })).toHaveLength(4);
  });

  test('winner via selectBestPlay equals first result of selectTopPlays', () => {
    const candidates = [
      makeCandidate('NHL', 0.80, 0.04),
      makeCandidate('NBA', 0.75, 0.03),
    ];

    const best = selectBestPlay(candidates, { minConfidence: 0 });
    const top = selectTopPlays(candidates, { minConfidence: 0 });
    expect(best).toEqual(top[0]);
  });

  test('minConfidence threshold filters nominees', () => {
    const candidates = [
      makeCandidate('NHL', 0.60, 0.04),
      makeCandidate('NBA', 0.40, 0.03),
    ];

    const result = selectTopPlays(candidates, { minConfidence: 'HIGH' });
    expect(result).toHaveLength(1);
    expect(result[0].sport).toBe('NHL');
  });

  test('stable tiebreaker produces deterministic order when score and edge match', () => {
    const a = makeCandidate('MLB', 0.72, 0.03, { gameId: 'game-aaa', marketType: 'SPREAD' });
    const b = makeCandidate('MLB', 0.72, 0.03, { gameId: 'game-zzz', marketType: 'SPREAD' });

    const result1 = selectTopPlays([a, b], { minConfidence: 0 });
    const result2 = selectTopPlays([b, a], { minConfidence: 0 });
    expect(result1[0].gameId).toBe('game-aaa');
    expect(result2[0].gameId).toBe('game-aaa');
  });
});

// ---------------------------------------------------------------------------
// WI-1028: resolveNoiseFloor
// ---------------------------------------------------------------------------
describe('resolveNoiseFloor', () => {
  const { resolveNoiseFloor } = require('../signal-engine');

  test('returns sport+market specific floor for known combinations', () => {
    // MLB
    expect(resolveNoiseFloor('MLB', 'MONEYLINE')).toBeCloseTo(0.03, 5);
    expect(resolveNoiseFloor('baseball_mlb', 'MONEYLINE')).toBeCloseTo(0.03, 5);
    expect(resolveNoiseFloor('BASEBALL_MLB', 'MONEYLINE')).toBeCloseTo(0.03, 5);
    expect(resolveNoiseFloor('MLB', 'SPREAD')).toBeCloseTo(0.025, 5);
    // NHL
    expect(resolveNoiseFloor('NHL', 'MONEYLINE')).toBeCloseTo(0.02, 5);
    expect(resolveNoiseFloor('icehockey_nhl', 'MONEYLINE')).toBeCloseTo(0.02, 5);
    expect(resolveNoiseFloor('NHL', 'SPREAD')).toBeCloseTo(0.02, 5);
    // NBA
    expect(resolveNoiseFloor('NBA', 'MONEYLINE')).toBeCloseTo(0.025, 5);
    expect(resolveNoiseFloor('basketball_nba', 'SPREAD')).toBeCloseTo(0.02, 5);
    expect(resolveNoiseFloor('NBA', 'TOTAL')).toBeCloseTo(0.02, 5);
  });

  test('falls back to globalFallback for unknown sport', () => {
    expect(resolveNoiseFloor('NFL', 'MONEYLINE')).toBeCloseTo(0.02, 5);
    expect(resolveNoiseFloor('SOCCER', 'TOTAL')).toBeCloseTo(0.02, 5);
    expect(resolveNoiseFloor(null, null)).toBeCloseTo(0.02, 5);
    expect(resolveNoiseFloor(undefined, undefined)).toBeCloseTo(0.02, 5);
  });

  test('falls back to globalFallback for known sport but unknown market type', () => {
    expect(resolveNoiseFloor('MLB', 'TOTAL')).toBeCloseTo(0.02, 5);
    expect(resolveNoiseFloor('NHL', 'TOTAL')).toBeCloseTo(0.02, 5);
  });

  test('custom globalFallback is respected', () => {
    expect(resolveNoiseFloor('NFL', 'SPREAD', 0.035)).toBeCloseTo(0.035, 5);
  });
});

// ---------------------------------------------------------------------------
// WI-1029: edgeSourceTag on scored candidates
// ---------------------------------------------------------------------------
describe('edgeSourceTag', () => {
  test('MLB model path stamps edgeSourceTag = MODEL', () => {
    const candidate = {
      gameId: 'mlb-tag-001',
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
    const scored = scoreCandidate(candidate);
    expect(scored.edgeSourceTag).toBe('MODEL');
    expect(scored.edgeSourceMeta).toMatchObject({
      projection_source: 'FULL_MODEL',
      model_win_prob: 0.58,
      signal_type: 'MLB_PITCHER_MODEL',
    });
  });

  test('NHL model path stamps edgeSourceTag = MODEL', () => {
    const candidate = {
      gameId: 'nhl-tag-001',
      sport: 'NHL',
      home_team: 'Bruins',
      away_team: 'Leafs',
      commence_time: new Date().toISOString(),
      marketType: 'MONEYLINE',
      selection: 'HOME',
      selectionLabel: 'Bruins',
      line: null,
      price: -120,
      consensusLine: null,
      consensusPrice: -115,
      counterpartConsensusPrice: -105,
      consensusImplied: 0.535,
      counterpartConsensusImplied: 0.488,
      comparableLines: [],
      comparablePrices: [-115, -118, -120],
      sourceCount: 3,
      nhlSignal: { homeModelWinProb: 0.56, projection_source: 'NHL_GOALIE_COMPOSITE' },
    };
    const scored = scoreCandidate(candidate);
    expect(scored.edgeSourceTag).toBe('MODEL');
    expect(scored.edgeSourceMeta).toMatchObject({
      signal_type: 'NHL_GOALIE_COMPOSITE',
      projection_source: 'NHL_GOALIE_COMPOSITE',
    });
  });

  test('consensus fallback path stamps edgeSourceTag = CONSENSUS_FALLBACK', () => {
    const candidate = {
      gameId: 'nba-tag-001',
      sport: 'NBA',
      home_team: 'Lakers',
      away_team: 'Warriors',
      commence_time: new Date().toISOString(),
      marketType: 'SPREAD',
      selection: 'HOME',
      selectionLabel: 'Lakers -4.5',
      line: -4.5,
      price: -108,
      consensusLine: -5,
      consensusPrice: -110,
      counterpartConsensusPrice: -110,
      consensusImplied: 0.524,
      counterpartConsensusImplied: 0.524,
      comparableLines: [-5, -4.5, -5],
      comparablePrices: [-110, -108, -112],
      sourceCount: 3,
    };
    const scored = scoreCandidate(candidate);
    expect(scored.edgeSourceTag).toBe('CONSENSUS_FALLBACK');
    expect(scored.edgeSourceMeta).toMatchObject({
      signal_type: 'DEVIG_CONSENSUS',
      projection_source: null,
    });
  });
});

// ---------------------------------------------------------------------------
// WI-1032: resolveEdgeSourceContract
// ---------------------------------------------------------------------------
describe('resolveEdgeSourceContract', () => {
  const { resolveEdgeSourceContract, EDGE_SOURCE_CONTRACT } = require('../signal-engine');

  test('returns MODEL for MLB and NHL moneyline', () => {
    expect(resolveEdgeSourceContract('MLB', 'MONEYLINE')).toBe('MODEL');
    expect(resolveEdgeSourceContract('BASEBALL_MLB', 'MONEYLINE')).toBe('MODEL');
    expect(resolveEdgeSourceContract('NHL', 'MONEYLINE')).toBe('MODEL');
    expect(resolveEdgeSourceContract('icehockey_nhl', 'MONEYLINE')).toBe('MODEL');
  });

  test('returns CONSENSUS_FALLBACK for MLB/NHL spread and total', () => {
    expect(resolveEdgeSourceContract('MLB', 'SPREAD')).toBe('CONSENSUS_FALLBACK');
    expect(resolveEdgeSourceContract('MLB', 'TOTAL')).toBe('CONSENSUS_FALLBACK');
    expect(resolveEdgeSourceContract('NHL', 'SPREAD')).toBe('CONSENSUS_FALLBACK');
    expect(resolveEdgeSourceContract('NHL', 'TOTAL')).toBe('CONSENSUS_FALLBACK');
  });

  test('returns CONSENSUS_FALLBACK for all NBA markets before WI-1030', () => {
    expect(resolveEdgeSourceContract('NBA', 'MONEYLINE')).toBe('CONSENSUS_FALLBACK');
    expect(resolveEdgeSourceContract('basketball_nba', 'SPREAD')).toBe('CONSENSUS_FALLBACK');
    expect(resolveEdgeSourceContract('NBA', 'TOTAL')).toBe('CONSENSUS_FALLBACK');
  });

  test('returns CONSENSUS_FALLBACK for all NFL markets', () => {
    expect(resolveEdgeSourceContract('NFL', 'MONEYLINE')).toBe('CONSENSUS_FALLBACK');
    expect(resolveEdgeSourceContract('americanfootball_nfl', 'SPREAD')).toBe('CONSENSUS_FALLBACK');
    expect(resolveEdgeSourceContract('NFL', 'TOTAL')).toBe('CONSENSUS_FALLBACK');
  });

  test('returns UNKNOWN for unregistered sport/market combinations', () => {
    expect(resolveEdgeSourceContract('SOCCER', 'MONEYLINE')).toBe('UNKNOWN');
    expect(resolveEdgeSourceContract('MLB', 'UNKNOWN_MARKET')).toBe('UNKNOWN');
    expect(resolveEdgeSourceContract(null, null)).toBe('UNKNOWN');
    expect(resolveEdgeSourceContract(undefined, undefined)).toBe('UNKNOWN');
    expect(resolveEdgeSourceContract('', '')).toBe('UNKNOWN');
  });

  test('EDGE_SOURCE_CONTRACT is a frozen object (immutable)', () => {
    expect(Object.isFrozen(EDGE_SOURCE_CONTRACT)).toBe(true);
    expect(Object.isFrozen(EDGE_SOURCE_CONTRACT.MLB)).toBe(true);
    expect(Object.isFrozen(EDGE_SOURCE_CONTRACT.NHL)).toBe(true);
    expect(Object.isFrozen(EDGE_SOURCE_CONTRACT.NBA)).toBe(true);
    expect(Object.isFrozen(EDGE_SOURCE_CONTRACT.NFL)).toBe(true);
  });

  // xtest: will pass once WI-1030 ships and NBA TOTAL is updated to 'MODEL'
  xtest('WI-1030 post-ship: NBA TOTAL should be MODEL once NBA totals model is wired in', () => {
    expect(resolveEdgeSourceContract('NBA', 'TOTAL')).toBe('MODEL');
  });
});
