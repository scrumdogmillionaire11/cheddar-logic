const { computeConflict, Market, DecisionStatus } = require('@cheddar-logic/models');
const { computeNHLMarketDecisions, selectExpressionChoice } = require('../cross-market');

describe('cross-market orchestration', () => {
  test('computeConflict uses min(support, oppose)', () => {
    const drivers = [
      { driverKey: 'a', weight: 0.6, eligible: true, signal: 0.4, contrib: 0.24, status: 'ok' },
      { driverKey: 'b', weight: 0.2, eligible: true, signal: -0.3, contrib: -0.06, status: 'ok' },
      { driverKey: 'c', weight: 0.2, eligible: true, signal: 0.2, contrib: 0.04, status: 'ok' }
    ];

    expect(computeConflict(drivers)).toBeCloseTo(0.2, 3);
  });

  test('NHL scoping keeps rest in totals and pace/PDO risk-only in sides', () => {
    const oddsSnapshot = {
      total: 6.5,
      spread_home: -1.5,
      h2h_home: -120,
      h2h_away: 110,
      raw_data: {
        espn_metrics: {
          home: { metrics: { avgGoalsFor: 3.2, avgGoalsAgainst: 2.7, restDays: 2 } },
          away: { metrics: { avgGoalsFor: 2.9, avgGoalsAgainst: 3.1, restDays: 1 } }
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
        welcome_home_fade_active: true
      }
    };

    const decisions = computeNHLMarketDecisions(oddsSnapshot);
    const totalDrivers = decisions.TOTAL.drivers;
    const spreadDrivers = decisions.SPREAD.drivers;
    const mlDrivers = decisions.ML.drivers;

    expect(totalDrivers.find((driver) => driver.driverKey === 'rest').eligible).toBe(true);
    expect(spreadDrivers.find((driver) => driver.driverKey === 'pace').eligible).toBe(false);
    expect(spreadDrivers.find((driver) => driver.driverKey === 'pdoRegression').eligible).toBe(false);
    expect(mlDrivers.find((driver) => driver.driverKey === 'pace').eligible).toBe(false);
    expect(mlDrivers.find((driver) => driver.driverKey === 'pdoRegression').eligible).toBe(false);
  });

  test('selector prefers ML when spread is bad number and scores are tight', () => {
    const decisions = {
      [Market.TOTAL]: {
        market: Market.TOTAL,
        status: DecisionStatus.WATCH,
        score: 0.32,
        risk_flags: [],
        edge: 0.4
      },
      [Market.SPREAD]: {
        market: Market.SPREAD,
        status: DecisionStatus.WATCH,
        score: 0.40,
        risk_flags: ['BAD_NUMBER'],
        edge: 0.15
      },
      [Market.ML]: {
        market: Market.ML,
        status: DecisionStatus.WATCH,
        score: 0.39,
        risk_flags: ['COINFLIP_ZONE'],
        edge: 0.02
      }
    };

    const choice = selectExpressionChoice(decisions);
    expect(choice.chosen_market).toBe(Market.ML);
  });
});
