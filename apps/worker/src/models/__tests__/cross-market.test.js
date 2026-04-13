const {
  computeConflict,
  Market,
  DecisionStatus,
  marginToWinProbability,
} = require('@cheddar-logic/models');
const { getSigmaDefaults } = require('@cheddar-logic/models/src/edge-calculator');
const {
  computeNHLMarketDecisions,
  selectExpressionChoice,
  computeTotalBias,
  goalieUncertaintyBlocks,
  evaluateNHLGameMarkets,
  choosePrimaryDisplayMarket,
} = require('../cross-market');

describe('cross-market orchestration', () => {
  test('computeConflict uses min(support, oppose)', () => {
    const drivers = [
      {
        driverKey: 'a',
        weight: 0.6,
        eligible: true,
        signal: 0.4,
        contrib: 0.24,
        status: 'ok',
      },
      {
        driverKey: 'b',
        weight: 0.2,
        eligible: true,
        signal: -0.3,
        contrib: -0.06,
        status: 'ok',
      },
      {
        driverKey: 'c',
        weight: 0.2,
        eligible: true,
        signal: 0.2,
        contrib: 0.04,
        status: 'ok',
      },
    ];

    expect(computeConflict(drivers)).toBeCloseTo(0.2, 3);
  });

  test('no leakage: pace and pdoRegression have eligible=false in SPREAD/ML (directional only in TOTAL)', () => {
    const oddsSnapshot = {
      total: 6.5,
      spread_home: -1.5,
      h2h_home: -120,
      h2h_away: 110,
      raw_data: {
        espn_metrics: {
          home: {
            metrics: { avgGoalsFor: 3.2, avgGoalsAgainst: 2.7, restDays: 2 },
          },
          away: {
            metrics: { avgGoalsFor: 2.9, avgGoalsAgainst: 3.1, restDays: 1 },
          },
        },
        goalie_home_gsax: 1.2,
        goalie_away_gsax: -0.5,
        empty_net_pull_home_sec: 70,
        empty_net_pull_away_sec: 65,
        pp_home_pct: 23,
        pk_home_pct: 78,
        pp_away_pct: 20,
        pk_away_pct: 80,
        pdo_home: 1.01,
        pdo_away: 0.99,
        xgf_home_pct: 52,
        xgf_away_pct: 48,
        pace: 102,
        recent_trend_home: 60,
        recent_trend_away: 45,
        welcome_home_fade_active: true,
      },
    };

    const decisions = computeNHLMarketDecisions(oddsSnapshot);
    const totalDrivers = decisions.TOTAL.drivers;
    const spreadDrivers = decisions.SPREAD.drivers;
    const mlDrivers = decisions.ML.drivers;

    expect(
      totalDrivers.find((driver) => driver.driverKey === 'rest').eligible,
    ).toBe(true);
    expect(
      spreadDrivers.find((driver) => driver.driverKey === 'pace').eligible,
    ).toBe(false);
    expect(
      spreadDrivers.find((driver) => driver.driverKey === 'pdoRegression')
        .eligible,
    ).toBe(false);
    expect(
      mlDrivers.find((driver) => driver.driverKey === 'pace').eligible,
    ).toBe(false);
    expect(
      mlDrivers.find((driver) => driver.driverKey === 'pdoRegression').eligible,
    ).toBe(false);
  });

  test('selector prefers ML when spread is bad number and scores are tight', () => {
    const decisions = {
      [Market.TOTAL]: {
        market: Market.TOTAL,
        status: DecisionStatus.WATCH,
        score: 0.32,
        risk_flags: [],
        edge: 0.4,
      },
      [Market.SPREAD]: {
        market: Market.SPREAD,
        status: DecisionStatus.WATCH,
        score: 0.4,
        risk_flags: ['BAD_NUMBER'],
        edge: 0.15,
      },
      [Market.ML]: {
        market: Market.ML,
        status: DecisionStatus.WATCH,
        score: 0.39,
        risk_flags: ['COINFLIP_ZONE'],
        edge: 0.02,
      },
    };

    const choice = selectExpressionChoice(decisions);
    expect(choice.chosen_market).toBe(Market.ML);
  });

  test('total bias is OK for WATCH with strong edge even at low coverage', () => {
    const totalDecision = {
      status: DecisionStatus.WATCH,
      edge: 1.8,
      coverage: 0.44,
      best_candidate: { side: 'OVER', line: 6.5 },
      drivers: [],
    };

    expect(computeTotalBias(totalDecision)).toBe('OK');
  });

  test('total bias is INSUFFICIENT_DATA for PASS decisions', () => {
    const totalDecision = {
      status: DecisionStatus.PASS,
      edge: 2.2,
      best_candidate: { side: 'UNDER', line: 6.0 },
    };

    expect(computeTotalBias(totalDecision)).toBe('INSUFFICIENT_DATA');
  });

  test('total bias is INSUFFICIENT_DATA when WATCH lacks edge', () => {
    const totalDecision = {
      status: DecisionStatus.WATCH,
      edge: null,
      best_candidate: { side: 'OVER', line: 220.5 },
    };

    expect(computeTotalBias(totalDecision)).toBe('INSUFFICIENT_DATA');
  });

  test('total bias is OK for FIRE decisions with line and edge', () => {
    const totalDecision = {
      status: DecisionStatus.FIRE,
      edge: 3.1,
      best_candidate: { side: 'UNDER', line: 221.5 },
    };

    expect(computeTotalBias(totalDecision)).toBe('OK');
  });

  test('market decisions expose market-specific probability edge and trace metadata', () => {
    const oddsSnapshot = {
      total: 6.0,
      total_price_over: -110,
      total_price_under: -110,
      spread_home: -1.5,
      spread_price_home: -110,
      spread_price_away: -110,
      h2h_home: -125,
      h2h_away: 105,
      raw_data: {
        espn_metrics: {
          home: {
            metrics: { avgGoalsFor: 3.4, avgGoalsAgainst: 2.8, restDays: 2 },
          },
          away: {
            metrics: { avgGoalsFor: 3.0, avgGoalsAgainst: 3.1, restDays: 1 },
          },
        },
        goalie_home_gsax: 0.8,
        goalie_away_gsax: -0.3,
      },
    };

    const decisions = computeNHLMarketDecisions(oddsSnapshot);
    expect(typeof decisions.TOTAL.edge).toBe('number');
    expect(typeof decisions.TOTAL.p_fair).toBe('number');
    expect(typeof decisions.TOTAL.p_implied).toBe('number');
    expect(typeof decisions.TOTAL.edge_points).toBe('number');
    expect(decisions.TOTAL.projection).toHaveProperty('projected_total');

    expect(typeof decisions.SPREAD.edge).toBe('number');
    expect(typeof decisions.SPREAD.p_fair).toBe('number');
    expect(typeof decisions.SPREAD.p_implied).toBe('number');
    expect(typeof decisions.SPREAD.edge_points).toBe('number');
    expect(decisions.SPREAD.projection).toHaveProperty('projected_margin');

    expect(decisions.ML.best_candidate.side).toMatch(/HOME|AWAY/);
    expect(typeof decisions.ML.best_candidate.price).toBe('number');
    expect(typeof decisions.ML.edge).toBe('number');
    expect(typeof decisions.ML.p_fair).toBe('number');
    expect(typeof decisions.ML.p_implied).toBe('number');
    expect(decisions.ML.projection).toHaveProperty('win_prob_home');

    expect(decisions.TOTAL.pricing_trace.line_source).toBe('odds_snapshot');
    expect(decisions.TOTAL.pricing_trace.price_source).toBe('odds_snapshot');
    expect(decisions.ML.pricing_trace.price_source).toBe('odds_snapshot');
  });

  test('goalie signal can derive from composite save-pct-only inputs', () => {
    const oddsSnapshot = {
      total: 6.0,
      total_price_over: -110,
      total_price_under: -110,
      spread_home: -1.5,
      spread_price_home: -110,
      spread_price_away: -110,
      h2h_home: -125,
      h2h_away: 105,
      raw_data: {
        espn_metrics: {
          home: {
            metrics: {
              avgGoalsFor: 3.4,
              avgGoalsAgainst: 2.8,
              restDays: 2,
              goalieSavePct: 0.912,
            },
          },
          away: {
            metrics: {
              avgGoalsFor: 3.0,
              avgGoalsAgainst: 3.1,
              restDays: 1,
              goalieSavePct: 0.888,
            },
          },
        },
      },
    };

    const decisions = computeNHLMarketDecisions(oddsSnapshot);
    const goalieDriver = decisions.TOTAL.drivers.find(
      (driver) => driver.driverKey === 'goalie_quality',
    );

    expect(goalieDriver.eligible).toBe(true);
    expect(goalieDriver.signal).not.toBe(0);
  });
});

