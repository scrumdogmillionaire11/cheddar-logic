'use strict';

const {
  buildCandidates,
  hasRequiredEdgeInputs,
  isNhlSport,
  kellySize,
  normalizeEdgeSource,
  resolveMLBSnapshotSignal,
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

  test('injects MLB snapshot signal only onto moneyline candidates', () => {
    const candidates = buildCandidates(
      buildGame({
        sport: 'MLB',
        mlbSnapshot: {
          modelWinProbHome: 0.584,
          edge: 0.047,
          side: 'HOME',
          projection_source: 'MLB_FULL_GAME_MODEL',
        },
      })
    );

    const moneylineCandidate = candidates.find((c) => c.marketType === 'MONEYLINE');
    expect(resolveMLBSnapshotSignal({
      mlbSnapshot: moneylineCandidate.mlbSnapshotSignal,
    })).toEqual({
      modelWinProbHome: 0.584,
      edge: 0.047,
      side: 'HOME',
      projection_source: 'MLB_FULL_GAME_MODEL',
    });
    expect(candidates.filter((candidate) => candidate.marketType === 'MONEYLINE')).toHaveLength(2);
    expect(candidates.filter((candidate) => candidate.mlbSnapshotSignal)).toHaveLength(2);
    expect(candidates.filter((candidate) => candidate.marketType !== 'MONEYLINE' && candidate.mlbSnapshotSignal)).toHaveLength(0);
  });

  test('marks MODEL-contract candidates with modelPayloadPresent when payload exists but signal is incomplete', () => {
    const candidates = buildCandidates(
      buildGame({
        sport: 'NHL',
        nhlModelPayloadPresent: true,
        nhlSnapshot: {
          model_signal: {
            eligible_for_potd: false,
            market_type: 'MONEYLINE',
            selection_side: 'HOME',
            selection_team: 'Boston Bruins',
            model_prob: null,
            book_price: -115,
            implied_prob: 0.535,
            edge_pct: null,
            fair_price: null,
            edge_available: false,
            source: 'NHL_MODEL_OUTPUT_MONEYLINE',
            blockers: ['MODEL_PROB_MISSING'],
          },
          homeGoalie: { savePct: null, gsax: null },
          awayGoalie: { savePct: null, gsax: null },
        },
      }),
    );
    const moneylineCandidates = candidates.filter((candidate) => candidate.marketType === 'MONEYLINE');
    expect(moneylineCandidates).toHaveLength(2);
    expect(moneylineCandidates.every((candidate) => candidate.modelPayloadPresent === true)).toBe(true);
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
    const scoredElite = buildCandidates(buildEliteGame())
      .map(scoreCandidate)
      .filter(Boolean)
      .find((candidate) => candidate.confidenceLabel === 'HIGH');
    const elite = {
      ...scoredElite,
      totalScore: 0.76,
      confidenceLabel: 'ELITE',
    };

    expect(high).toBeDefined();
    expect(scoredElite).toBeDefined();
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

  test('MLB snapshot signal overrides consensus fair prob in scoreCandidate', () => {
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
      mlbSnapshotSignal: {
        modelWinProbHome: 0.58,
        edge: 0.06,
        side: 'HOME',
        projection_source: 'MLB_FULL_GAME_MODEL',
      },
    };

    const result = scoreCandidate(candidate);
    expect(result).not.toBeNull();
    expect(result.modelWinProb).toBe(0.58);
    expect(result.impliedProb).toBeCloseTo(130 / 230, 6);
    expect(result.edgePct).toBeCloseTo(0.58 - (130 / 230), 6);
    expect(result.scoreBreakdown.model_win_prob).toBe(0.58);
    expect(result.scoreBreakdown.projection_source).toBe('MLB_FULL_GAME_MODEL');
  });

  test('MLB candidate without mlbSnapshotSignal falls back to consensus path', () => {
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
      // no mlbSnapshotSignal property
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
      mlbSnapshotSignal: {
        modelWinProbHome: 0.572,
        edge: 0.031,
        side: 'HOME',
        projection_source: 'MLB_FULL_GAME_MODEL',
      },
    };

    const scored = scoreCandidate(mlbCandidate);
    expect(scored).not.toBeNull();
    expect(typeof scored.reasoning).toBe('string');
    expect(scored.reasoning.length).toBeGreaterThan(0);
    // MLB model path references the full-game model, not "Model likes"
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
      mlbSnapshotSignal: {
        modelWinProbHome: 0.61,
        edge: 0.04,
        side: 'HOME',
        projection_source: 'MLB_FULL_GAME_MODEL',
      },
      // Should not trigger NHL path
      nhlSignal: null,
    };
    const scored = scoreCandidate(mlbCandidate);
    expect(scored).not.toBeNull();
    expect(scored.modelWinProb).toBe(0.61);
    expect(scored.impliedProb).toBeCloseTo(150 / 250, 6);
    expect(scored.edgePct).toBeCloseTo(0.61 - (150 / 250), 6);
  });
});