describe('goalieUncertaintyBlocks (WI-0382)', () => {
  test('returns false for null/null inputs', () => {
    expect(goalieUncertaintyBlocks(null, null)).toBe(false);
  });

  test('returns false for undefined/undefined inputs', () => {
    expect(goalieUncertaintyBlocks(undefined, undefined)).toBe(false);
  });

  test('returns false when both goalies are CONFIRMED', () => {
    expect(
      goalieUncertaintyBlocks(
        { starter_state: 'CONFIRMED' },
        { starter_state: 'CONFIRMED' },
      ),
    ).toBe(false);
  });

  test('returns false when both goalies are EXPECTED', () => {
    expect(
      goalieUncertaintyBlocks(
        { starter_state: 'EXPECTED' },
        { starter_state: 'EXPECTED' },
      ),
    ).toBe(false);
  });

  test('returns false for CONFIRMED + EXPECTED mix', () => {
    expect(
      goalieUncertaintyBlocks(
        { starter_state: 'CONFIRMED' },
        { starter_state: 'EXPECTED' },
      ),
    ).toBe(false);
  });

  test('returns true when home goalie is UNKNOWN', () => {
    expect(
      goalieUncertaintyBlocks(
        { starter_state: 'UNKNOWN' },
        { starter_state: 'CONFIRMED' },
      ),
    ).toBe(true);
  });

  test('returns true when away goalie is UNKNOWN', () => {
    expect(
      goalieUncertaintyBlocks(
        { starter_state: 'CONFIRMED' },
        { starter_state: 'UNKNOWN' },
      ),
    ).toBe(true);
  });

  test('returns true when home goalie is CONFLICTING', () => {
    expect(
      goalieUncertaintyBlocks(
        { starter_state: 'CONFLICTING' },
        { starter_state: 'CONFIRMED' },
      ),
    ).toBe(true);
  });

  test('returns true when away goalie is CONFLICTING', () => {
    expect(
      goalieUncertaintyBlocks(
        { starter_state: 'CONFIRMED' },
        { starter_state: 'CONFLICTING' },
      ),
    ).toBe(true);
  });

  test('returns true when both goalies are UNKNOWN', () => {
    expect(
      goalieUncertaintyBlocks(
        { starter_state: 'UNKNOWN' },
        { starter_state: 'UNKNOWN' },
      ),
    ).toBe(true);
  });
});