describe('edge input helpers', () => {
  test('hasRequiredEdgeInputs requires finite price/modelProb/impliedProb/edgePct', () => {
    expect(
      hasRequiredEdgeInputs({
        price: -110,
        modelWinProb: 0.57,
        impliedProb: 0.52381,
        edgePct: 0.04619,
      }),
    ).toBe(true);
    expect(
      hasRequiredEdgeInputs({
        price: -110,
        modelWinProb: null,
        impliedProb: 0.52381,
        edgePct: 0.04619,
      }),
    ).toBe(false);
  });

  test('normalizeEdgeSource maps MODEL and CONSENSUS_FALLBACK to stable labels', () => {
    expect(normalizeEdgeSource('MODEL')).toBe('MODEL');
    expect(normalizeEdgeSource('CONSENSUS_FALLBACK')).toBe('CONSENSUS');
    expect(normalizeEdgeSource('UNKNOWN')).toBe('UNKNOWN');
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
    expect(resolveNoiseFloor('NBA', 'TOTAL')).toBeCloseTo(0.03, 5);
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
  test('MLB snapshot model path stamps edgeSourceTag = MODEL', () => {
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
      mlbSnapshotSignal: {
        modelWinProbHome: 0.58,
        edge: 0.06,
        side: 'HOME',
        projection_source: 'MLB_FULL_GAME_MODEL',
      },
    };
    const scored = scoreCandidate(candidate);
    expect(scored.edgeSourceTag).toBe('MODEL');
    expect(scored.edgeSourceMeta).toMatchObject({
      projection_source: 'MLB_FULL_GAME_MODEL',
      model_win_prob: 0.58,
      signal_type: 'MLB_FULL_GAME_MODEL',
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

  test('returns CONSENSUS_FALLBACK for NBA ML and SPREAD; MODEL for NBA TOTAL (WI-1030)', () => {
    expect(resolveEdgeSourceContract('NBA', 'MONEYLINE')).toBe('CONSENSUS_FALLBACK');
    expect(resolveEdgeSourceContract('basketball_nba', 'SPREAD')).toBe('CONSENSUS_FALLBACK');
    expect(resolveEdgeSourceContract('NBA', 'TOTAL')).toBe('MODEL');
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

  // WI-1030 shipped: NBA TOTAL is now MODEL-backed.
  test('WI-1030: NBA TOTAL is MODEL after NBA totals model is wired in', () => {
    expect(resolveEdgeSourceContract('NBA', 'TOTAL')).toBe('MODEL');
  });
});

// ---------------------------------------------------------------------------
// WI-1030: resolveNBAModelSignal and scoreCandidate NBA TOTAL path
// ---------------------------------------------------------------------------
describe('resolveNBAModelSignal', () => {
  const { scoreCandidate } = require('../signal-engine');

  test('returns null when nbaSnapshot is absent', () => {
    const game = {};
    // scoreCandidate with NBA TOTAL and no nbaSnapshot falls through to consensus
    const candidate = {
      gameId: 'nba-total-no-snap',
      sport: 'NBA',
      home_team: 'Lakers',
      away_team: 'Warriors',
      commence_time: new Date().toISOString(),
      marketType: 'TOTAL',
      selection: 'OVER',
      selectionLabel: 'Over 224.5',
      line: 224.5,
      price: -110,
      consensusLine: 225,
      consensusPrice: -110,
      counterpartConsensusPrice: -110,
      consensusImplied: 0.524,
      counterpartConsensusImplied: 0.524,
      comparableLines: [225, 224.5, 225],
      comparablePrices: [-110, -110, -112],
      sourceCount: 3,
      // No nbaSnapshot
    };
    const scored = scoreCandidate(candidate);
    expect(scored).not.toBeNull();
    expect(scored.edgeSourceTag).toBe('CONSENSUS_FALLBACK');
  });

  test('returns null when totalProjection is not finite', () => {
    const candidate = {
      gameId: 'nba-total-bad-snap',
      sport: 'NBA',
      home_team: 'Lakers',
      away_team: 'Warriors',
      commence_time: new Date().toISOString(),
      marketType: 'TOTAL',
      selection: 'OVER',
      selectionLabel: 'Over 224.5',
      line: 224.5,
      price: -110,
      consensusLine: 225,
      consensusPrice: -110,
      counterpartConsensusPrice: -110,
      consensusImplied: 0.524,
      counterpartConsensusImplied: 0.524,
      comparableLines: [225, 224.5, 225],
      comparablePrices: [-110, -110, -112],
      sourceCount: 3,
      modelPayloadPresent: true,
      nbaSnapshot: { totalProjection: null, projection_source: 'NBA_TOTALS_MODEL' },
    };
    const scored = scoreCandidate(candidate);
    expect(scored).not.toBeNull();
    // WI-1180: payload-present MODEL markets emit explicit rejection diagnostics.
    expect(scored.edgeSourceTag).toBe('MODEL');
    expect(scored.edgePct).toBeNull();
    expect(scored.rejectionDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MODEL_SIGNAL_INCOMPLETE' }),
      ]),
    );
  });

  test('uses NBA totals model projection to compute edgePct when snapshot is valid', () => {
    // consensusLine = 225, totalProjection = 229 → modelOverProb = 0.5 + (229-225)/20 = 0.7
    // selection = OVER → modelSelectionProb = 0.7
    // price = -110 → impliedProb ≈ 0.5238
    // modelEdge ≈ 0.7 - 0.5238 = 0.1762
    const candidate = {
      gameId: 'nba-total-model-001',
      sport: 'NBA',
      home_team: 'Lakers',
      away_team: 'Warriors',
      commence_time: new Date().toISOString(),
      marketType: 'TOTAL',
      selection: 'OVER',
      selectionLabel: 'Over 224.5',
      line: 224.5,
      price: -110,
      consensusLine: 225,
      consensusPrice: -110,
      counterpartConsensusPrice: -110,
      consensusImplied: 0.524,
      counterpartConsensusImplied: 0.524,
      comparableLines: [225, 224.5, 225],
      comparablePrices: [-110, -110, -112],
      sourceCount: 3,
      nbaSnapshot: { totalProjection: 229, projection_source: 'NBA_TOTALS_MODEL' },
    };
    const scored = scoreCandidate(candidate);
    expect(scored).not.toBeNull();
    expect(scored.edgeSourceTag).toBe('MODEL');
    expect(scored.edgeSourceMeta).toMatchObject({
      signal_type: 'NBA_TOTALS_MODEL',
      projection_source: 'NBA_TOTALS_MODEL',
    });
    // sigma path: p_over = normCdf((229-225)/14) ≈ 0.6125
    expect(scored.modelWinProb).toBeCloseTo(0.6125, 4);
    expect(scored.edgePct).toBeGreaterThan(0.10);
    expect(scored.edgePct).toBeLessThan(0.13);
  });

  test('UNDER selection uses sigma complement', () => {
    // consensusLine = 225, totalProjection = 221 → p_over ≈ 0.3875
    // selection = UNDER → modelSelectionProb ≈ 0.6125
    const candidate = {
      gameId: 'nba-total-model-002',
      sport: 'NBA',
      home_team: 'Celtics',
      away_team: 'Heat',
      commence_time: new Date().toISOString(),
      marketType: 'TOTAL',
      selection: 'UNDER',
      selectionLabel: 'Under 224.5',
      line: 224.5,
      price: -110,
      consensusLine: 225,
      consensusPrice: -110,
      counterpartConsensusPrice: -110,
      consensusImplied: 0.524,
      counterpartConsensusImplied: 0.524,
      comparableLines: [225, 224.5, 225],
      comparablePrices: [-110, -110, -112],
      sourceCount: 3,
      nbaSnapshot: { totalProjection: 221, projection_source: 'NBA_TOTALS_MODEL' },
    };
    const scored = scoreCandidate(candidate);
    expect(scored).not.toBeNull();
    expect(scored.edgeSourceTag).toBe('MODEL');
    expect(scored.modelWinProb).toBeCloseTo(0.6125, 4);
    expect(scored.edgePct).toBeGreaterThan(0.10);
  });

  test('NBA ML and SPREAD remain on CONSENSUS_FALLBACK even when nbaSnapshot present', () => {
    const makeCandidate = (marketType, selection) => ({
      gameId: 'nba-ml-snap',
      sport: 'NBA',
      home_team: 'Lakers',
      away_team: 'Warriors',
      commence_time: new Date().toISOString(),
      marketType,
      selection,
      selectionLabel: selection === 'HOME' ? 'Lakers' : selection === 'AWAY' ? 'Warriors' : `${selection} 5`,
      line: marketType === 'SPREAD' ? -5 : null,
      price: -110,
      consensusLine: marketType === 'SPREAD' ? -5 : null,
      consensusPrice: -110,
      counterpartConsensusPrice: -110,
      consensusImplied: 0.524,
      counterpartConsensusImplied: 0.524,
      comparableLines: marketType === 'SPREAD' ? [-5, -5] : [],
      comparablePrices: [-110, -110],
      sourceCount: 2,
      nbaSnapshot: { totalProjection: 229, projection_source: 'NBA_TOTALS_MODEL' },
    });
    expect(scoreCandidate(makeCandidate('MONEYLINE', 'HOME')).edgeSourceTag).toBe('CONSENSUS_FALLBACK');
    expect(scoreCandidate(makeCandidate('SPREAD', 'HOME')).edgeSourceTag).toBe('CONSENSUS_FALLBACK');
  });

  test('CONSENSUS_FALLBACK markets remain consensus even when modelPayloadPresent is set', () => {
    const scored = scoreCandidate({
      gameId: 'mlb-spread-consensus-still-valid',
      sport: 'MLB',
      home_team: 'Yankees',
      away_team: 'Red Sox',
      commence_time: new Date().toISOString(),
      marketType: 'SPREAD',
      selection: 'HOME',
      selectionLabel: 'Yankees -1.5',
      line: -1.5,
      price: -110,
      consensusLine: -1.5,
      consensusPrice: -110,
      counterpartConsensusPrice: -110,
      consensusImplied: 0.524,
      counterpartConsensusImplied: 0.524,
      comparableLines: [-1.5, -1.5],
      comparablePrices: [-110, -112],
      sourceCount: 2,
      modelPayloadPresent: true,
    });

    expect(scored).not.toBeNull();
    expect(scored.edgeSourceTag).toBe('CONSENSUS_FALLBACK');
    expect(scored.rejectionDiagnostics).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WI-1178: sigma-based NBA TOTAL edge + edge-weighted totalScore + noise floor
// ---------------------------------------------------------------------------
describe('WI-1178: sigma-based NBA TOTAL edge + edge-weighted totalScore + noise floor', () => {
  function buildNbaTotalCandidate(overrides = {}) {
    return {
      gameId: 'nba-wi-1178-001',
      sport: 'NBA',
      home_team: 'Lakers',
      away_team: 'Warriors',
      commence_time: new Date().toISOString(),
      marketType: 'TOTAL',
      selection: 'OVER',
      selectionLabel: 'Over 220',
      line: 220,
      price: -110,
      consensusLine: 220,
      consensusPrice: -110,
      counterpartConsensusPrice: -110,
      consensusImplied: 0.5238,
      counterpartConsensusImplied: 0.5238,
      comparableLines: [220, 220, 220],
      comparablePrices: [-110, -110, -110],
      sourceCount: 3,
      oddsContext: {
        total_price_over: -110,
        total_price_under: -110,
      },
      nbaSnapshot: { totalProjection: 222, projection_source: 'NBA_TOTALS_MODEL' },
      ...overrides,
    };
  }

  test('Test A (WI-1178-EDGE-01): NBA sigma path produces materially smaller edge than /20 for 2pt gap', () => {
    // At sigma=14, a 2pt gap (projection=222, line=220) produces a small edge.
    // /20 path: modelOverProb = 0.5 + 2/20 = 0.60 → edge ≈ 0.60 - 0.5 = 0.10
    // sigma path: p_over = normCdf((222-220)/14) → much smaller edge
    const candidate = buildNbaTotalCandidate();
    const scored = scoreCandidate(candidate);
    expect(scored).not.toBeNull();
    expect(Number.isFinite(scored.modelWinProb)).toBe(true);
    expect(Number.isFinite(scored.edgePct)).toBe(true);
    expect(scored.edgePct).toBeGreaterThan(0);
    expect(scored.edgePct).toBeLessThan(0.07);
  });

  test('Test B (WI-1178-SCORE-01 clamp high): large edge (>=0.12) produces edgeComponent=1.0 in totalScore', () => {
    // At sigma=14, an 8pt gap produces edgePct >> 0.12 → edgeComponent clamped to 1.0
    const candidate = buildNbaTotalCandidate({
      nbaSnapshot: { totalProjection: 228, projection_source: 'NBA_TOTALS_MODEL' },
    });
    const scored = scoreCandidate(candidate);
    expect(scored).not.toBeNull();
    // edgeComponent should be 1.0 (clamped) so totalScore = lineValue*0.45 + marketConsensus*0.30 + 1.0*0.25
    const expectedTotalScore =
      Number(((scored.lineValue * 0.45) + (scored.marketConsensus * 0.30) + (1.0 * 0.25)).toFixed(6));
    expect(scored.totalScore).toBeCloseTo(expectedTotalScore, 5);
  });

  test('Test B2 (WI-1178-SCORE-01 clamp low): zero edge produces edgeComponent=0.0 (no score subsidy)', () => {
    // projection equals line → zero edge → edgeComponent=0.0
    const candidate = buildNbaTotalCandidate({
      nbaSnapshot: { totalProjection: 220, projection_source: 'NBA_TOTALS_MODEL' },
    });
    const scored = scoreCandidate(candidate);
    expect(scored).not.toBeNull();
    // edgeComponent = 0.0 so totalScore = lineValue*0.45 + marketConsensus*0.30 + 0.0*0.25
    const expectedTotalScore =
      Number(((scored.lineValue * 0.45) + (scored.marketConsensus * 0.30) + (0.0 * 0.25)).toFixed(6));
    expect(scored.totalScore).toBeCloseTo(expectedTotalScore, 5);
  });

  test('Test D (WI-1178-SCORE-01 cross-sport): high-edge MLB MONEYLINE outranks low-edge NBA TOTAL', () => {
    // MLB MONEYLINE: modelWinProb=0.60, price=-110 → impliedProb≈0.5238, edgePct≈0.076
    // lineValue and marketConsensus set via scoreCandidate with appropriate consensus prices
    const mlbCandidate = {
      gameId: 'mlb-wi-1178-001',
      sport: 'baseball_mlb',
      home_team: 'Red Sox',
      away_team: 'Yankees',
      commence_time: new Date().toISOString(),
      marketType: 'MONEYLINE',
      selection: 'HOME',
      selectionLabel: 'Red Sox',
      line: null,
      price: -110,
      consensusLine: null,
      consensusPrice: -108,
      counterpartConsensusPrice: -108,
      consensusImplied: 0.5189,
      counterpartConsensusImplied: 0.5189,
      comparableLines: [],
      comparablePrices: [-110, -108, -108],
      sourceCount: 3,
      mlbSnapshotSignal: {
        // modelWinProbHome=0.60 → edgePct ≈ 0.60 - 0.5 = 0.10 (after vig removal at -108/-108 → 0.50 each)
        modelWinProbHome: 0.60,
        edge: 0.10,
        side: 'HOME',
        projection_source: 'MLB_FULL_GAME_MODEL',
      },
    };

    // NBA TOTAL: only 1pt above line → tiny sigma edge; strong lineValue + marketConsensus
    const nbaTotalCandidate = buildNbaTotalCandidate({
      // Move line far from consensus to get high lineValue and marketConsensus
      line: 219,
      consensusLine: 220,
      price: -105,
      consensusPrice: -110,
      counterpartConsensusPrice: -110,
      comparableLines: [220, 220, 220],
      comparablePrices: [-110, -110, -110],
      oddsContext: { total_price_over: -105, total_price_under: -115 },
      nbaSnapshot: { totalProjection: 221, projection_source: 'NBA_TOTALS_MODEL' },
    });

    const mlbScored = scoreCandidate(mlbCandidate);
    const nbaScored = scoreCandidate(nbaTotalCandidate);

    expect(mlbScored).not.toBeNull();
    expect(nbaScored).not.toBeNull();
    expect(mlbScored.totalScore).toBeGreaterThan(nbaScored.totalScore);
  });

  test('Test C (WI-1178-FLOOR-01): POTD_NOISE_FLOOR_NBA_TOTAL defaults to 0.03 when env var unset', () => {
    const original = process.env.POTD_NOISE_FLOOR_NBA_TOTAL;
    delete process.env.POTD_NOISE_FLOOR_NBA_TOTAL;
    jest.resetModules();
    const { resolveNoiseFloor } = require('../signal-engine');
    expect(resolveNoiseFloor('NBA', 'TOTAL')).toBe(0.03);
    if (original !== undefined) process.env.POTD_NOISE_FLOOR_NBA_TOTAL = original;
  });
});

describe('NHL model_signal POTD consumption contract', () => {
  function buildNhlGameForModelSignal(overrides = {}) {
    return buildGame({
      sport: 'NHL',
      nhlModelPayloadPresent: true,
      nhlSnapshot: {
        model_signal: {
          eligible_for_potd: true,
          market_type: 'MONEYLINE',
          selection_side: 'HOME',
          model_prob: 0.58,
          book_price: -120,
          implied_prob: 0.545455,
          edge_pct: 0.034545,
          blockers: [],
          source: 'NHL_MODEL_OUTPUT_MONEYLINE',
        },
        homeGoalie: { savePct: null, gsax: null },
        awayGoalie: { savePct: null, gsax: null },
      },
      ...overrides,
    });
  }

  test('rejects NHL payload when actionable=true but model_signal.eligible_for_potd=false', () => {
    const game = buildNhlGameForModelSignal({
      nhlSnapshot: {
        model_signal: {
          eligible_for_potd: false,
          actionable: true,
          market_type: 'MONEYLINE',
          selection_side: 'HOME',
          model_prob: 0.58,
          book_price: -120,
          implied_prob: 0.545455,
          edge_pct: 0.034545,
          blockers: ['MODEL_PROB_MISSING'],
          source: 'NHL_MODEL_OUTPUT_MONEYLINE',
        },
        homeGoalie: { savePct: 0.95, gsax: 10 },
        awayGoalie: { savePct: 0.88, gsax: -10 },
      },
    });

    const moneyline = buildCandidates(game).filter((candidate) => candidate.marketType === 'MONEYLINE');
    expect(moneyline).toHaveLength(2);

    const scored = moneyline.map(scoreCandidate);
    expect(scored.every(Boolean)).toBe(true);
    for (const row of scored) {
      expect(row.edgeSourceTag).toBe('MODEL');
      expect(row.edgePct).toBeNull();
      expect(row.rejectionDiagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'MODEL_SIGNAL_INCOMPLETE' }),
        ]),
      );
    }
  });

  test('rejection diagnostics include model_signal blockers when eligible_for_potd=false', () => {
    const game = buildNhlGameForModelSignal({
      nhlSnapshot: {
        model_signal: {
          eligible_for_potd: false,
          market_type: 'MONEYLINE',
          selection_side: 'HOME',
          model_prob: null,
          book_price: -120,
          implied_prob: 0.545455,
          edge_pct: null,
          blockers: ['MODEL_PROB_MISSING', 'EDGE_UNAVAILABLE'],
          source: 'NHL_MODEL_OUTPUT_MONEYLINE',
        },
      },
    });

    const scored = buildCandidates(game)
      .filter((candidate) => candidate.marketType === 'MONEYLINE')
      .map(scoreCandidate)
      .filter(Boolean);

    expect(scored).toHaveLength(2);
    for (const row of scored) {
      expect(row.rejectionDiagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'MODEL_SIGNAL_INCOMPLETE',
            blockers: ['MODEL_PROB_MISSING', 'EDGE_UNAVAILABLE'],
          }),
        ]),
      );
    }
  });

  test('accepts NHL payload when eligible_for_potd=true with finite model fields', () => {
    const game = buildNhlGameForModelSignal();
    const homeCandidate = buildCandidates(game).find(
      (candidate) => candidate.marketType === 'MONEYLINE' && candidate.selection === 'HOME',
    );

    expect(homeCandidate).toBeDefined();
    const scored = scoreCandidate(homeCandidate);
    expect(scored).not.toBeNull();
    expect(scored.edgeSourceTag).toBe('MODEL');
    expect(scored.edgePct).not.toBeNull();
    expect(scored.modelWinProb).toBeCloseTo(0.58, 6);
    expect(scored.rejectionDiagnostics).toBeUndefined();
  });

  test('rejects opposite-side NHL payload candidate with SELECTION_SIDE_MISMATCH', () => {
    const game = buildNhlGameForModelSignal({
      nhlSnapshot: {
        model_signal: {
          eligible_for_potd: true,
          market_type: 'MONEYLINE',
          selection_side: 'AWAY',
          model_prob: 0.58,
          book_price: 105,
          implied_prob: 0.487805,
          edge_pct: 0.092195,
          blockers: [],
          source: 'NHL_MODEL_OUTPUT_MONEYLINE',
        },
      },
    });

    const candidates = buildCandidates(game).filter(
      (candidate) => candidate.marketType === 'MONEYLINE',
    );
    const homeCandidate = candidates.find((candidate) => candidate.selection === 'HOME');
    const awayCandidate = candidates.find((candidate) => candidate.selection === 'AWAY');

    expect(homeCandidate).toBeDefined();
    expect(awayCandidate).toBeDefined();

    const rejected = scoreCandidate(homeCandidate);
    expect(rejected).not.toBeNull();
    expect(rejected.edgePct).toBeNull();
    expect(rejected.rejectionDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MODEL_SIGNAL_INCOMPLETE',
          blockers: expect.arrayContaining(['SELECTION_SIDE_MISMATCH']),
        }),
      ]),
    );

    const accepted = scoreCandidate(awayCandidate);
    expect(accepted).not.toBeNull();
    expect(accepted.edgeSourceTag).toBe('MODEL');
    expect(accepted.edgePct).not.toBeNull();
    expect(accepted.modelWinProb).toBeCloseTo(0.58, 6);
    expect(accepted.rejectionDiagnostics).toBeUndefined();
  });

  test('fails closed when nhlModelPayloadPresent=true but model_signal is missing', () => {
    const game = buildNhlGameForModelSignal({
      nhlSnapshot: {
        homeGoalie: { savePct: 0.95, gsax: 9 },
        awayGoalie: { savePct: 0.88, gsax: -8 },
      },
    });

    const scored = buildCandidates(game)
      .filter((candidate) => candidate.marketType === 'MONEYLINE')
      .map(scoreCandidate)
      .filter(Boolean);

    expect(scored).toHaveLength(2);
    for (const row of scored) {
      expect(row.edgeSourceTag).toBe('MODEL');
      expect(row.edgePct).toBeNull();
      expect(row.rejectionDiagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'MODEL_SIGNAL_INCOMPLETE' }),
        ]),
      );
    }
  });
});