describe('computeTotalBias with goalie states (WI-0382)', () => {
  const goodTotalDecision = {
    status: DecisionStatus.WATCH,
    edge: 1.8,
    best_candidate: { side: 'OVER', line: 6.5 },
  };

  test('returns INSUFFICIENT_DATA when home goalie is UNKNOWN (overrides driver signal)', () => {
    expect(
      computeTotalBias(goodTotalDecision, { starter_state: 'UNKNOWN' }, null),
    ).toBe('INSUFFICIENT_DATA');
  });

  test('returns INSUFFICIENT_DATA when away goalie is CONFLICTING', () => {
    expect(
      computeTotalBias(
        goodTotalDecision,
        { starter_state: 'CONFIRMED' },
        { starter_state: 'CONFLICTING' },
      ),
    ).toBe('INSUFFICIENT_DATA');
  });

  test('returns INSUFFICIENT_DATA when either goalie is UNKNOWN', () => {
    expect(
      computeTotalBias(
        goodTotalDecision,
        null,
        { starter_state: 'UNKNOWN' },
      ),
    ).toBe('INSUFFICIENT_DATA');
  });

  test('runs normal computation when goalies are EXPECTED', () => {
    expect(
      computeTotalBias(
        goodTotalDecision,
        { starter_state: 'EXPECTED' },
        { starter_state: 'EXPECTED' },
      ),
    ).toBe('OK');
  });

  test('preserves existing behavior for CONFIRMED both sides', () => {
    expect(
      computeTotalBias(
        goodTotalDecision,
        { starter_state: 'CONFIRMED' },
        { starter_state: 'CONFIRMED' },
      ),
    ).toBe('OK');
  });

  test('backward-compatible: no goalie args still works', () => {
    expect(computeTotalBias(goodTotalDecision)).toBe('OK');
  });
});

// ============================================================================
// WI-0538: NHL ML win probability calibration
// Validates that sigma = getSigmaDefaults('NHL').margin (2.0 goals) is used,
// not the NBA-style sigma=12 default. Calibrated against NHL goal-margin
// distributions where sigma~2.0 is the empirical standard deviation.
// ============================================================================

describe('NHL ML win probability calibration (WI-0538)', () => {
  const NHL_SIGMA = getSigmaDefaults('NHL').margin; // 2.0

  test('NHL sigma is 2.0 goals (not NBA-style 12 pts)', () => {
    expect(NHL_SIGMA).toBe(2.0);
  });

  test('even margin -> ~50% win prob', () => {
    const prob = marginToWinProbability(0, NHL_SIGMA);
    expect(prob).toBeCloseTo(0.5, 3);
  });

  test('+1 goal projected margin -> ~0.69 win prob (well above NBA ~0.53)', () => {
    const probNHL = marginToWinProbability(1, NHL_SIGMA);
    const probNBAsigma = marginToWinProbability(1, 12.0);
    // NHL with proper sigma shows meaningful confidence
    expect(probNHL).toBeGreaterThan(0.65);
    expect(probNHL).toBeCloseTo(0.6915, 2);
    // NBA sigma gives near-flat
    expect(probNBAsigma).toBeLessThan(0.54);
  });

  test('+2 goal projected margin -> ~0.84 win prob', () => {
    const prob = marginToWinProbability(2, NHL_SIGMA);
    expect(prob).toBeCloseTo(0.8413, 2);
  });

  test('-1 goal projected margin -> ~0.31 win prob (symmetric)', () => {
    const prob = marginToWinProbability(-1, NHL_SIGMA);
    expect(prob).toBeCloseTo(0.3085, 2);
  });

  test('ML market in computeNHLMarketDecisions uses calibrated win prob (not flat-50)', () => {
    // Home team projects +1.5 goal advantage; ML should reflect meaningful edge
    const oddsSnapshot = {
      total: 6.0,
      spread_home: -1.5,
      h2h_home: -130,
      h2h_away: 110,
      spread_price_home: -115,
      spread_price_away: -105,
      raw_data: {
        espn_metrics: {
          home: { metrics: { avgGoalsFor: 3.5, avgGoalsAgainst: 2.5, restDays: 2 } },
          away: { metrics: { avgGoalsFor: 2.5, avgGoalsAgainst: 3.0, restDays: 1 } },
        },
      },
    };
    const decisions = computeNHLMarketDecisions(oddsSnapshot);
    const mlDecision = decisions.ML;
    // win_prob_home should not be near 0.5 (flat default) when margin is meaningful
    const projectedWinProb = mlDecision?.projection?.win_prob_home;
    if (projectedWinProb !== null && projectedWinProb !== undefined) {
      expect(projectedWinProb).toBeGreaterThan(0.6);
    }
  });
});

describe('evaluateNHLGameMarkets independent evaluation (IME-01-04)', () => {
  function buildDecisions({ totalStatus = 'PASS', spreadStatus = 'PASS', mlStatus = 'PASS' } = {}) {
    return {
      [Market.TOTAL]: { status: totalStatus, best_candidate: { side: 'OVER', line: 6.5 }, edge: 0.03, score: 0.62, p_fair: 0.52, p_implied: 0.49 },
      [Market.SPREAD]: { status: spreadStatus, best_candidate: { side: 'HOME', line: -1.5 }, edge: 0.02, score: 0.58, p_fair: 0.53, p_implied: 0.51 },
      [Market.ML]: { status: mlStatus, best_candidate: { side: 'HOME' }, edge: 0.05, score: 0.70, p_fair: 0.55, p_implied: 0.50 },
    };
  }

  test('ML=FIRE + TOTAL=WATCH → ML in official_plays, TOTAL in leans', () => {
    const marketDecisions = buildDecisions({ totalStatus: 'WATCH', mlStatus: 'FIRE' });
    const gameEval = evaluateNHLGameMarkets({ marketDecisions, game_id: 'TEST-GAME-001' });

    const mlPlay = gameEval.official_plays.find((r) => r.market_type === 'ML');
    const totalLean = gameEval.leans.find((r) => r.market_type === 'TOTAL');

    expect(mlPlay).toBeDefined();
    expect(mlPlay.status).toBe('QUALIFIED_OFFICIAL');
    expect(totalLean).toBeDefined();
    expect(totalLean.status).toBe('QUALIFIED_LEAN');
  });

  test('choosePrimaryDisplayMarket returns ML (higher tier) without removing TOTAL from gameEval', () => {
    const marketDecisions = buildDecisions({ totalStatus: 'WATCH', mlStatus: 'FIRE' });
    const gameEval = evaluateNHLGameMarkets({ marketDecisions, game_id: 'TEST-GAME-002' });

    const primary = choosePrimaryDisplayMarket(gameEval);

    expect(primary).toBeDefined();
    expect(primary.market_type).toBe('ML');
    // gameEval must still contain both
    expect(gameEval.official_plays.length).toBe(1);
    expect(gameEval.leans.length).toBe(1);
  });
});
